#!/usr/bin/env node
// Quest Board: a zero-dependency local UI over Quest trees (https://github.com/moq-dev/quest)
// in one or more repositories. Reads quest/**/*.md, asks the `quest` CLI for readiness,
// and runs claim/release through the CLI and `gh`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanTree } from './lib/parse.mjs';
import { deriveStatus, readyIndex, waitsOnMaintainer } from './lib/status.mjs';
import { configPath, loadProjects, saveProjects, addProject, expand } from './lib/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = (process.env.HOST || '127.0.0.1').replace(/^\[|\]$/g, '');
const QUEST = process.env.QUEST_BIN || 'quest';
const GH = process.env.GH_BIN || 'gh';

function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT || 4577), paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-p' || a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts.paths.push(a);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('invalid port');
  return opts;
}

const HELP = `Usage: quest-board [--port <n>] [repo ...]

Serve a board of the Quest trees in the listed repositories, and in every
repository already in the project list. Each repo given is added to the list.

Environment:
  PORT                 port to listen on (default 4577)
  HOST                 address to bind (default 127.0.0.1)
  QUEST_BOARD_CONFIG   project list file (default: ${configPath()})
  QUEST_BIN, GH_BIN    paths to the quest and gh commands
`;

const run = (cmd, args, cwd, timeout = 60000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => resolve({
        ok: !err,
        code: err?.code ?? 0,
        missing: err?.code === 'ENOENT',
        stdout: String(stdout),
        stderr: String(stderr || err?.message || ''),
      }));
  });

const tail = (s, n = 6) => s.trim().split('\n').slice(-n).join('\n');

async function projectView(proj) {
  const root = path.resolve(expand(proj.path));
  const quests = scanTree(root);
  const [ready, chk] = await Promise.all([
    run(QUEST, ['unblocked', '--json'], root),
    run(QUEST, ['check'], root),
  ]);
  let readyMap = new Map();
  let readyError = null;
  if (ready.ok) {
    try { readyMap = readyIndex(JSON.parse(ready.stdout)); } catch { readyError = 'quest unblocked printed invalid JSON'; }
  } else readyError = tail(ready.stderr || ready.stdout, 3);
  const out = [];
  for (const q of quests.values()) {
    const status = deriveStatus(q, readyMap);
    out.push({ ...q, status, waitsOnYou: waitsOnMaintainer(q.waiting), dependents: readyMap.get(q.id)?.dependents ?? null });
  }
  return {
    name: proj.name,
    path: proj.path,
    check: { ok: chk.ok, message: tail(chk.stdout + chk.stderr) },
    readyError,
    quests: out,
  };
}

async function claims(proj) {
  const root = path.resolve(expand(proj.path));
  const r = await run(GH, ['pr', 'list', '--state', 'open', '--limit', '500',
    '--json', 'number,headRefName,url,isDraft,title,updatedAt'], root, 30000);
  if (!r.ok) return { error: r.missing ? 'gh is not installed' : tail(r.stderr, 2), prs: [] };
  try { return { prs: JSON.parse(r.stdout) }; } catch { return { error: 'gh printed invalid JSON', prs: [] }; }
}

/** Open a file with the desktop's default app. Resolves once the opener has started (not exited). */
function openFile(file) {
  let cmd, args, opts = { detached: true, stdio: 'ignore' };
  if (process.platform === 'darwin') { cmd = 'open'; args = [file]; }
  else if (process.platform === 'win32') {
    // `start` is a cmd builtin; quote the path ourselves and pass it verbatim.
    if (/["%]/.test(file)) return Promise.resolve({ ok: false, stdout: '', stderr: 'cannot open a path containing " or %' });
    cmd = 'cmd.exe'; args = ['/d', '/s', '/c', `"start "" "${file}""`];
    opts = { ...opts, windowsVerbatimArguments: true, windowsHide: true };
  } else { cmd = 'xdg-open'; args = [file]; }
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, opts); } catch (e) { return resolve({ ok: false, stdout: '', stderr: e.message }); }
    child.once('error', (e) => resolve({ ok: false, stdout: '', stderr: e.code === 'ENOENT' ? `${cmd} is not installed` : e.message }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, stdout: '', stderr: '' }); });
  });
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
};
/** Read a JSON object body; anything else is a 400. */
const readBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { b += c; if (b.length > 1e5) { reject(new HttpError(413, 'request too large')); req.destroy(); } });
  req.on('end', () => {
    let v;
    try { v = b ? JSON.parse(b) : {}; } catch { return reject(new HttpError(400, 'invalid JSON body')); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'body must be a JSON object'));
    resolve(v);
  });
  req.on('error', reject);
});

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const bracket = (h) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

/** Host header values this server answers to when bound on `port`: loopback names and the configured host. */
export function allowedHosts(host, port) {
  const names = ['127.0.0.1', 'localhost', '[::1]', bracket(host)].map((h) => h.toLowerCase());
  const set = new Set(names.map((h) => `${h}:${port}`));
  if (port === 80) for (const h of names) set.add(h); // browsers omit the default port
  return set;
}

export function createServer({ config = configPath(), host = HOST } = {}) {
  const projects = () => loadProjects(config);
  const findProject = (name) => projects().find((p) => p.name === name);

  return http.createServer(async (req, res) => {
    try {
      // Refuse any Host that is not this server's own: a DNS-rebinding page reaches us under its own name.
      const hostHeader = String(req.headers.host || '').toLowerCase();
      if (!allowedHosts(host, req.socket.localPort).has(hostHeader)) return json(res, 403, { error: 'forbidden host' });
      const url = new URL(req.url, 'http://localhost');
      const file = req.method === 'GET' && Object.hasOwn(STATIC, url.pathname) ? STATIC[url.pathname] : null;
      if (file) {
        const headers = { 'content-type': file[1], 'x-content-type-options': 'nosniff' };
        if (file[0] === 'index.html') headers['content-security-policy'] = CSP;
        res.writeHead(200, headers);
        return res.end(fs.readFileSync(path.join(HERE, file[0])));
      }
      if (req.method === 'POST') {
        // Local-only server: reject requests from other sites. Same-origin means Origin names our validated Host.
        const origin = req.headers.origin;
        if (req.headers['x-quest-board'] !== '1' || (origin && origin.toLowerCase() !== `http://${hostHeader}`))
          return json(res, 403, { error: 'forbidden' });
      }

      if (url.pathname === '/api/health' && req.method === 'GET') {
        const [q, g] = await Promise.all([run(QUEST, ['--version'], undefined, 10000), run(GH, ['--version'], undefined, 10000)]);
        return json(res, 200, {
          quest: q.ok ? q.stdout.trim() : null,
          gh: g.ok ? g.stdout.split('\n')[0].trim() : null,
          config,
        });
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, projects());
      if (url.pathname === '/api/projects' && req.method === 'POST') {
        const { name, path: p } = await readBody(req);
        if (typeof p !== 'string' || !p.trim()) return json(res, 400, { error: 'path required' });
        try {
          const list = addProject(projects(), p.trim(), typeof name === 'string' && name.trim() ? name.trim() : undefined);
          saveProjects(config, list);
          return json(res, 200, list);
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (url.pathname === '/api/projects/remove' && req.method === 'POST') {
        const { name } = await readBody(req);
        const list = projects().filter((x) => x.name !== name);
        saveProjects(config, list);
        return json(res, 200, list);
      }

      if (url.pathname === '/api/board' && req.method === 'GET') {
        const views = await Promise.all(projects().map((p) =>
          projectView(p).catch((e) => ({ name: p.name, path: p.path, error: e.message, quests: [] }))));
        return json(res, 200, { projects: views, at: new Date().toISOString() });
      }
      if (url.pathname === '/api/claims' && req.method === 'GET') {
        const proj = findProject(url.searchParams.get('project'));
        if (!proj) return json(res, 404, { error: 'unknown project' });
        return json(res, 200, await claims(proj));
      }

      if (url.pathname === '/api/action' && req.method === 'POST') {
        const { project, quest, action } = await readBody(req);
        const proj = findProject(project);
        if (!proj) return json(res, 404, { error: 'unknown project' });
        const root = path.resolve(expand(proj.path));
        const quests = scanTree(root);
        // Only ever pass a path that names a document in the tree to the CLI.
        if (typeof quest !== 'string' || !quests.has(quest)) return json(res, 400, { error: 'unknown quest' });
        let r;
        if (action === 'blockers') r = await run(QUEST, ['unblocked', quest], root);
        else if (action === 'claim') r = await run(QUEST, ['start', quest], root, 120000);
        else if (action === 'release') r = await run(QUEST, ['start', '--release', quest], root, 120000);
        else if (action === 'open-file') r = await openFile(path.join(root, quest));
        else return json(res, 400, { error: 'unknown action' });
        const output = (r.stdout + r.stderr).trim();
        return json(res, 200, { ok: r.ok, output: output || (action === 'blockers' ? 'No blockers.' : '') });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, e instanceof HttpError ? e.status : 500, { error: String(e.message || e) });
    }
  });
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`quest-board: ${e.message}\n\n${HELP}`); process.exit(2); }
  if (opts.help) { process.stdout.write(HELP); process.exit(0); }
  const config = configPath();
  if (opts.paths.length) {
    let list = loadProjects(config);
    for (const p of opts.paths) {
      try { list = addProject(list, path.resolve(expand(p))); } catch (e) { console.error(`quest-board: ${e.message}`); process.exit(1); }
    }
    saveProjects(config, list);
  }
  const server = createServer({ config, host: HOST });
  server.on('error', (e) => {
    const why = e.code === 'EADDRINUSE' ? `port ${opts.port} is already in use` : e.code === 'EACCES' ? `no permission to listen on port ${opts.port}` : e.message;
    console.error(`quest-board: ${why}`);
    process.exit(1);
  });
  server.listen(opts.port, HOST, () => {
    const { port } = server.address();
    console.log(`Quest Board: http://${bracket(HOST)}:${port}`);
    console.log(`Projects: ${config}`);
  });
}

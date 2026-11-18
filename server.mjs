#!/usr/bin/env node
// Quest Board: a zero-dependency local UI over Quest trees (https://github.com/moq-dev/quest)
// in one or more repositories. Reads quest/**/*.md, asks the `quest` CLI for readiness,
// and runs claim/release through the CLI and `gh`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanTree } from './lib/parse.mjs';
import { configPath, loadProjects, saveProjects, addProject, expand } from './lib/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
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
  const readyMap = new Map();
  let readyError = null;
  if (ready.ok) {
    try { for (const r of JSON.parse(ready.stdout)) readyMap.set(r.path, r); } catch { readyError = 'quest unblocked printed invalid JSON'; }
  } else readyError = tail(ready.stderr || ready.stdout, 3);
  const out = [];
  for (const q of quests.values()) {
    const r = readyMap.get(q.id);
    let status;
    if (q.kind === 'root') status = 'root';
    else if (q.kind === 'milestone' || q.kind === 'epic') status = 'epic';
    else if (r) status = q.waiting.length ? 'needs-you' : 'ready';
    else status = 'blocked';
    out.push({ ...q, status, dependents: r?.dependents ?? null });
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
  const r = await run(GH, ['pr', 'list', '--state', 'open', '--limit', '200',
    '--json', 'number,headRefName,url,isDraft,title,updatedAt'], root, 30000);
  if (!r.ok) return { error: r.missing ? 'gh is not installed' : tail(r.stderr, 2), prs: [] };
  try { return { prs: JSON.parse(r.stdout) }; } catch { return { error: 'gh printed invalid JSON', prs: [] }; }
}

function openFile(file) {
  if (process.platform === 'darwin') return run('open', [file], undefined, 10000);
  if (process.platform === 'win32') return run('explorer.exe', [file], undefined, 10000);
  return run('xdg-open', [file], undefined, 10000);
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { b += c; if (b.length > 1e5) { reject(new Error('request too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('invalid JSON body')); } });
  req.on('error', reject);
});

export function createServer({ config = configPath(), port = 4577 } = {}) {
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://${HOST}:${port}`]);
  const projects = () => loadProjects(config);
  const findProject = (name) => projects().find((p) => p.name === name);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
        });
        return res.end(fs.readFileSync(path.join(HERE, 'index.html')));
      }
      if (req.method === 'POST') {
        // Local-only server: reject requests from other sites.
        const origin = req.headers.origin;
        if (req.headers['x-quest-board'] !== '1' || (origin && !allowed.has(origin)))
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
      json(res, 500, { error: String(e.message || e) });
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
  const server = createServer({ config, port: opts.port });
  server.listen(opts.port, HOST, () => {
    const { port } = server.address();
    console.log(`Quest Board: http://${HOST}:${port}`);
    console.log(`Projects: ${config}`);
  });
}

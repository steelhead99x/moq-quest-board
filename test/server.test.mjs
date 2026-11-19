import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';
import { saveProjects } from '../lib/config.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'basic');
let server, base;

before(async () => {
  const config = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quest-board-')), 'projects.json');
  saveProjects(config, [{ name: 'basic', path: FIXTURE }]);
  server = createServer({ config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** A raw request, so tests can choose the Host and Origin headers fetch would not let them. */
const raw = (method, p, { host, headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const port = server.address().port;
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: host ?? `127.0.0.1:${port}`, ...headers } }, (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (b += c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  req.on('error', reject);
  req.end(body);
});
const port = () => server.address().port;
const POST_HEADERS = { 'x-quest-board': '1', 'content-type': 'application/json' };

const post = (p, body, headers = { 'x-quest-board': '1' }) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('serves the page', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /QUEST BOARD/);
});

test('board lists the fixture tree', async () => {
  const j = await (await fetch(base + '/api/board')).json();
  assert.equal(j.projects.length, 1);
  const ids = j.projects[0].quests.map((q) => q.id);
  assert.ok(ids.includes('quest/m0/download.md'));
  const epic = j.projects[0].quests.find((q) => q.id === 'quest/m0/drain/README.md');
  assert.equal(epic.status, 'epic');
});

test('POST needs the board header', async () => {
  assert.equal((await post('/api/action', {}, {})).status, 403);
});

test('POST from another origin is refused', async () => {
  const r = await post('/api/action', {}, { 'x-quest-board': '1', origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('actions only accept documents in the tree', async () => {
  const r = await post('/api/action', { project: 'basic', quest: '../../etc/passwd', action: 'blockers' });
  assert.equal(r.status, 400);
  const u = await post('/api/action', { project: 'basic', quest: 'quest/m0/export.md', action: 'rm -rf' });
  assert.equal(u.status, 400);
});

test('unknown project is a 404', async () => {
  assert.equal((await post('/api/action', { project: 'nope', quest: 'x', action: 'blockers' })).status, 404);
});

test('serves the script and styles with their own types and a strict policy', async () => {
  const page = await fetch(base + '/');
  const csp = page.headers.get('content-security-policy');
  assert.doesNotMatch(csp.match(/script-src [^;]*/)[0], /unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'; base-uri 'none'; form-action 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const js = await fetch(base + '/app.js');
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
  const css = await fetch(base + '/style.css');
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.equal((await fetch(base + '/server.mjs')).status, 404);
});

test('a Host that is not this server is refused (DNS rebinding)', async () => {
  const evil = await raw('GET', '/api/board', { host: `evil.example:${port()}` });
  assert.equal(evil.status, 403);
  assert.equal((await raw('GET', '/api/board', { host: 'localhost' })).status, 403); // wrong port
  assert.equal((await raw('GET', '/', { host: `rebind.test:${port()}` })).status, 403);
});

test('loopback names on the bound port are accepted, including IPv6 and upper case', async () => {
  for (const h of [`127.0.0.1:${port()}`, `localhost:${port()}`, `LOCALHOST:${port()}`, `[::1]:${port()}`])
    assert.equal((await raw('GET', '/api/projects', { host: h })).status, 200, h);
});

test('POST accepts an Origin that matches the bound address, even with --port 0', async () => {
  for (const h of [`127.0.0.1:${port()}`, `localhost:${port()}`, `[::1]:${port()}`]) {
    const r = await raw('POST', '/api/action', { host: h, headers: { ...POST_HEADERS, origin: `http://${h}` }, body: JSON.stringify({ project: 'nope' }) });
    assert.equal(r.status, 404, h); // past the origin check, stopped by the unknown project
  }
});

test('POST refuses an Origin that differs from the Host', async () => {
  const body = JSON.stringify({});
  for (const origin of ['https://evil.example', `http://localhost:${port() + 1}`, 'null', `http://evil.example:${port()}`]) {
    const r = await raw('POST', '/api/action', { headers: { ...POST_HEADERS, origin }, body });
    assert.equal(r.status, 403, origin);
  }
  const mismatch = await raw('POST', '/api/action', { host: `localhost:${port()}`, headers: { ...POST_HEADERS, origin: `http://127.0.0.1:${port()}` }, body });
  assert.equal(mismatch.status, 403);
});

test('a bad or non-object JSON body is a 400, not a 500', async () => {
  for (const body of ['{', 'null', '[]', '"x"', '3']) {
    const r = await raw('POST', '/api/action', { headers: POST_HEADERS, body });
    assert.equal(r.status, 400, body);
  }
});

test('quests carry derived status and whether they wait on you', async () => {
  const j = await (await fetch(base + '/api/board')).json();
  const dl = j.projects[0].quests.find((x) => x.id === 'quest/m0/download.md');
  assert.equal(dl.waitsOnYou, true);
  assert.ok(['blocked', 'needs-you'].includes(dl.status));
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
  server = createServer({ config, port: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

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

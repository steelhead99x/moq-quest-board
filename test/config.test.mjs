import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, loadProjects, saveProjects, addProject } from '../lib/config.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'basic');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quest-board-'));

test('configPath honours QUEST_BOARD_CONFIG, then XDG_CONFIG_HOME', () => {
  assert.equal(configPath({ QUEST_BOARD_CONFIG: '/x/p.json' }), path.resolve('/x/p.json'));
  assert.equal(configPath({ XDG_CONFIG_HOME: '/cfg' }), path.join('/cfg', 'quest-board', 'projects.json'));
});

test('a missing config is an empty list; a broken one is an error', () => {
  const d = tmp();
  assert.deepEqual(loadProjects(path.join(d, 'none.json')), []);
  fs.writeFileSync(path.join(d, 'bad.json'), '{');
  assert.throws(() => loadProjects(path.join(d, 'bad.json')), /cannot read/);
  fs.writeFileSync(path.join(d, 'obj.json'), '{}');
  assert.throws(() => loadProjects(path.join(d, 'obj.json')), /JSON array/);
});

test('save then load round-trips, creating the folder', () => {
  const f = path.join(tmp(), 'nested', 'projects.json');
  saveProjects(f, [{ name: 'a', path: '/a' }]);
  assert.deepEqual(loadProjects(f), [{ name: 'a', path: '/a' }]);
});

test('addProject names by folder, dedupes by path, and checks for quest/', () => {
  let list = addProject([], FIXTURE);
  assert.deepEqual(list, [{ name: 'basic', path: FIXTURE }]);
  list = addProject(list, FIXTURE, 'renamed');
  assert.deepEqual(list, [{ name: 'renamed', path: FIXTURE }]);
  assert.throws(() => addProject([], tmp()), /no quest\/ directory/);
});

test('addProject keeps names unique', () => {
  const list = addProject([{ name: 'basic', path: '/elsewhere' }], FIXTURE);
  assert.deepEqual(list.map((p) => p.name), ['basic', 'basic-2']);
});

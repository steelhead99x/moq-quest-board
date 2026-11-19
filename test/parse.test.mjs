import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTree, parseQuest, sections, links, waits, items, claimBranch } from '../lib/parse.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'basic');

test('scanTree reads every document with its kind', () => {
  const q = scanTree(ROOT);
  assert.deepEqual([...q.keys()].sort(), [
    'quest/README.md', 'quest/m0/README.md', 'quest/m0/download.md',
    'quest/m0/drain/README.md', 'quest/m0/drain/remove.md', 'quest/m0/export.md',
  ]);
  assert.equal(q.get('quest/README.md').kind, 'root');
  assert.equal(q.get('quest/m0/README.md').kind, 'milestone');
  assert.equal(q.get('quest/m0/drain/README.md').kind, 'epic');
  assert.equal(q.get('quest/m0/drain/remove.md').kind, 'quest');
});

test('titles carry their size label', () => {
  const q = scanTree(ROOT);
  assert.equal(q.get('quest/m0/export.md').size, 'S');
  assert.equal(q.get('quest/m0/export.md').title, 'Add a CSV export endpoint');
  assert.equal(q.get('quest/m0/drain/remove.md').size, 'XS');
});

test('required links resolve both ways', () => {
  const q = scanTree(ROOT);
  assert.deepEqual(q.get('quest/m0/download.md').required, [
    { label: 'CSV endpoint', target: 'quest/m0/export.md', why: 'the button needs something to call' },
  ]);
  assert.deepEqual(q.get('quest/m0/export.md').requiredBy, ['quest/m0/download.md']);
});

test('headings inside code fences are not sections', () => {
  const q = scanTree(ROOT);
  assert.deepEqual(q.get('quest/m0/export.md').required, []);
  assert.match(q.get('quest/m0/export.md').plan, /not a real link/);
});

test('epic membership', () => {
  const q = scanTree(ROOT);
  assert.equal(q.get('quest/m0/drain/remove.md').epic, 'quest/m0/drain/README.md');
  assert.equal(q.get('quest/m0/drain/README.md').epic, null);
  assert.equal(q.get('quest/m0/export.md').epic, null);
  assert.equal(parseQuest('quest/m1/a/b/README.md', '# x').epic, 'quest/m1/a/README.md');
  assert.equal(parseQuest('quest/m1/a/b/c.md', '# x').epic, 'quest/m1/a/b/README.md');
});

test('waiting items name who acts', () => {
  const q = scanTree(ROOT);
  assert.deepEqual(q.get('quest/m0/download.md').waiting, [
    { party: 'Maintainer', text: "pick the button's label" },
    { party: 'acme/ui', text: 'a release with the new icon set' },
  ]);
});

test('scheduled section is kept', () => {
  assert.match(scanTree(ROOT).get('quest/m0/drain/remove.md').scheduled, /2099-01-01/);
});

test('helpers', () => {
  assert.deepEqual(Object.keys(sections('# T\n\n## Goal\nx\n## Plan\ny')), ['Goal', 'Plan']);
  assert.equal(links('- [a](quest/m0/x.md#part)')[0].target, 'quest/m0/x.md');
  assert.deepEqual(links('- [a](https://example.com)'), []);
  assert.deepEqual(waits('- no colon here'), []);
  assert.equal(claimBranch('quest/m0/export.md'), 'quest/m0/export');
  assert.equal(claimBranch('quest/m0/drain/README.md'), 'quest/m0/drain/README');
});

test('a missing tree is an error', () => {
  assert.throws(() => scanTree(path.join(ROOT, 'quest')), /no quest\/ directory/);
});

test('waiting items match `quest waiting`: wrapped lines, linked parties, sub-bullets', () => {
  const block = [
    '- Maintainer: choose how to split it. Options:',
    '  - One crate: simple. Recommended.',
    '  - A crate per trait: more names.',
    '- [acme/lib](https://github.com/acme/lib): ships v2',
    '  and tags it.',
    '- no colon here',
    '- A consumer: asks for it',
  ].join('\n');
  assert.deepEqual(waits(block), [
    { party: 'Maintainer', text: 'choose how to split it. Options: One crate: simple. Recommended. A crate per trait: more names.' },
    { party: 'acme/lib', text: 'ships v2 and tags it.' },
    { party: 'A consumer', text: 'asks for it' },
  ]);
  assert.deepEqual(items('- a\n  b\n- c'), ['a b', 'c']);
});

test('link reasons may wrap onto indented lines', () => {
  assert.deepEqual(links('- [a](/quest/m0/x.md) - first part\n  and the rest'), [
    { label: 'a', target: 'quest/m0/x.md', why: 'first part and the rest' },
  ]);
});

test('code fences close only on a matching fence', () => {
  const text = '# T\n\n## Plan\n````md\n```\n## Goal\n```\n````\n\n## Goal\nreal\n~~~\n## Audit\n~~~\n';
  const s = sections(text);
  assert.match(s.Goal, /^real/);
  assert.equal(s.Audit, undefined);
  assert.match(s.Plan, /## Goal/);
  assert.deepEqual(Object.keys(sections('# T\n## A\n```\n~~~\n## B\n```\n## C')), ['A', 'C']);
});

test('the title is the first heading outside fences; a BOM is ignored', () => {
  assert.equal(parseQuest('quest/m0/a.md', '\uFEFF# [M] With bom').size, 'M');
  const q = parseQuest('quest/m0/a.md', '\n```\n# [L] not me\n```\n# [S] Real title\n\n## Goal\nx');
  assert.equal(q.title, 'Real title');
  assert.equal(q.size, 'S');
  assert.equal(parseQuest('quest/m0/a.md', '# T\n## Goal\nx').goal, 'x');
});

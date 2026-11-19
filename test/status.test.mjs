import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus, readyIndex, isMaintainer, waitsOnMaintainer } from '../lib/status.mjs';

// Canned `quest unblocked --json` output; the CLI need not be installed.
const RANKING = [
  { path: 'quest/m0/plain.md', dependents: 2, hosts: [], arm: null, models: [] },
  { path: 'quest/m0/decide.md', dependents: 1, hosts: [], arm: null, models: [] },
  { path: 'quest/m0/outside.md', dependents: 0, hosts: [], arm: null, models: [] },
  { path: 'quest/m0/mixed.md', dependents: 0, hosts: [], arm: null, models: [] },
  { path: 'quest/m1/done-epic/README.md', dependents: 4, hosts: [], arm: null, models: [] },
];
const ready = readyIndex(RANKING);
const q = (id, kind, waiting = []) => ({ id, kind, waiting });

test('a ranked quest is ready, needs you, or waiting by who acts', () => {
  assert.equal(deriveStatus(q('quest/m0/plain.md', 'quest'), ready), 'ready');
  assert.equal(deriveStatus(q('quest/m0/decide.md', 'quest', [{ party: 'Maintainer', text: 'pick' }]), ready), 'needs-you');
  assert.equal(deriveStatus(q('quest/m0/outside.md', 'quest', [{ party: 'acme/lib', text: 'ships' }]), ready), 'waiting');
  assert.equal(deriveStatus(q('quest/m0/mixed.md', 'quest', [{ party: 'acme/lib', text: 'x' }, { party: 'maintainer', text: 'y' }]), ready), 'needs-you');
});

test('a quest outside the ranking is blocked, whatever it waits on', () => {
  assert.equal(deriveStatus(q('quest/m0/later.md', 'quest'), ready), 'blocked');
  assert.equal(deriveStatus(q('quest/m0/later.md', 'quest', [{ party: 'Maintainer', text: 'x' }]), ready), 'blocked');
});

test('an epic README is ready once the ranking lists it, an epic otherwise', () => {
  assert.equal(deriveStatus(q('quest/m1/done-epic/README.md', 'epic'), ready), 'ready');
  assert.equal(deriveStatus(q('quest/m1/open-epic/README.md', 'epic'), ready), 'epic');
  assert.equal(deriveStatus(q('quest/m1/README.md', 'milestone'), ready), 'epic');
  assert.equal(deriveStatus(q('quest/m1/README.md', 'milestone'), readyIndex([{ path: 'quest/m1/README.md' }])), 'ready');
  assert.equal(deriveStatus(q('quest/README.md', 'root'), ready), 'root');
});

test('only the Maintainer party is "you"', () => {
  assert.ok(isMaintainer('Maintainer') && isMaintainer(' maintainer '));
  assert.ok(!isMaintainer('acme/lib') && !isMaintainer('Maintainers'));
  assert.ok(waitsOnMaintainer([{ party: 'x' }, { party: 'MAINTAINER' }]));
  assert.ok(!waitsOnMaintainer([]));
});

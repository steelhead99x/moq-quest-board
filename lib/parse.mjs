// Parse a Quest tree (https://github.com/moq-dev/quest): quest/**/*.md.
// Pure functions over the filesystem; no CLI calls.
import fs from 'node:fs';
import path from 'node:path';

const SIZE_TITLE = /^#\s+(?:\[(XS|S|M|L|XL)\]\s+)?(.*?)\s*$/;
const LINK_ITEM = /^\[([^\]]*)\]\((\/?quest\/[^)\s]+)\)\s*(?:[-–—:]\s*(.*))?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * Split text into lines tagged with whether they sit inside a code fence.
 * A fence closes only on the same character, at least as long as its opener.
 */
export function fencedLines(text) {
  const out = [];
  let open = null; // { ch, len }
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = FENCE.exec(line);
    if (open) {
      const close = m && m[1][0] === open.ch && m[1].length >= open.len && line.slice(m[0].length).trim() === '';
      out.push({ line, fenced: true });
      if (close) open = null;
    } else if (m) {
      open = { ch: m[1][0], len: m[1].length };
      out.push({ line, fenced: true });
    } else out.push({ line, fenced: false });
  }
  return out;
}

/** The first `# ` heading outside code fences. */
export function titleLine(text) {
  for (const { line, fenced } of fencedLines(text)) if (!fenced && /^#\s/.test(line)) return line;
  return '';
}

/** Split Markdown into `## Heading` sections, ignoring headings inside code fences. */
export function sections(text) {
  const out = {};
  let cur = null;
  for (const { line, fenced } of fencedLines(text)) {
    const m = !fenced && /^##\s+(.+?)\s*$/.exec(line);
    if (m) { cur = m[1]; out[cur] = []; } else if (cur) out[cur].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

/**
 * The top-level list items of a block, each as one string with the marker removed.
 * Indented lines that follow an item continue it (a sub-bullet's marker is dropped);
 * continuation lines are joined with single spaces, as `quest waiting` does.
 */
export function items(block = '') {
  const res = [];
  let base = null;
  for (const line of block.split('\n')) {
    const m = /^(\s*)[-*]\s+(.*)$/.exec(line);
    const indent = m ? m[1].length : line.length - line.trimStart().length;
    if (m && (base === null || indent <= base)) {
      base ??= indent;
      res.push(m[2].trim());
    } else if (res.length && line.trim() && indent > (base ?? 0)) {
      res[res.length - 1] += ' ' + line.trim().replace(/^(?:[-*]|>)\s+/, '');
    }
  }
  return res;
}

/** List items linking into the tree: `- [label](/quest/path.md) - why`. */
export function links(block = '') {
  const res = [];
  for (const item of items(block)) {
    const m = LINK_ITEM.exec(item);
    if (m) res.push({ label: m[1], target: m[2].replace(/^\//, '').split('#')[0], why: (m[3] || '').trim() });
  }
  return res;
}

/** `## Waiting` items: `- Party: condition`, where the party may be a Markdown link. */
export function waits(block = '') {
  const res = [];
  for (const item of items(block)) {
    const text = item.replace(/^\[([^\]]*)\]\([^)\s]*\)/, '$1');
    const m = /^(.+?):(?:\s+(.*))?$/.exec(text);
    if (m && m[1].trim()) res.push({ party: m[1].trim(), text: (m[2] || '').trim() });
  }
  return res;
}

/** Parse one quest document. `id` is its repo-relative path, e.g. `quest/m0/export.md`. */
export function parseQuest(id, text) {
  const t = SIZE_TITLE.exec(titleLine(text)) || [];
  const parts = id.split('/');
  const isReadme = parts[parts.length - 1] === 'README.md';
  let kind = 'quest';
  if (isReadme) kind = parts.length === 2 ? 'root' : parts.length === 3 ? 'milestone' : 'epic';
  // The epic a document belongs to: its folder's README for a quest, the parent folder's for an epic.
  const parentDepth = isReadme ? parts.length - 2 : parts.length - 1;
  const epic = parentDepth > 2 ? parts.slice(0, parentDepth).join('/') + '/README.md' : null;
  const s = sections(text);
  return {
    id,
    title: t[2] || id,
    size: t[1] || null,
    kind,
    milestone: parts.length >= 3 ? parts[1] : null,
    epic,
    goal: s.Goal || '',
    plan: s.Plan || '',
    required: links(s.Required),
    related: links(s.Related),
    waiting: waits(s.Waiting),
    scheduled: s.Scheduled || null,
    hosts: s.Hosts || null,
    audit: s.Audit || null,
  };
}

/** Read every document under `<root>/quest/` and link dependents back to what they require. */
export function scanTree(root) {
  const qdir = path.join(root, 'quest');
  if (!fs.existsSync(qdir)) throw new Error(`no quest/ directory in ${root}`);
  const quests = new Map();
  for (const file of walk(qdir)) {
    const id = path.relative(root, file).split(path.sep).join('/');
    quests.set(id, parseQuest(id, fs.readFileSync(file, 'utf8')));
  }
  for (const q of quests.values()) q.requiredBy = [];
  for (const q of quests.values())
    for (const r of q.required) quests.get(r.target)?.requiredBy.push(q.id);
  return quests;
}

/** The branch that claims a quest: its path without `.md`. */
export const claimBranch = (id) => id.replace(/\.md$/, '');

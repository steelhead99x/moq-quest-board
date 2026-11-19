// Where the project list lives, and reading/writing it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Expand a leading `~`, `~/` or `~\` to the home directory. */
export const expand = (p) => {
  if (p === '~') return os.homedir();
  return p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p;
};
const homeRelative = (p) => p === '~' || p.startsWith('~/') || p.startsWith('~\\');

export function configPath(env = process.env) {
  if (env.QUEST_BOARD_CONFIG) return path.resolve(expand(env.QUEST_BOARD_CONFIG));
  const base = env.XDG_CONFIG_HOME
    || (process.platform === 'win32' ? env.APPDATA : null)
    || path.join(os.homedir(), '.config');
  return path.join(base, 'quest-board', 'projects.json');
}

export function loadProjects(file) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  if (!Array.isArray(list)) throw new Error(`${file} must hold a JSON array of {name, path}`);
  return list.filter((p) => p && typeof p.name === 'string' && typeof p.path === 'string');
}

export function saveProjects(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Add a project, naming it after its folder unless named; replaces one with the same name or path.
 * The stored path is absolute (a `~/` path keeps its `~` form), so it never depends on the
 * server's working directory. Re-adding a listed path keeps its name unless one is passed.
 */
export function addProject(list, p, name) {
  const resolved = path.resolve(expand(p));
  if (!fs.existsSync(path.join(resolved, 'quest'))) throw new Error(`no quest/ directory in ${p}`);
  const same = (x) => path.resolve(expand(x.path)) === resolved;
  const existing = list.find(same);
  let n = (name || existing?.name || path.basename(resolved)).trim();
  const rest = list.filter((x) => !same(x) && (name ? x.name !== n : true));
  if (!name && !existing) { let i = 2; const base = n; while (rest.some((x) => x.name === n)) n = `${base}-${i++}`; }
  return [...rest, { name: n, path: homeRelative(p) ? p : resolved }];
}

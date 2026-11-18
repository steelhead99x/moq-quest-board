// Where the project list lives, and reading/writing it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const expand = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

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

/** Add a project, naming it after its folder unless named; replaces one with the same name or path. */
export function addProject(list, p, name) {
  const resolved = path.resolve(expand(p));
  if (!fs.existsSync(path.join(resolved, 'quest'))) throw new Error(`no quest/ directory in ${p}`);
  let n = (name || path.basename(resolved)).trim();
  const same = (x) => path.resolve(expand(x.path)) === resolved;
  const rest = list.filter((x) => !same(x) && (name ? x.name !== n : true));
  if (!name) { let i = 2; const base = n; while (rest.some((x) => x.name === n)) n = `${base}-${i++}`; }
  return [...rest, { name: n, path: p }];
}

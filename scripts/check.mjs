// Syntax-check every source file with `node --check`. Plain Node so it runs the same on Windows.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const dirs = ['.', 'lib', 'test', 'scripts'];
const files = dirs.flatMap((d) =>
  fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.m?js$/.test(f)).map((f) => `${d}/${f}`) : []);

for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`checked ${files.length} files`);

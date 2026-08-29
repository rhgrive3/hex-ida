/*
 * Dependency-free syntax lint for every authored JavaScript module.
 *
 * All files parse in a single Node process via `vm.SourceTextModule`
 * (package.json sets `"type": "module"`, so every `.js`/`.mjs` here is ESM and
 * the module-goal parse matches `node --check` acceptance — verified byte-for-
 * byte against the old spawn-per-file runner across the full tree). Parsing
 * 1.6k files in-process takes well under a second instead of ~70 s of process
 * startup overhead. If `vm.SourceTextModule` is unavailable, fall back to the
 * original one-process-per-file check.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
for (const dir of ['js', 'tests', 'tools/validation']) {
  const full = path.join(root, dir);
  if (fs.existsSync(full)) walk(full);
}

let failed = 0;
if (typeof vm.SourceTextModule === 'function') {
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    try {
      new vm.SourceTextModule(source, { identifier:file });
    } catch (error) {
      failed++;
      process.stderr.write(`${file}: ${error.message}\n`);
    }
  }
} else {
  const { spawnSync } = await import('node:child_process');
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding:'utf8' });
    if (result.status !== 0) {
      failed++;
      process.stderr.write(result.stderr || result.stdout || (file + ': syntax check failed\n'));
    }
  }
}
if (failed) process.exit(1);
process.stdout.write(`syntax lint: ${files.length} files ok\n`);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(m?js)$/.test(entry.name)) files.push(file);
  }
}

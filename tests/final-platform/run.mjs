import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(ROOT)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
if (tests.length === 0) throw new Error('final-platform: no contract tests discovered');
for (const name of tests) await import(pathToFileURL(path.join(ROOT, name)).href);
console.log(`final-platform: PASS (${tests.length}/${tests.length} discovered test files)`);

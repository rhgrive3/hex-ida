import assert from 'node:assert/strict';
import { parseImportScriptsArguments } from '../scripts/userscript-classic-imports.mjs';

assert.deepEqual(parseImportScriptsArguments("'./a.js'", 'single'), ['./a.js']);
assert.deepEqual(parseImportScriptsArguments(" './a.js', \"./b.js\", ", 'multiple'), ['./a.js', './b.js']);
assert.deepEqual(parseImportScriptsArguments('', 'empty'), []);

for (const args of [
  'dependency',
  "'./a.js', dependency",
  "'./a.js' + suffix",
  "resolve('./a.js')",
  '`./a.js`',
  "'./a.js', /* hidden */ './b.js'",
]) {
  assert.throws(
    () => parseImportScriptsArguments(args, 'dynamic-worker.js'),
    /Unsupported importScripts\(\).*only plain string-literal arguments are supported/,
    `must fail closed for ${args}`,
  );
}

// Keep the parser regression on a maintainer-owned head after generated synchronization.
console.log('userscript importScripts literal guard: PASS');

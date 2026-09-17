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

// #9158: Semicolonless importScripts() must not bypass dependency collection or protected inlining
import { parseImports, inlineImports } from '../scripts/build-userscript.mjs';

assert.deepEqual(
  parseImports("importScripts('./a.js');\nimportScripts('./b.js')\nimportScripts(\n  './c.js'\n)", 'worker.js'),
  ['a.js', 'b.js', 'c.js'],
  'parseImports must collect dependencies from both semicolon and semicolonless importScripts',
);

const mockSources = new Map([
  ['worker.js', "const header = 1;\nimportScripts('./dep.js')\nconsole.log(header);"],
  ['dep.js', 'const inlined = 42;'],
]);
const inlinedResult = inlineImports('worker.js', mockSources);
assert.equal(
  inlinedResult,
  'const header = 1;\nconst inlined = 42;\nconsole.log(header);',
  'inlineImports must replace semicolonless importScripts with inlined source',
);

// Keep the parser regression on a maintainer-owned head after generated synchronization.
console.log('userscript importScripts literal guard: PASS');

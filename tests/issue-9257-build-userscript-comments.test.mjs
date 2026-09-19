import assert from 'node:assert/strict';
import { parseImports, inlineImports } from '../scripts/build-userscript.mjs';

const from = 'js/worker.js';

// 1. Line comment
assert.deepEqual(
  parseImports("// importScripts('./ghost.js')\nself.postMessage('ok');", from),
  [],
);

// 2. Block comment
assert.deepEqual(
  parseImports("/* importScripts('./ghost.js') */\nself.postMessage('ok');", from),
  [],
);

// 3. String literal
assert.deepEqual(
  parseImports("const example = \"importScripts('./ghost.js')\";", from),
  [],
);

// 4. Template literal
assert.deepEqual(
  parseImports("const example = `importScripts('./ghost.js')`;", from),
  [],
);

// 5. Real importScripts call
assert.deepEqual(
  parseImports("importScripts('./dep.js');\nself.postMessage('ok');", from),
  ['js/dep.js'],
);

// 6. inlineImports ignores comments
const sources = new Map([
  ['js/worker.js', "// importScripts('./ghost.js')\nimportScripts('./dep.js');"],
  ['js/dep.js', "console.log('dep loaded');"],
]);
const inlined = inlineImports('js/worker.js', sources);
assert.ok(inlined.includes("// importScripts('./ghost.js')"));
assert.ok(inlined.includes("console.log('dep loaded');"));

console.log('issue-9257-build-userscript-comments: PASS');

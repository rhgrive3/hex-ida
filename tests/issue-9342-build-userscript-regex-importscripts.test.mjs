import assert from 'node:assert/strict';
import test from 'node:test';

import { inlineImports, parseImports } from '../scripts/build-userscript.mjs';

const from = 'js/worker.js';

test('#9342 importScripts text inside regex literals is not a dependency edge', () => {
  for (const source of [
    'const r = /importScripts("ghost.js")/;',
    'const r = /https?:\\/\\/example\\.com\\/importScripts\\("ghost.js"\\)/g;',
    'const r = /[a-z]+importScripts\\("ghost.js"\\)/i;',
    'function f(){ return /importScripts("ghost.js")/; }',
  ]) {
    assert.deepEqual(parseImports(source, from), [], source);
  }
});

test('#9342 inlineImports preserves regex text without requiring a ghost source', () => {
  const source = 'const matcher = /importScripts("ghost.js")/;\nself.matcher = matcher;';
  const sources = new Map([[from, source]]);
  assert.equal(inlineImports(from, sources), source);
});

test('#9342 a real importScripts call adjacent to a regex literal is still collected and inlined', () => {
  const source = 'const matcher = /importScripts("ghost.js")/;\nimportScripts("./dep.js");';
  assert.deepEqual(parseImports(source, from), ['js/dep.js']);
  const sources = new Map([
    [from, source],
    ['js/dep.js', 'globalThis.depLoaded = true;'],
  ]);
  const output = inlineImports(from, sources);
  assert.match(output, /const matcher = \/importScripts\("ghost\.js"\)\//);
  assert.doesNotMatch(output, /importScripts\("\.\/dep\.js"\)/);
  assert.match(output, /depLoaded/);
});

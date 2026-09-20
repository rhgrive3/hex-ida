import assert from 'node:assert/strict';
import test from 'node:test';

import { inlineImports, parseImports } from '../scripts/build-userscript.mjs';

const from = 'js/worker.js';

test('#9308 executable template interpolation importScripts is discovered', () => {
  const source = "const value = \`${importScripts('./dep.js')}\`;";
  assert.deepEqual(parseImports(source, from), ['js/dep.js']);
});

test('#9308 inlining keeps template interpolation syntactically executable and synchronous', () => {
  const source = "const value = \`${importScripts('./dep.js')}\`; globalThis.__hex9308Value = value;";
  const sources = new Map([
    [from, source],
    ['js/dep.js', 'globalThis.__hex9308Loaded = (globalThis.__hex9308Loaded || 0) + 1;'],
  ]);
  const output = inlineImports(from, sources);
  assert.doesNotMatch(output, /importScripts\s*\(/);
  assert.match(output, /__hex9308Loaded/);
  delete globalThis.__hex9308Loaded;
  delete globalThis.__hex9308Value;
  Function(output)();
  assert.equal(globalThis.__hex9308Loaded, 1);
  assert.equal(globalThis.__hex9308Value, 'undefined');
  delete globalThis.__hex9308Loaded;
  delete globalThis.__hex9308Value;
});

test('#9308 nested template interpolations scan executable code but keep template text inert', () => {
  const live = "const x = \`${true && \`${importScripts('./dep.js')}\`}\`;";
  assert.deepEqual(parseImports(live, from), ['js/dep.js']);
  assert.deepEqual(parseImports("const x = \`importScripts('./ghost.js')\`;", from), []);
  assert.deepEqual(parseImports("const x = \`${helper.importScripts('./ghost.js')}\`;", from), []);
});

test('#9308 malformed interpolation fails closed instead of silently omitting a live dependency', () => {
  assert.throws(
    () => parseImports("const x = \`${importScripts('./dep.js');", from),
    /Unterminated template interpolation/,
  );
});

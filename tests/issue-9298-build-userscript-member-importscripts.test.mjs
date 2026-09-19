import assert from 'node:assert/strict';
import test from 'node:test';

import { inlineImports, parseImports } from '../scripts/build-userscript.mjs';

const from = 'js/worker.js';

test('#9298 member importScripts calls are ordinary JavaScript, not dependency edges', () => {
  for (const source of [
    "helper.importScripts('./ghost.js');",
    "helper . importScripts('./ghost.js');",
    "helper./* keep */importScripts('./ghost.js');",
    "helper?.importScripts('./ghost.js');",
    "self.importScripts('./ghost.js');",
    "globalThis.importScripts('./ghost.js');",
  ]) {
    assert.deepEqual(parseImports(source, from), [], source);
  }
});

test('#9298 inlineImports preserves member calls and still owns bare global calls', () => {
  const memberSource = "helper.importScripts('./dep.js');\npostMessage('ok');";
  const memberSources = new Map([
    [from, memberSource],
    ['js/dep.js', 'globalThis.dep = 1;'],
  ]);
  assert.equal(inlineImports(from, memberSources), memberSource);

  const bareSources = new Map([
    [from, "importScripts('./dep.js');\npostMessage('ok');"],
    ['js/dep.js', 'globalThis.dep = 1;'],
  ]);
  assert.equal(inlineImports(from, bareSources), "globalThis.dep = 1;\npostMessage('ok');");
});

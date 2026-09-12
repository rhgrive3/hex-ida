import assert from 'node:assert/strict';

import {
  loadManifest,
  validateAggregateFiles,
  validateFiles,
} from '../../../tools/validation/phase12/ownership.mjs';

const manifest = loadManifest();
const producer = [
  'js/ai/prompts/core.js',
  'js/ai/provider/chatgpt-web.js',
  'js/ai/provider/worker-protocol.js',
  'js/ai/runtime.js',
  'js/ai/schema.js',
];
assert.equal(validateFiles(producer, 'p12-integration', manifest).ok, true,
  'the actual proposal producer inventory must belong to the integration lane');
assert.equal(validateAggregateFiles(producer, manifest).ok, true,
  'aggregate ownership must admit the proposal producer inventory');

const adjacent = ['js/ai/prompts/task.js', 'js/ai/provider/index.js'];
for (const result of [
  validateFiles(adjacent, 'p12-integration', manifest),
  validateAggregateFiles(adjacent, manifest),
]) {
  assert.equal(result.ok, false, 'exact producer ownership must not grant adjacent AI paths');
  assert.deepEqual(result.violations.map(({ file, category }) => ({ file, category })),
    adjacent.map((file) => ({ file, category: 'unowned' })));
}

console.log('phase12 AI proposal producer ownership regression: PASS');

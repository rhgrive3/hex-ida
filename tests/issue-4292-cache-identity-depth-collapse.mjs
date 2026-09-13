// Regression for #4292: deterministic cache/cursor identity must not lose
// semantic differences below a serialization depth cut. Two accepted slice
// seeds that differ only at depth 9+ must never share an ObservationStore
// cache key, while identical arguments keep hitting the same entry.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shortHash, stableSerialize } from '../js/ai/tools/paging/cursor.js';
import { ObservationStore } from '../js/ai/tools/storage/observation-store.js';

// nine {a:{...}} wrappers put the leaf past the historical depth-8 collapse.
const wrap = (leaf, layers = 9) => {
  let value = leaf;
  for (let index = 0; index < layers; index++) value = { a: value };
  return value;
};
const deep = (leaf) => ({ a: wrap({ value: leaf }) });
const context = { binaryIdentity: 'bin-4292', analysisRevision: 'rev-4292' };
const store = () => new ObservationStore({ context });
const SLICING_TOOLS = ['slice_backward', 'slice_forward', 'trace_value'];

test('#4292 seeds differing only below the old depth cut get distinct identity', () => {
  const left = { functionAddress: '0x1000', seed: deep('x0'), limit: 20 };
  const right = { functionAddress: '0x1000', seed: deep('x1'), limit: 20 };
  assert.notEqual(stableSerialize(left), stableSerialize(right), 'serializer must not collapse deep values');
  assert.notEqual(shortHash(stableSerialize(left)), shortHash(stableSerialize(right)));
  for (const tool of SLICING_TOOLS) {
    assert.notEqual(store().cacheKey(tool, left), store().cacheKey(tool, right), `${tool} cache keys must differ`);
  }
});

test('#4292 a deep-seed observation is never reused for a different deep seed', () => {
  for (const tool of SLICING_TOOLS) {
    const s = store();
    const left = { functionAddress: '0x1000', seed: deep('x0'), limit: 20 };
    const right = { functionAddress: '0x1000', seed: deep('x1'), limit: 20 };
    const record = s.put({ tool, arguments: left, fullResult: { slice: 'from-x0' } });
    assert.equal(s.getCached(tool, right), null, `${tool} must not serve the x0 slice for the x1 seed`);
    assert.equal(s.getCached(tool, left)?.id, record.id, `${tool} must still reuse identical arguments`);
  }
});

test('#4292 deep arrays and mixed deep shapes stay distinct', () => {
  const a = { seed: wrap([0, [1, 2]]) };
  const b = { seed: wrap([0, [1, 3]]) };
  assert.notEqual(stableSerialize(a), stableSerialize(b));
  assert.notEqual(store().cacheKey('slice_backward', a), store().cacheKey('slice_backward', b));
});

test('#4292 canonical identity keeps existing normal behaviour', () => {
  const s = store();
  const args = { functionAddress: '0x2000', seed: { instructionId: 'i-1' }, limit: 40 };
  const key = s.cacheKey('slice_backward', args);
  assert.equal(s.cacheKey('slice_backward', { limit: 40, seed: { instructionId: 'i-1' }, functionAddress: '0x2000' }), key,
    'key order must remain irrelevant');
  const record = s.put({ tool: 'slice_backward', arguments: args, fullResult: { slice: 'ok' } });
  assert.equal(s.getCached('slice_backward', args)?.id, record.id);
  assert.equal(stableSerialize(9n), '"0x9"');
  assert.equal(shortHash(''), shortHash(''), 'plain string digests stay stable');
  assert.notEqual(s.cacheKey('slice_backward', { x: 1 }), s.cacheKey('slice_forward', { x: 1 }));
});

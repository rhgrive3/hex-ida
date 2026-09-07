import assert from 'node:assert/strict';
import { createSliceId } from '../js/core/identity/index.js';

const base = { binaryId: 'bin_demo' };

const bigintRange = createSliceId({
  ...base,
  sourceRange: { start: 1n, end: 2n },
});
const stringRange = createSliceId({
  ...base,
  sourceRange: { start: '1', end: '2' },
});

assert.notEqual(
  bigintRange,
  stringRange,
  'BigInt and string source ranges must not alias to the same SliceId',
);
assert.equal(
  bigintRange,
  createSliceId({ ...base, sourceRange: { start: 1n, end: 2n } }),
  'identical BigInt source ranges must remain deterministic',
);

// Compatibility boundary: ordinary JSON-safe sourceRange material keeps the
// exact ID produced by the parent core-identity campaign. Only values whose
// jsonSafe representation loses type information gain a type witness.
assert.equal(
  createSliceId({ ...base, sourceRange: { start: 1, end: 2 } }),
  'slice_5ed34601b1b8c605e7cb11c06dfd8d3e',
  'ordinary JSON-safe source ranges must keep their existing persisted ID',
);

assert.notEqual(
  createSliceId({ ...base, sourceRange: new Uint8Array([1, 2]) }),
  createSliceId({ ...base, sourceRange: [1, 2] }),
  'typed bytes must not alias the same JSON-safe array',
);

assert.throws(
  () => createSliceId({ ...base, sourceRange: { start: Number.POSITIVE_INFINITY, end: 2 } }),
  /identity-non-finite-number/,
  'non-finite sourceRange numbers must remain fail-closed',
);
assert.throws(
  () => createSliceId({ ...base, sourceRange: { start: Number.MAX_SAFE_INTEGER + 1, end: 2 } }),
  /identity-unsafe-number/,
  'unsafe integer sourceRange numbers must remain fail-closed',
);

console.log('issue #3786 slice sourceRange type-witness regression PASS');

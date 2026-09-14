import assert from 'node:assert/strict';
import { callArgumentIndices } from '../js/decompiler/call-prototypes.js';

for (const [arity, expected] of [
  [0, []],
  [3, [0, 1, 2]],
  [8, [0, 1, 2, 3, 4, 5, 6, 7]],
]) assert.deepEqual(callArgumentIndices({ override: { arity } }), expected);

for (const arity of [-1, 9, 1.5, NaN, Infinity, '3', true, [3], { valueOf() { return 3; } }]) {
  assert.equal(callArgumentIndices({ override: { arity } }), null, `malformed arity must not become exact: ${String(arity)}`);
}

assert.deepEqual(
  callArgumentIndices({ override: { arity: '3' }, modelCall: { api: { args: [{}, {}] } } }),
  [0, 1],
  'malformed recovered arity must fall through to existing fixed API evidence',
);
assert.deepEqual(callArgumentIndices({ override: { arity: [3] }, name: 'memcpy' }), [0, 1, 2]);
assert.deepEqual(callArgumentIndices({ name: 'malloc' }), [0]);

console.log('issue-3811 regression: PASS');

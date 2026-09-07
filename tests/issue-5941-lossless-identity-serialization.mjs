// Regression for #5941: stableSerialize() collapsed everything past depth 8
// into one "[depth]" sentinel, so two tool arguments differing only below
// depth 8 shared an ObservationStore cache key (a second query could be served
// the first query's cached fullResult) and a cursor's paramsHash could bind to
// the wrong query. The identity serialization is now lossless; pathologically
// deep inputs are rejected explicitly instead of silently aliased.
import assert from 'node:assert/strict';
import { stableSerialize, shortHash } from '../js/ai/tools/paging/cursor.js';

function deepField(depth) {
  let value = { value: depth };
  for (let i = 0; i < depth; i++) value = { a: value };
  return value;
}
function argsFor(depth) {
  return { functionAddress: '0x1000', field: deepField(depth) };
}

// 1: values within the old depth bound keep identical identities.
assert.equal(stableSerialize(argsFor(6)), stableSerialize(argsFor(6)));
assert.equal(stableSerialize({ field: { a: 1, b: 2 } }), stableSerialize({ field: { b: 2, a: 1 } }),
  'key order stays irrelevant');

// 2: differences only below depth 8 must now change the identity.
assert.notEqual(stableSerialize(argsFor(9)), stableSerialize(argsFor(10)),
  'depth-9 vs depth-10 arguments must not collapse into one identity');
assert.notEqual(shortHash(argsFor(9)), shortHash(argsFor(10)));
assert.notEqual(shortHash(argsFor(10)), shortHash(argsFor(11)));

// 3: bigint canonicalization is preserved.
assert.equal(stableSerialize({ addr: 0x1000n }), stableSerialize({ addr: 0x1000n }));
assert.notEqual(stableSerialize({ addr: 0x1000n }), stableSerialize({ addr: 0x1001n }));

// 4: a pathologically deep structure is rejected explicitly, not aliased.
let deep = null;
for (let i = 0; i < 80; i++) deep = { a: deep };
assert.throws(() => stableSerialize(deep), /depth/, 'over-deep input must be rejected, not silently collapsed');

import assert from 'node:assert/strict';
import { createRebuildPlan } from '../js/rebuild/index.js';
import { createRebuildTransaction } from '../js/rebuild/transaction-v2.js';
import { stableDigest } from '../js/core/identity/index.js';

function legacyPlan(operations) {
  return createRebuildPlan({ binaryId: 'bin', sourceHash: 'bytes:dummy', loaderVersion: 'test', operations });
}

const source = Uint8Array.from([0, 255]);
function v2Transaction(operations) {
  return createRebuildTransaction({
    binaryId: 'binary:macho:4980',
    sourceHash: `bytes:${stableDigest(Array.from(source))}`,
    format: 'macho',
    architecture: 'arm64',
    loaderVersion: 'loader:macho:test',
    operations,
  });
}

for (const [before, after] of [[[0], [0]], [[255], [255]], [[0, 255], [255, 0]], [[128], [0]]]) {
  const plan = legacyPlan([{ id: 'op', offset: 0, before, after }]);
  assert.deepEqual(plan.operations[0].before, before);
  assert.deepEqual(plan.operations[0].after, after);
}

const invalidBytes = [[256], [-1], [1.5], [NaN], [Infinity], [-Infinity], ['1'], [0, 256], [256, 0], [257]];
for (const invalid of invalidBytes) {
  const zeros = invalid.map(() => 0);
  assert.throws(
    () => legacyPlan([{ id: 'op', offset: 0, before: invalid, after: zeros }]),
    (error) => error instanceof TypeError && error.message === 'rebuild-byte-invalid',
    `legacy createRebuildPlan accepted invalid before byte ${JSON.stringify(invalid)}`,
  );
  assert.throws(
    () => legacyPlan([{ id: 'op', offset: 0, before: zeros, after: invalid }]),
    (error) => error instanceof TypeError && error.message === 'rebuild-byte-invalid',
    `legacy createRebuildPlan accepted invalid after byte ${JSON.stringify(invalid)}`,
  );
}

assert.throws(
  () => legacyPlan([{ id: 'op', offset: 0, before: [256], after: [257] }]),
  (error) => error instanceof TypeError && error.message === 'rebuild-byte-invalid',
);

let planIdentityLeaked = false;
try {
  const plan = legacyPlan([{ id: 'op', offset: 0, before: [256], after: [256] }]);
  planIdentityLeaked = typeof plan?.planId === 'string';
} catch (error) {
  assert.ok(error instanceof TypeError);
}
assert.equal(planIdentityLeaked, false);

const arrayBuffer = new ArrayBuffer(2);
new Uint8Array(arrayBuffer).set([3, 4]);
const dataView = new DataView(arrayBuffer);
for (const [before, after] of [
  [new Uint8Array([255]), new Uint8Array([0])],
  [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
  [arrayBuffer, new Uint8Array([5, 6])],
  [dataView, new Uint8Array([7, 8])],
]) {
  const plan = legacyPlan([{ id: 'op', offset: 0, before, after }]);
  assert.equal(plan.operations[0].before.length, after.length);
  assert.equal(plan.operations[0].after.length, after.length);
}
assert.throws(
  () => legacyPlan([{ id: 'op', offset: 0, before: 'ff', after: new Uint8Array([0]) }]),
  (error) => error instanceof TypeError && error.message === 'rebuild-bytes-required',
);

for (const invalid of invalidBytes) {
  const zeros = invalid.map(() => 0);
  assert.throws(
    () => v2Transaction([{ id: 'op', offset: 0, before: invalid, after: zeros }]),
    (error) => error instanceof TypeError && error.message === 'rebuild-v2-byte-invalid',
    `v2 createRebuildTransaction accepted invalid before byte ${JSON.stringify(invalid)}`,
  );
}
for (const valid of [[[0], [0]], [[255], [255]]]) {
  const legacy = legacyPlan([{ id: 'op', offset: 0, before: valid[0], after: valid[1] }]);
  const v2 = v2Transaction([{ id: 'op', offset: 0, before: valid[0], after: valid[1] }]);
  assert.deepEqual(legacy.operations[0].before, v2.operations[0].before);
  assert.deepEqual(legacy.operations[0].after, v2.operations[0].after);
}

console.log('issue-4980 legacy rebuild plan array byte validation: PASS');

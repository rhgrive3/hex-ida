import assert from 'node:assert/strict';
import { createRebuildPlan, materializeRebuildPlan, validateRebuildOutput } from '../js/rebuild/index.js';
import { stableDigest } from '../js/core/identity/index.js';

const source = Uint8Array.from([1, 2, 3, 4, 5]);
const sourceHash = `bytes:${stableDigest(Array.from(source))}`;
const valid = () => ({
  binaryId: 'hex-binary:issue-4756',
  sourceHash,
  loaderVersion: 'loader-1',
  operations: [{ id: 'patch-1', offset: 1n, before: [2], after: [9] }],
});

const canonicalPlan = createRebuildPlan(valid());
assert.equal(canonicalPlan.binaryId, 'hex-binary:issue-4756');
assert.equal(canonicalPlan.sourceHash, sourceHash);
assert.equal(canonicalPlan.loaderVersion, 'loader-1');
assert.equal(canonicalPlan.operations[0].id, 'patch-1');
assert.equal(canonicalPlan.planId, 'rebuild-plan:a27152108de9c8c69754a05c73eaba9f');

const structured = [['coerced-array'], [{ nested: 'coerced-object' }], { toString: () => 'coerced-tostring' }];

for (const value of [...structured, 42, true]) {
  assert.throws(
    () => createRebuildPlan({ ...valid(), binaryId: value }),
    /rebuild-binary-id-required/,
    'structured/typed binaryId must not be promoted to a canonical identity',
  );
  assert.throws(
    () => createRebuildPlan({ ...valid(), sourceHash: value }),
    /rebuild-source-hash-required/,
    'structured/typed sourceHash must not be promoted to a source precondition',
  );
  assert.throws(
    () => createRebuildPlan({ ...valid(), loaderVersion: value }),
    /rebuild-loader-version-required/,
    'structured/typed loaderVersion must not be promoted to a canonical identity',
  );
}

for (const value of structured) {
  assert.throws(
    () => createRebuildPlan({ ...valid(), operations: [{ id: value, offset: 1n, before: [2], after: [9] }] }),
    /rebuild-operation-id-invalid/,
    'structured explicit operation id must not alias an existing operation id',
  );
}
assert.throws(
  () => createRebuildPlan({ ...valid(), operations: [{ id: 42, offset: 1n, before: [2], after: [9] }] }),
  /rebuild-operation-id-invalid/,
);
assert.throws(
  () => createRebuildPlan({ ...valid(), operations: [{ id: '', offset: 1n, before: [2], after: [9] }] }),
  /rebuild-operation-id-invalid/,
);
assert.throws(
  () => createRebuildPlan({ ...valid(), operations: [{ id: '   ', offset: 1n, before: [2], after: [9] }] }),
  /rebuild-operation-id-invalid/,
);
const fallbackDigest = (offset, before, after) => `operation:${stableDigest({ offset, before, after })}`;
const expectedFallback = fallbackDigest('1', [2], [9]);
for (const omitted of [undefined, null]) {
  const plan = createRebuildPlan({ ...valid(), operations: [{ id: omitted, offset: 1n, before: [2], after: [9] }] });
  assert.equal(plan.operations[0].id, expectedFallback, 'omitted operation id keeps its deterministic fallback');
}
assert.equal(
  createRebuildPlan({ ...valid(), operations: [{ offset: 1n, before: [2], after: [9] }] }).operations[0].id,
  expectedFallback,
);

const materialized = await materializeRebuildPlan(canonicalPlan, source);
assert.equal(materialized.status, 'materialized');
assert.deepEqual([...materialized.bytes], [1, 9, 3, 4, 5]);
assert.equal((await materializeRebuildPlan(canonicalPlan, Uint8Array.from([1, 2, 3, 4, 0]))).reason, 'source-identity-mismatch');
const validation = await validateRebuildOutput(canonicalPlan, materialized, {
  original: source,
  loaderReparse: (bytes) => ({ ok: bytes[1] === 9 }),
  validators: { evidence: () => ({ ok: true }) },
});
assert.equal(validation.status, 'valid');
assert.equal(validation.planId, canonicalPlan.planId);

console.log('issue-4756 rebuild plan identity string coercion: PASS');

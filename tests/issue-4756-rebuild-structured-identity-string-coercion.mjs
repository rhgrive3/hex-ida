import assert from 'node:assert/strict';
import { createRebuildPlan, materializeRebuildPlan, validateRebuildOutput } from '../js/rebuild/index.js';
import { stableDigest } from '../js/core/identity/index.js';

const source = Uint8Array.from([1, 2, 3, 4, 5]);
const sourceHash = `bytes:${stableDigest(Array.from(source))}`;

function isTypeError(code) {
  return (error) => error instanceof TypeError && error.message === code;
}

const structuredValues = [
  ['patch-1'],
  { toString: () => 'patch-1' },
  5,
  true,
];

for (const value of structuredValues) {
  assert.throws(
    () => createRebuildPlan({ binaryId: value, sourceHash, loaderVersion: 'loader-1', operations: [] }),
    isTypeError('rebuild-binary-id-required'),
    `structured/number/boolean binaryId must not be laundered into a plan identity`,
  );
  assert.throws(
    () => createRebuildPlan({ binaryId: 'binary-A', sourceHash: value, loaderVersion: 'loader-1', operations: [] }),
    isTypeError('rebuild-source-hash-required'),
    `structured/number/boolean sourceHash must not be laundered into a precondition identity`,
  );
  assert.throws(
    () => createRebuildPlan({ binaryId: 'binary-A', sourceHash, loaderVersion: value, operations: [] }),
    isTypeError('rebuild-loader-version-required'),
    `structured/number/boolean loaderVersion must not be laundered into a plan identity`,
  );
}

for (const value of structuredValues) {
  assert.throws(
    () => createRebuildPlan({ binaryId: 'binary-A', sourceHash, loaderVersion: 'loader-1', operations: [{ id: value, offset: 0n, before: [1], after: [2] }] }),
    isTypeError('rebuild-operation-id-invalid'),
    `structured/number/boolean explicit operation id must not alias an existing id`,
  );
}

for (const invalid of ['', 0, false, Number.NaN]) {
  assert.throws(
    () => createRebuildPlan({ binaryId: 'binary-A', sourceHash, loaderVersion: 'loader-1', operations: [{ id: invalid, offset: 0n, before: [1], after: [2] }] }),
    isTypeError('rebuild-operation-id-invalid'),
    `explicit-but-invalid operation id ${String(invalid)} must fail closed, not be laundered or silently dropped`,
  );
}

assert.throws(
  () => createRebuildPlan({ binaryId: ['binary-A'], sourceHash: ['bytes:source-A'], loaderVersion: ['loader-1'], operations: [{ id: ['patch-1'], offset: 0n, before: [1], after: [2] }] }),
  isTypeError('rebuild-binary-id-required'),
  'the issue #4756 minimal counterexample must fail closed',
);

for (const omitted of [undefined, null]) {
  const plan = createRebuildPlan({ binaryId: 'binary-A', sourceHash, loaderVersion: 'loader-1', operations: [{ id: omitted, offset: 0n, before: [1], after: [2] }] });
  assert.match(plan.operations[0].id, /^operation:[0-9a-f]{32}$/, `nullish operation id ${String(omitted)} must keep the deterministic fallback`);
}
const fallbackA = createRebuildPlan({ binaryId: 'binary-A', sourceHash, loaderVersion: 'loader-1', operations: [{ offset: 0n, before: [1], after: [2] }] });
const fallbackB = createRebuildPlan({ binaryId: 'binary-A', sourceHash, loaderVersion: 'loader-1', operations: [{ offset: 0n, before: [1], after: [2] }] });
assert.equal(fallbackA.operations[0].id, fallbackB.operations[0].id, 'deterministic operation id fallback must be stable');
assert.equal(fallbackA.planId, fallbackB.planId, 'deterministic fallback must keep plan identity stable');

const valid = createRebuildPlan({ binaryId: 'binary-A', sourceHash, loaderVersion: 'loader-1', operations: [{ id: 'patch-1', offset: 1, before: [2], after: [9] }] });
assert.equal(valid.binaryId, 'binary-A');
assert.equal(valid.sourceHash, sourceHash);
assert.equal(valid.loaderVersion, 'loader-1');
assert.equal(valid.operations[0].id, 'patch-1');
assert.equal(valid.planId, `rebuild-plan:${stableDigest({ ...valid, planId: null })}`, 'valid primitive plan must keep planId integrity');
const materialized = await materializeRebuildPlan(valid, source);
assert.equal(materialized.status, 'materialized');
assert.deepEqual([...materialized.bytes], [1, 9, 3, 4, 5]);
const validation = await validateRebuildOutput(valid, materialized, {
  original: source,
  loaderReparse: (bytes) => ({ ok: bytes[1] === 9 }),
  validators: { evidence: () => ({ ok: true }) },
});
assert.equal(validation.status, 'valid');
assert.equal(validation.validators.find((entry) => entry.validator === 'source-precondition')?.status, 'passed');

const padded = createRebuildPlan({ binaryId: '  binary-A  ', sourceHash, loaderVersion: '  loader-1  ', operations: [{ id: '  patch-1  ', offset: 1, before: [2], after: [9] }] });
assert.equal(padded.binaryId, 'binary-A');
assert.equal(padded.loaderVersion, 'loader-1');
assert.equal(padded.operations[0].id, 'patch-1');
assert.equal(padded.planId, valid.planId, 'primitive string canonicalization must keep valid plan identity');

const stale = await materializeRebuildPlan(valid, Uint8Array.from([1, 8, 3, 4, 5]));
assert.equal(stale.status, 'rejected');
assert.equal(stale.reason, 'source-identity-mismatch');
const staleValidation = await validateRebuildOutput(valid, stale, { original: source, loaderReparse: () => ({ ok: true }), validators: { evidence: () => ({ ok: true }) } });
assert.equal(staleValidation.status, 'invalid');

console.log('issue #4756 rebuild structured identity string-coercion: PASS');

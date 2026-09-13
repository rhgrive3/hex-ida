import assert from 'node:assert/strict';
import {
  createRebuildPlan,
  materializeRebuildPlan,
  publishRebuildOutput,
  validateRebuildOutput,
} from '../js/rebuild/index.js';
import { stableDigest } from '../js/core/identity/index.js';

const hash = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;
const greenOptions = (original) => ({
  original,
  loaderReparse: async () => ({ ok: true }),
  validators: { evidence: async () => ({ ok: true }) },
});
const failedValidators = (validation) => new Set(validation.failures.map((entry) => entry.validator));

const noopOriginal = Uint8Array.from([0x11, 0x22]);
const noopPlan = createRebuildPlan({
  binaryId: 'bin-4991-noop',
  sourceHash: hash(noopOriginal),
  loaderVersion: 'test-loader',
  operations: [],
});

// (1) Acceptance #1/#2: the issue counterexample. A no-op plan authorizes zero
// byte changes, so a forged plain-object artifact claiming full-range touched
// with attacker-chosen bytes must never reach the green result.
const forgedNoop = {
  status: 'materialized',
  planId: noopPlan.planId,
  sourceHash: noopPlan.sourceHash,
  outputHash: hash([0xaa, 0xbb]),
  bytes: Uint8Array.from([0xaa, 0xbb]),
  touched: [{ offset: 0, length: 2 }],
};
const noopForgery = await validateRebuildOutput(noopPlan, forgedNoop, greenOptions(noopOriginal));
assert.equal(noopForgery.status, 'invalid', 'a no-op plan must not validate any byte change');
assert.ok(failedValidators(noopForgery).has('structure'), 'structure must reject non-plan-derived bytes');
assert.ok(failedValidators(noopForgery).has('unchanged-regions'), 'full-range touched must not bypass unchanged-regions');
const noopPublished = await publishRebuildOutput(forgedNoop, noopForgery, { promote: async (bytes) => Array.from(bytes) });
assert.equal(noopPublished.status, 'rejected', 'an invalid artifact must not publish');
assert.notEqual(noopPublished.status, 'published');

// (2) Acceptance #5: copying planId/sourceHash/outputHash proves nothing. Here
// the honest outputHash is kept while exactly one byte is tampered and the
// touched set is shrunk to nothing.
const honest = await materializeRebuildPlan(noopPlan, noopOriginal);
assert.equal(honest.status, 'materialized');
assert.equal((await validateRebuildOutput(noopPlan, honest, greenOptions(noopOriginal))).status, 'valid');
const staleHashForgery = {
  status: 'materialized',
  planId: honest.planId,
  sourceHash: honest.sourceHash,
  outputHash: honest.outputHash,
  bytes: Uint8Array.from([0x11, 0x99]),
  touched: [],
};
const staleHashValidation = await validateRebuildOutput(noopPlan, staleHashForgery, greenOptions(noopOriginal));
assert.equal(staleHashValidation.status, 'invalid', 'copied identity fields must not substitute for plan origin');

// (3) Acceptance #3: a non-empty plan must reject extra changes outside its
// operations, even when outputHash and touched are recomputed for the tamper.
const editOriginal = Uint8Array.from([0x10, 0x20, 0x30, 0x40]);
const editPlan = createRebuildPlan({
  binaryId: 'bin-4991-edit',
  sourceHash: hash(editOriginal),
  loaderVersion: 'test-loader',
  operations: [{ offset: 1, before: [0x20], after: [0x99] }],
});
const authorizedOutput = await materializeRebuildPlan(editPlan, editOriginal);
assert.deepEqual([...authorizedOutput.bytes], [0x10, 0x99, 0x30, 0x40]);
assert.equal((await validateRebuildOutput(editPlan, authorizedOutput, greenOptions(editOriginal))).status, 'valid',
  'the plan-authorized output must keep validating');

for (const [label, bytes, touched] of [
  ['extra change outside operations', Uint8Array.from([0x10, 0x99, 0x30, 0x77]), [{ offset: 1, length: 1 }, { offset: 3, length: 1 }]],
  ['operation region swapped after payload', Uint8Array.from([0x10, 0x77, 0x30, 0x40]), [{ offset: 1, length: 1 }]],
  ['authorized change undeclared', Uint8Array.from([0x10, 0x99, 0x30, 0x40]), []],
  ['touched widened to full output', Uint8Array.from([0x10, 0x99, 0x30, 0x77]), [{ offset: 0, length: 4 }]],
  ['output extended', Uint8Array.from([0x10, 0x99, 0x30, 0x40, 0x55]), [{ offset: 1, length: 1 }]],
]) {
  const forged = {
    status: 'materialized',
    planId: editPlan.planId,
    sourceHash: editPlan.sourceHash,
    outputHash: hash(bytes),
    bytes: Uint8Array.from(bytes),
    touched,
  };
  const validation = await validateRebuildOutput(editPlan, forged, greenOptions(editOriginal));
  assert.equal(validation.status, 'invalid', `${label} must be rejected`);
  assert.equal((await publishRebuildOutput(forged, validation, { promote: async () => 'promoted' })).status, 'rejected',
    `${label} must not reach published`);
}

// (4) A forged sourceHash that no longer matches the real original cannot be
// excused by matching the plan's declared hash alone.
const foreignOriginal = Uint8Array.from([0xde, 0xad]);
const foreignPlan = createRebuildPlan({
  binaryId: 'bin-4991-foreign',
  sourceHash: hash(foreignOriginal),
  loaderVersion: 'test-loader',
  operations: [],
});
const foreignMaterialized = await materializeRebuildPlan(foreignPlan, foreignOriginal);
assert.equal((await validateRebuildOutput(foreignPlan, foreignMaterialized, greenOptions(foreignOriginal))).status, 'valid');
assert.equal((await validateRebuildOutput(foreignPlan, foreignMaterialized, greenOptions(noopOriginal))).status, 'invalid',
  'original bytes must be bound to the plan source hash');

console.log('issue-4991 rebuild forged materialized plan binding: PASS');

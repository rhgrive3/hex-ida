import assert from 'node:assert/strict';
import {
  createRebuildPlan,
  materializeRebuildPlan,
  validateRebuildOutput,
} from '../../../js/rebuild/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';

const source = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
const sourceHash = `bytes:${stableDigest(Array.from(source))}`;
const plan = createRebuildPlan({
  binaryId: 'hex-binary:issue-4521',
  sourceHash,
  loaderVersion: 'loader-4521',
  operations: [{ offset: 1, before: [0x22], after: [0x99] }],
  impact: { layoutMoving: true },
});
const baselineValidators = [
  'evidence',
  'layout',
  'loader-reparse',
  'source-precondition',
  'structure',
  'unchanged-regions',
];

function recomputePlanId(candidate) {
  return {
    ...candidate,
    planId: `rebuild-plan:${stableDigest({ ...candidate, planId: null })}`,
  };
}

const materialized = await materializeRebuildPlan(plan, source);
assert.equal(materialized.status, 'materialized');
const valid = await validateRebuildOutput(plan, materialized, {
  original: source,
  loaderReparse: (output) => ({ ok: output[1] === 0x99 }),
  validators: { evidence: () => ({ ok: true }), layout: () => ({ ok: true }) },
});
assert.equal(valid.status, 'valid');
assert.deepEqual(valid.validators.map((entry) => entry.validator), baselineValidators);

for (const [label, mutation, expectedReason] of [
  ['empty', { requiredValidators: [] }, 'rebuild-plan-identity-mismatch'],
  ['missing', null, 'rebuild-plan-required-validators-invalid'],
  ['null', { requiredValidators: null }, 'rebuild-plan-required-validators-invalid'],
  ['string', { requiredValidators: 'loader-reparse' }, 'rebuild-plan-required-validators-invalid'],
]) {
  const stale = mutation === null
    ? (() => {
      const { requiredValidators, ...withoutRequiredValidators } = plan;
      return withoutRequiredValidators;
    })()
    : { ...plan, ...mutation };
  const staleMaterialized = await materializeRebuildPlan(stale, source);
  assert.equal(staleMaterialized.status, 'rejected', `${label} requiredValidators must be rejected`);
  assert.equal(staleMaterialized.reason, expectedReason);
  const staleValidation = await validateRebuildOutput(stale, materialized);
  assert.equal(staleValidation.status, 'invalid', `${label} requiredValidators must not validate`);
  assert.equal(staleValidation.reason, expectedReason);
}

const stalePlanId = { ...plan, requiredValidators: [] };
assert.equal((await materializeRebuildPlan(stalePlanId, source)).reason, 'rebuild-plan-identity-mismatch');
assert.equal((await validateRebuildOutput(stalePlanId, materialized)).reason, 'rebuild-plan-identity-mismatch');

const recomputedWeakPlan = recomputePlanId({ ...plan, requiredValidators: [] });
const weakMaterialized = await materializeRebuildPlan(recomputedWeakPlan, source);
assert.equal(weakMaterialized.status, 'materialized');
const weakValidation = await validateRebuildOutput(recomputedWeakPlan, weakMaterialized);
assert.equal(weakValidation.status, 'invalid');
assert.deepEqual(weakValidation.validators.map((entry) => entry.validator), baselineValidators);
assert.ok(weakValidation.validators.some((entry) => entry.status === 'unavailable'));

const staleBinaryId = { ...plan, binaryId: 'hex-binary:changed' };
assert.equal((await materializeRebuildPlan(staleBinaryId, source)).reason, 'rebuild-plan-identity-mismatch');

console.log('issue-4521 rebuild plan validation integrity: PASS');

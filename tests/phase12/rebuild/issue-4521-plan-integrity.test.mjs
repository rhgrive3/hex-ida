import assert from 'node:assert/strict';
import { createRebuildPlan, materializeRebuildPlan, validateRebuildOutput } from '../../../js/rebuild/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';

const source = Uint8Array.from([0x11]);
const sourceHash = `bytes:${stableDigest(Array.from(source))}`;
const plan = createRebuildPlan({
  binaryId: 'bin-4521',
  sourceHash,
  loaderVersion: 'test-loader',
  operations: [],
});

// Keeping the original planId does not make a weakened plain-object clone valid.
for (const requiredValidators of [[], null, undefined, {}, ['source-precondition']]) {
  const forged = { ...plan, requiredValidators };
  await assert.rejects(
    () => materializeRebuildPlan(forged, source),
    /rebuild-plan-(integrity|validators|baseline-validators)-invalid/,
    `weakened requiredValidators ${String(requiredValidators)} must be rejected`,
  );
  const validation = await validateRebuildOutput(forged, { status: 'materialized', bytes: source });
  assert.equal(validation.status, 'invalid');
  assert.equal(validation.failures[0].validator, 'plan-integrity');
}

// Even a forged digest cannot remove implementation-owned baseline validators.
const recomputedWeakPlan = { ...plan, requiredValidators: ['source-precondition'], planId: null };
recomputedWeakPlan.planId = `rebuild-plan:${stableDigest(recomputedWeakPlan)}`;
await assert.rejects(
  () => materializeRebuildPlan(recomputedWeakPlan, source),
  /rebuild-plan-baseline-validators-invalid/,
);

// A canonical plan still requires the complete baseline set and can validate
// when every required oracle is available.
const materialized = await materializeRebuildPlan(plan, source);
const validation = await validateRebuildOutput(plan, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true }),
  validators: { evidence: () => ({ ok: true }) },
});
assert.equal(validation.status, 'valid');

console.log('issue-4521-plan-integrity: PASS');

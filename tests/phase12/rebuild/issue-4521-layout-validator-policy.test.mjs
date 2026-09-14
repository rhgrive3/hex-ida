import assert from 'node:assert/strict';
import {
  createRebuildPlan,
  materializeRebuildPlan,
  validateRebuildOutput,
} from '../../../js/rebuild/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';

const source = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
const plan = createRebuildPlan({
  binaryId: 'hex-binary:issue-4521-layout',
  sourceHash: `bytes:${stableDigest(Array.from(source))}`,
  loaderVersion: 'loader-4521-layout',
  operations: [{ offset: 1, before: [0x22], after: [0x99] }],
  impact: { layoutMoving: true },
});

assert.ok(plan.requiredValidators.includes('layout'), 'layout-moving plans must require the layout validator');
for (const required of ['source-precondition', 'structure', 'loader-reparse', 'unchanged-regions', 'evidence']) {
  assert.ok(plan.requiredValidators.includes(required), `baseline validator ${required} must remain required`);
}

const materialized = await materializeRebuildPlan(plan, source);
assert.equal(materialized.status, 'materialized');
const validation = await validateRebuildOutput(plan, materialized, {
  original: source,
  loaderReparse: (output) => ({ ok: output[1] === 0x99 }),
  validators: {
    evidence: () => ({ ok: true }),
    layout: () => ({ ok: true }),
  },
});
assert.equal(validation.status, 'valid');
const executed = validation.validators.map((entry) => entry.validator);
assert.ok(executed.includes('layout'), 'layout validator must execute for a layout-moving plan');
for (const required of ['source-precondition', 'structure', 'loader-reparse', 'unchanged-regions', 'evidence']) {
  assert.ok(executed.includes(required), `baseline validator ${required} must execute`);
}

console.log('issue-4521 layout validator policy: PASS');

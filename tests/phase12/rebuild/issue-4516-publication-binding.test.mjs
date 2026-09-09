import assert from 'node:assert/strict';

import {
  createRebuildPlan,
  materializeRebuildPlan,
  publishRebuildOutput,
  validateRebuildOutput,
} from '../../../js/rebuild/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';

function sourceHash(source) {
  return `bytes:${stableDigest(Array.from(source))}`;
}

const sourceA = new Uint8Array([0x11]);
const sourceB = new Uint8Array([0x22]);
const planA = createRebuildPlan({
  binaryId: 'A',
  sourceHash: sourceHash(sourceA),
  loaderVersion: 'test',
  operations: [],
});
const planB = createRebuildPlan({
  binaryId: 'B',
  sourceHash: sourceHash(sourceB),
  loaderVersion: 'test',
  operations: [],
});
const materializedA = await materializeRebuildPlan(planA, sourceA);
const materializedB = await materializeRebuildPlan(planB, sourceB);
const validationA = await validateRebuildOutput(planA, materializedA, {
  original: sourceA,
  loaderReparse: async () => ({ ok: true }),
  validators: { evidence: async () => ({ ok: true }) },
});

assert.equal(validationA.status, 'valid');
assert.notEqual(planA.planId, planB.planId);
assert.notEqual(materializedA.outputHash, materializedB.outputHash);

let promotions = 0;
const promote = async () => {
  promotions++;
  return 'promoted';
};

const planMismatch = await publishRebuildOutput(materializedB, validationA, { promote });
assert.equal(planMismatch.status, 'rejected');
assert.equal(planMismatch.reason, 'validation-target-mismatch');
assert.equal(promotions, 0);

const outputMismatch = await publishRebuildOutput(
  materializedA,
  { ...validationA, outputHash: materializedB.outputHash },
  { promote },
);
assert.equal(outputMismatch.status, 'rejected');
assert.equal(outputMismatch.reason, 'validation-target-mismatch');
assert.equal(promotions, 0);

const forged = await publishRebuildOutput(materializedB, { status: 'valid' }, { promote });
assert.equal(forged.status, 'rejected');
assert.equal(forged.reason, 'validation-target-mismatch');
assert.equal(promotions, 0);

const matching = await publishRebuildOutput(materializedA, validationA, { promote });
assert.equal(matching.status, 'published');
assert.equal(matching.outputHash, materializedA.outputHash);
assert.equal(promotions, 1);

console.log('issue-4516 rebuild publication binding: PASS');

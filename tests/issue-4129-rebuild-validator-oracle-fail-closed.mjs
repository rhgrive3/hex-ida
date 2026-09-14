import assert from 'node:assert/strict';
import { createRebuildPlan, materializeRebuildPlan, publishRebuildOutput, validateRebuildOutput } from '../js/rebuild/index.js';
import { stableDigest } from '../js/core/identity/index.js';

const source = Uint8Array.from([1]);
const plan = createRebuildPlan({
  binaryId: 'bin',
  sourceHash: 'bytes:' + stableDigest(Array.from(source)),
  loaderVersion: 'test',
  operations: [],
});
const materialized = await materializeRebuildPlan(plan, source);

async function run(result, { validator = 'evidence' } = {}) {
  const options = {
    original: source,
    loaderReparse: async () => (validator === 'loader-reparse' ? result : { ok: true }),
    validators: { evidence: async () => (validator === 'evidence' ? result : { ok: true }) },
  };
  return validateRebuildOutput(plan, materialized, options);
}

const contradictory = [
  ['ok:false + status:passed', { ok: false, status: 'passed', reason: 'verification actually failed' }],
  ['ok:false + status:valid', { ok: false, status: 'valid', reason: 'valid wording, failed result' }],
  ['ok:true + status:failed', { ok: true, status: 'failed' }],
  ['ok:true + status:invalid', { ok: true, status: 'invalid' }],
  ['ok:true + status:rejected', { ok: true, status: 'rejected' }],
  ['ok:true + status:error', { ok: true, status: 'error' }],
];

for (const [label, result] of contradictory) {
  for (const validator of ['evidence', 'loader-reparse']) {
    const validation = await run(result, { validator });
    const entry = validation.validators.find((item) => item.validator === validator);
    assert.equal(entry?.status, 'failed', `${label} must not count as passed for ${validator}`);
    assert.equal(validation.status, 'invalid', `${label} must invalidate rebuild validation for ${validator}`);
    assert.ok(validation.failures.some((failure) => failure.validator === validator),
      `${label} must be reported in failures for ${validator}`);
    const published = await publishRebuildOutput(materialized, validation, { promote: async () => 'bad' });
    assert.equal(published.status, 'rejected', `${label} must not reach the publication gate for ${validator}`);
  }
}

const keptReason = await run({ ok: false, status: 'passed', reason: 'verification actually failed' });
assert.equal(keptReason.validators.find((item) => item.validator === 'evidence')?.reason, 'verification actually failed',
  'the explicit failure reason must survive in the audit trail');

for (const result of [true, { ok: true }, { ok: true, status: 'passed' }, { ok: true, status: 'valid' }, { status: 'passed' }, { status: 'valid' }]) {
  const validation = await run(result);
  assert.equal(validation.validators.find((item) => item.validator === 'evidence')?.status, 'passed',
    `consistent success shape ${JSON.stringify(result)} must still pass`);
  assert.equal(validation.status, 'valid');
}

console.log('issue-4129 rebuild validator oracle fail-closed: PASS');

import assert from 'node:assert/strict';
import { createRebuildPlan, materializeRebuildPlan, publishRebuildOutput, validateRebuildOutput } from '../js/rebuild/index.js';
import { stableDigest } from '../js/core/identity/index.js';

const source = Uint8Array.from([1]);
const plan = createRebuildPlan({
  binaryId:'bin',
  sourceHash:'bytes:' + stableDigest(Array.from(source)),
  loaderVersion:'test',
  operations:[],
});
const materialized = await materializeRebuildPlan(plan, source);

for (const loaderResult of [null, undefined, {}, { status:'invalid' }, { status:'error' }, { status:'unsupported' }, { ok:false }]) {
  const validation = await validateRebuildOutput(plan, materialized, {
    original:source,
    loaderReparse:async () => loaderResult,
    validators:{ evidence:async () => ({ ok:true }) },
  });
  const loader = validation.validators.find((entry) => entry.validator === 'loader-reparse');
  assert.notEqual(loader?.status, 'passed');
  assert.equal(validation.status, 'invalid');
  assert.equal((await publishRebuildOutput(materialized, validation, { promote:async () => 'bad' })).status, 'rejected');
}

for (const loaderResult of [true, { ok:true }, { status:'passed' }, { status:'valid' }]) {
  const validation = await validateRebuildOutput(plan, materialized, {
    original:source,
    loaderReparse:async () => loaderResult,
    validators:{ evidence:async () => ({ ok:true }) },
  });
  assert.equal(validation.validators.find((entry) => entry.validator === 'loader-reparse')?.status, 'passed');
  assert.equal(validation.status, 'valid');
}

console.log('issue-3647 rebuild loader reparse fail-closed: PASS');

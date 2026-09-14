import assert from 'node:assert/strict';
import {
  clearFieldAccessArtifacts,
  fieldAccessAcrossExecutableRegions,
  fieldAccessRegion,
} from '../../js/analysis/field-access-artifact.js';

const region = { id:'text', exec:true, size:16n };
for (const invalid of [undefined, null, {}, { results:null }, { results:[], complete:'true' }, { results:[], truncated:'false' }]) {
  let calls = 0;
  let value = invalid;
  const backend = { fieldAccess: async () => { calls++; return value; } };
  await assert.rejects(fieldAccessRegion(backend, region, 0n, 4), /field-access-invalid-result/);
  value = { results:[], complete:true };
  const retry = await fieldAccessRegion(backend, region, 0n, 4);
  assert.equal(calls, 2, 'invalid backend results must not become persistent cache entries');
  assert.deepEqual(retry.results, []);
  assert.equal(retry.complete, true);
  clearFieldAccessArtifacts(backend);
}

{
  const backend = { fieldAccess: async () => ({ results:[], complete:false, reason:'budget' }) };
  const result = await fieldAccessRegion(backend, region, 0n, 4);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'budget');
}

{
  const regions = [region, { id:'text2', exec:true, size:16n }];
  const app = {
    backend: { fieldAccess: async ({ regionId }) => regionId === 'text' ? { results:[], complete:true } : {} },
    store: { get: (key) => key === 'regions' ? regions : null },
    codeRegion: () => region,
  };
  await assert.rejects(fieldAccessAcrossExecutableRegions(app, 0n, 4), /field-access-invalid-result/);
}

console.log('issue 3116 field-access invalid backend result: PASS');

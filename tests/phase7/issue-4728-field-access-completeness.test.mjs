import assert from 'node:assert/strict';
import {
  clearFieldAccessArtifacts,
  fieldAccessAcrossExecutableRegions,
  fieldAccessRegion,
} from '../../js/analysis/field-access-artifact.js';

const region = { id:'text', exec:true, size:16n };

{
  const backend = {
    fieldAccess: async () => ({ results:[{ offset:0x10 }], capped:true }),
  };
  const result = await fieldAccessRegion(backend, region, 0n, 4);
  assert.equal(result.complete,false);
  assert.equal(result.capped,true);
  assert.equal(result.reason,'field-access-result-budget');
  clearFieldAccessArtifacts(backend);
}

{
  let calls = 0;
  const backend = {
    analysisEpoch:0,
    fieldAccess: async () => {
      calls++;
      return calls === 1
        ? { results:[], cancelled:true }
        : { results:[{ offset:0x20 }], complete:true };
    },
  };
  const cancelled = await fieldAccessRegion(backend, region, 0n, 4);
  assert.equal(cancelled.complete,false);
  assert.equal(cancelled.cancelled,true);
  assert.equal(cancelled.reason,'field-access-cancelled');

  const retry = await fieldAccessRegion(backend, region, 0n, 4);
  assert.equal(calls,2);
  assert.equal(retry.complete,true);
  clearFieldAccessArtifacts(backend);
}

{
  const regions = [
    { id:'active', exec:true, size:16n },
    { id:'secondary', exec:true, size:16n },
  ];
  const backend = {
    fieldAccess: async ({ regionId }) => regionId === 'active'
      ? { results:[{ offset:0x10 }], complete:true }
      : { results:[{ offset:0x20 }], capped:true },
  };
  const app = {
    backend,
    codeRegion: () => regions[0],
    store: { get: (key) => key === 'regions' ? regions : null },
  };
  const aggregate = await fieldAccessAcrossExecutableRegions(app, 0n, 4);
  assert.equal(aggregate.complete,false);
  assert.equal(aggregate.reason,'field-access-result-budget');
  assert.deepEqual(aggregate.unscannedRegionIds,[]);
  clearFieldAccessArtifacts(backend);
}

for (const invalid of [
  { results:[], capped:'true' },
  { results:[], cancelled:'true' },
]) {
  const backend = { fieldAccess: async () => invalid };
  await assert.rejects(fieldAccessRegion(backend, region, 0n, 4), /field-access-invalid-result/);
  clearFieldAccessArtifacts(backend);
}

console.log('issue #4728 field-access completeness metadata: PASS');

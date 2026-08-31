import test from 'node:test';
import assert from 'node:assert/strict';

import { fieldAccessRegion, clearFieldAccessArtifacts } from '../../js/analysis/field-access-artifact.js';

test('issue-3143: BigInt sizes above 2^53 must not collide in the field-access artifact cache', async () => {
  const seenSizes = [];
  const backend = {
    fieldAccess({ regionId, offset, size }) {
      seenSizes.push(size);
      const promise = Promise.resolve({
        results: size === 9007199254740993n ? [{ addr:0x1100n, kind:'load', width:size }] : [{ addr:0x1000n, kind:'store', width:size }],
        complete:true,
      });
      promise.cancel = () => {};
      return promise;
    },
  };
  const region = { id:'R', exec:true, vmAddr:0x1000n, size:0x1000n };
  const first = await fieldAccessRegion(backend, region, 0x20, 9007199254740992n);
  const second = await fieldAccessRegion(backend, region, 0x20, 9007199254740993n);
  assert.equal(seenSizes.length, 2, 'distinct BigInt sizes must each reach the backend once');
  assert.equal(first.results[0].addr, 0x1000n);
  assert.equal(second.results[0].addr, 0x1100n, 'the second size must not reuse the first cached entry');
  clearFieldAccessArtifacts(backend);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldAccessAcrossExecutableRegions, fieldAccessRegion, clearFieldAccessArtifacts } from '../js/analysis/field-access-artifact.js';

function cancellableDeferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  let cancelCount = 0;
  promise.cancel = () => { cancelCount++; };
  return { promise, resolve, get cancelCount() { return cancelCount; } };
}

test('all executable regions are merged and secondary accesses are preserved', async () => {
  const calls = [];
  const backend = {
    fieldAccess({ regionId }) {
      calls.push(regionId);
      const promise = Promise.resolve({
        results:regionId === 'B' ? [{ addr:0x5100n, kind:'store' }] : [],
        complete:true,
      });
      promise.cancel = () => {};
      return promise;
    },
  };
  const regions = [
    { id:'A', exec:true, vmAddr:0x1000n, size:0x1000n },
    { id:'B', exec:true, vmAddr:0x5000n, size:0x1000n },
    { id:'D', exec:false, vmAddr:0x9000n, size:0x1000n },
  ];
  const partials = [];
  const app = { backend, codeRegion:() => regions[0], store:{ get:(key) => key === 'regions' ? regions : null } };
  const result = await fieldAccessAcrossExecutableRegions(app, 0x20, 4, { onPartial:(part) => partials.push(part) });
  assert.deepEqual(calls, ['A', 'B']);
  assert.equal(partials[0].complete, false, 'active-region fast path must remain explicitly partial');
  assert.deepEqual(partials[0].unscannedRegionIds, ['B']);
  assert.equal(result.complete, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].regionId, 'B');
  clearFieldAccessArtifacts(backend);
});

test('incomplete region prevents global completeness', async () => {
  const backend = {
    fieldAccess({ regionId }) {
      const promise = Promise.resolve({ results:[], complete:regionId !== 'B', reason:regionId === 'B' ? 'budget' : null });
      promise.cancel = () => {};
      return promise;
    },
  };
  const regions = [
    { id:'A', exec:true, size:1n },
    { id:'B', exec:true, size:1n },
  ];
  const app = { backend, codeRegion:() => regions[0], store:{ get:() => regions } };
  const result = await fieldAccessAcrossExecutableRegions(app, 0x20, 4);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'budget');
  assert.deepEqual(result.unscannedRegionIds, []);
  clearFieldAccessArtifacts(backend);
});

test('one consumer abort does not cancel a shared region request still used by another consumer', async () => {
  const deferred = cancellableDeferred();
  const backend = { fieldAccess:() => deferred.promise };
  const region = { id:'A', exec:true, size:1n };
  const first = new AbortController();
  const second = new AbortController();
  const p1 = fieldAccessRegion(backend, region, 0x20, 4, { signal:first.signal });
  const p2 = fieldAccessRegion(backend, region, 0x20, 4, { signal:second.signal });
  first.abort('first-left');
  await assert.rejects(p1, (error) => error?.name === 'AbortError');
  assert.equal(deferred.cancelCount, 0);
  deferred.resolve({ results:[], complete:true });
  assert.equal((await p2).complete, true);
  assert.equal(deferred.cancelCount, 0);
  clearFieldAccessArtifacts(backend);
});

test('last waiter abort cancels the underlying backend request', async () => {
  const deferred = cancellableDeferred();
  const backend = { fieldAccess:() => deferred.promise };
  const region = { id:'A', exec:true, size:1n };
  const controller = new AbortController();
  const pending = fieldAccessRegion(backend, region, 0x20, 4, { signal:controller.signal });
  controller.abort('sheet-closed');
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(deferred.cancelCount, 1);
  clearFieldAccessArtifacts(backend);
});

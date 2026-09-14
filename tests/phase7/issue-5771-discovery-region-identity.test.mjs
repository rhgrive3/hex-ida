import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis, __demandDrivenInternalsForTests } from '../../js/analysis/demand-driven-runtime.js';

// #5771: function discovery built its single-flight key and regionSetKey with
// template literals / join('|'), which coerce structured region ids
// (`['text']` → `'text'`). A producer started for a malformed region id was
// therefore shared with — and its raw id handed to the backend for — the
// canonical region request. Region ids must be canonical strings end to end.

function discoveryApp(producerIds) {
  return {
    backend: {
      gen: 1,
      guessFunctions(regionId) {
        producerIds.push(regionId);
        return Promise.resolve({ starts:[], complete:true, discoveryComplete:true });
      },
    },
    symbols: {
      functionCount:0,
      functionStartsComplete:false,
      functionDiscovery:null,
      addFunctions(){},
    },
  };
}

test('function discovery never hands a structured region id to the backend (#5771)', async () => {
  const producerIds = [];
  const app = discoveryApp(producerIds);
  installDemandDrivenAnalysis(app);

  const malformed = { id:['text'], exec:true, size:4n };
  await app.ensureFunctions(malformed);
  assert.deepEqual(producerIds, [], 'a region without a canonical string id must not start a discovery producer');

  const canonical = { id:'text', exec:true, size:4n };
  await app.ensureFunctions(canonical);
  assert.deepEqual(producerIds, ['text'], 'the canonical region id reaches the backend verbatim');
  assert.equal(app.symbols.functionDiscovery.regionSetKey, 'text');
  assert.equal(app.symbols.functionDiscovery.complete, true);
});

test('canonical and structured region requests never share one single-flight producer (#5771)', async () => {
  const producerIds = [];
  let resolveGuess;
  const app = discoveryApp(producerIds);
  app.backend.guessFunctions = (regionId) => {
    producerIds.push(regionId);
    return new Promise((resolve) => { resolveGuess = resolve; });
  };
  installDemandDrivenAnalysis(app);

  const malformedCall = app.ensureFunctions({ id:['text'], exec:true, size:4n });
  const canonicalCall = app.ensureFunctions({ id:'text', exec:true, size:4n });
  // Keep the canonical producer pending, then prove that the malformed request
  // settles independently instead of attaching to that pending producer. Promise
  // wrapper identity cannot distinguish single-flight sharing.
  assert.deepEqual(producerIds, ['text'], 'the canonical request must start the producer');
  const malformedSettled = await Promise.race([
    app.ensureFunctions({ id:['text'], exec:true, size:4n }).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  assert.equal(malformedSettled, true, 'malformed request must not wait for canonical producer');
  assert.deepEqual(producerIds, ['text'], 'only the canonical request may run guessFunctions');
  resolveGuess({ starts:[], complete:true, discoveryComplete:true });
  await canonicalCall;
});


test('address-based target selection rejects structured region ids (#5772)', () => {
  const app = {
    executableRegionFor() { return { id:['text'], exec:true, size:4n, vmAddr:0n }; },
    programRegions() { return []; },
  };
  const plan = __demandDrivenInternalsForTests.localRegionPlan(app, 0n, 'callers');
  assert.equal(plan.target, null, 'an executableRegionFor result with a structured id must not be a local scan target');
  assert.deepEqual(plan.local, []);
  assert.deepEqual(plan.unscanned, []);
});

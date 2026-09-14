import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

// #4243: the multi-region shape cache (`regionCache`/`combinedKey`) and the
// local Program scan cache (`regionScans`) key on `${epoch}:${region.id}`
// only. The legacy Mach-O parser renumbers region ids from `sec0` per slice,
// and `App.applySlice()` does not advance `backend.gen`, so a slice switch
// inside one fat binary lets slice A's raw shape/scan results be served to
// slice B. Region-scoped artifacts must bind canonical slice identity; even a
// fresh snapshot/query may not revive a foreign slice's producer result.

function shapeScan(marker) {
  return {
    count:1, disp:[8], size:[8], flags:[0], amtKind:[0], amtDisp:[0],
    addr:[0x1000n], baseIdentity:[marker], complete:true,
  };
}

function fatShapesApp() {
  const state = { sliceIndex:0, shapeCalls:[] };
  const slices = [
    { marker:'sliceA', regions:[{ id:'sec0', exec:true, size:0x100n, vmAddr:0x1000n, fileOffset:0x100n }] },
    { marker:'sliceB', regions:[{ id:'sec0', exec:true, size:0x100n, vmAddr:0x9000n, fileOffset:0x900n }] },
  ];
  const app = {
    backend: {
      gen: 7,
      valueShapes(regionId) {
        state.shapeCalls.push({ slice:state.sliceIndex, regionId, marker:slices[state.sliceIndex].marker });
        return Promise.resolve(shapeScan(slices[state.sliceIndex].marker));
      },
    },
    store: {
      get(key) {
        if (key === 'sliceIndex') return state.sliceIndex;
        if (key === 'regions') return slices[state.sliceIndex].regions;
        return null;
      },
    },
  };
  installDemandDrivenAnalysis(app);
  const switchSlice = (index) => { state.sliceIndex = index; };
  return { app, state, switchSlice };
}

test('slice switch re-runs shape producers instead of serving the foreign slice cache (#4243)', async () => {
  const { app, state, switchSlice } = fatShapesApp();

  const shapesA = await app.ensureShapes();
  assert.ok(shapesA.has('target:sliceA:8'));
  assert.deepEqual(state.shapeCalls, [{ slice:0, regionId:'sec0', marker:'sliceA' }]);

  switchSlice(1);
  const shapesB = await app.ensureShapes();
  assert.deepEqual(state.shapeCalls.map((call) => call.marker), ['sliceA', 'sliceB'],
    'slice B must re-run the shape backend for its own `sec0`, not reuse the pinned slice A result');
  assert.ok(shapesB.has('target:sliceB:8'), "slice B must get its own region's facts");
  assert.ok(!shapesB.has('target:sliceA:8'), 'slice A facts must never appear for slice B');

  app.shapes = null;
  const shapesBAgain = await app.ensureShapes();
  assert.equal(state.shapeCalls.length, 2,
    'the cleared pinned object must still hit the same-slice region cache, not the slice A entry');
  assert.ok(shapesBAgain.has('target:sliceB:8') && !shapesBAgain.has('target:sliceA:8'));
});

test('a fresh snapshot after slice switch never replays a foreign Program scan (#4243)', async () => {
  const TARGET = 0x2000n;
  const state = { sliceIndex:0, scanCalls:[] };
  const scan = (sites) => ({
    regionId:'sec0',
    vmAddr:0x1000n,
    callFrom:BigUint64Array.from(sites),
    callTo:BigUint64Array.from(sites.map(() => TARGET)),
    callCount:sites.length,
    refFrom:new BigUint64Array(0),
    refTo:new BigUint64Array(0),
    refKind:new Uint8Array(0),
    refCount:0,
    kinds:new Uint8Array(0),
    kindsCovered:0,
    words:0,
    complete:true,
    completeness:{ complete:true, reasons:[] },
  });
  const slices = [
    { regions:[{ id:'sec0', exec:true, size:0x1000n, vmAddr:0x1000n, fileOffset:0x100n }], scan:scan([0x1234n]) },
    { regions:[{ id:'sec0', exec:true, size:0x1000n, vmAddr:0x1000n, fileOffset:0x900n }], scan:scan([]) },
  ];
  const app = {
    analysisEpoch:0,
    symbols:null,
    backend: {
      binaryId:'issue-4243',
      gen: 7,
      scanProgram(regionId) {
        state.scanCalls.push({ slice:state.sliceIndex, regionId });
        return Promise.resolve(slices[state.sliceIndex].scan);
      },
    },
    store: {
      get(key) {
        if (key === 'sliceIndex') return state.sliceIndex;
        if (key === 'regions') return slices[state.sliceIndex].regions;
        if (key === 'currentRegion') return slices[state.sliceIndex].regions[0];
        return null;
      },
    },
  };
  const api = installDemandDrivenAnalysis(app);

  const snapshotA = await api.snapshot();
  const callersA = await api.callers(snapshotA, TARGET, { offset:0, limit:50 });
  assert.deepEqual(callersA.value.map((row) => row.site), [0x1234n]);
  assert.deepEqual(state.scanCalls, [{ slice:0, regionId:'sec0' }]);

  state.sliceIndex = 1;
  const snapshotB = await api.snapshot();
  const callersB = await api.callers(snapshotB, TARGET, { offset:0, limit:50 });
  assert.deepEqual(state.scanCalls, [{ slice:0, regionId:'sec0' }, { slice:1, regionId:'sec0' }],
    'slice B must re-run the local Program scan for its own `sec0`');
  assert.deepEqual(callersB.value, [], "slice A's caller facts must not appear for slice B");

  const callersAgain = await api.callers(snapshotB, TARGET, { offset:0, limit:50 });
  assert.deepEqual(callersAgain.value, []);
  assert.equal(state.scanCalls.length, 2, 'same slice + same profile stays a cache hit');
});

test('epoch invalidation still applies across slice-identity binding (#4243)', async () => {
  const { app, state, switchSlice } = fatShapesApp();
  await app.ensureShapes();
  switchSlice(1);
  app.backend.gen = 8;
  app.shapes = null;
  await app.ensureShapes();
  assert.equal(state.shapeCalls.length, 2,
    'an analysis epoch change must still invalidate shape caches');
  assert.deepEqual(state.shapeCalls.map((call) => call.slice), [0, 1]);
});
test('function discovery re-runs for a same-id region on a different slice (#4243)', async () => {
  const state = { sliceIndex:0, calls:[] };
  const slices = [
    { starts:[0x1000n], regions:[{ id:'sec0', exec:true, size:0x100n }] },
    { starts:[0x9000n], regions:[{ id:'sec0', exec:true, size:0x100n }] },
  ];
  const symbols = {
    functionCount:0,
    functionStartsComplete:false,
    functionDiscovery:null,
    addFunctions(starts) {
      this.functionCount += starts.length;
    },
  };
  const app = {
    backend: {
      binaryId:'issue-4243-function-discovery',
      gen:7,
      guessFunctions(regionId) {
        state.calls.push({ slice:state.sliceIndex, regionId });
        return Promise.resolve({
          starts:slices[state.sliceIndex].starts,
          discoveryComplete:true,
          complete:true,
        });
      },
    },
    symbols,
    store: {
      get(key) {
        if (key === 'sliceIndex') return state.sliceIndex;
        if (key === 'regions') return slices[state.sliceIndex].regions;
        return null;
      },
    },
  };
  installDemandDrivenAnalysis(app);

  await app.ensureFunctions();
  assert.deepEqual(state.calls, [{ slice:0, regionId:'sec0' }]);
  assert.equal(symbols.functionDiscovery.discoveryKey,
    '7:issue-4243-function-discovery|slice:0:sec0');

  state.sliceIndex = 1;
  await app.ensureFunctions();
  assert.deepEqual(state.calls, [
    { slice:0, regionId:'sec0' },
    { slice:1, regionId:'sec0' },
  ], 'slice B must not reuse slice A function-discovery fast path');
  assert.equal(symbols.functionCount, 2);
  assert.equal(symbols.functionDiscovery.discoveryKey,
    '7:issue-4243-function-discovery|slice:1:sec0');

  await app.ensureFunctions();
  assert.deepEqual(state.calls, [
    { slice:0, regionId:'sec0' },
    { slice:1, regionId:'sec0' },
  ], 'same-slice re-entry must hit the completed discovery fast path');
});

test('a same-epoch slice switch cannot publish an in-flight foreign discovery (#4243)', async () => {
  const state = { sliceIndex:0, calls:[], pending:[] };
  const slices = [
    { starts:[0x1000n], regions:[{ id:'sec0', exec:true, size:0x100n }] },
    { starts:[0x9000n], regions:[{ id:'sec0', exec:true, size:0x100n }] },
  ];
  const symbols = {
    functionCount:0,
    functionStartsComplete:false,
    functionDiscovery:null,
    starts:[],
    addFunctions(starts) {
      this.functionCount += starts.length;
      this.starts.push(...starts);
    },
  };
  const app = {
    backend: {
      binaryId:'issue-4243-inflight',
      gen:7,
      guessFunctions(regionId) {
        const slice = state.sliceIndex;
        state.calls.push({ slice, regionId });
        return new Promise((resolve) => state.pending.push({ slice, resolve }));
      },
    },
    symbols,
    store: {
      get(key) {
        if (key === 'sliceIndex') return state.sliceIndex;
        if (key === 'regions') return slices[state.sliceIndex].regions;
        return null;
      },
    },
  };
  installDemandDrivenAnalysis(app);

  const discoveryA = app.ensureFunctions();
  assert.deepEqual(state.calls, [{ slice:0, regionId:'sec0' }]);

  state.sliceIndex = 1;
  const discoveryB = app.ensureFunctions();
  assert.deepEqual(state.calls, [
    { slice:0, regionId:'sec0' },
    { slice:1, regionId:'sec0' },
  ], 'slice B must get a distinct in-flight producer');

  state.pending[0].resolve({ starts:slices[0].starts, discoveryComplete:true, complete:true });
  await assert.rejects(discoveryA, /stale function discovery/);

  state.pending[1].resolve({ starts:slices[1].starts, discoveryComplete:true, complete:true });
  await discoveryB;
  assert.deepEqual(symbols.starts, slices[1].starts,
    'a stale slice-A producer must never publish its function starts');
  assert.equal(symbols.functionDiscovery.discoveryKey,
    '7:issue-4243-inflight|slice:1:sec0');
});

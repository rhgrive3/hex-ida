import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/product-evidence-adapter.js';
import { createProductSurfaceQueries } from '../../../js/analysis/query/product-surface.js';

// #5585: the Product string artifact cache keyed its state with
// `Number(app.backend?.gen):Number(app.store.get('sliceIndex'))`. A structured
// sliceIndex `['1']` Number()-coerced to `1` and aliased the canonical index,
// so the snapshot authority (artifactVersionsFor distinguishes structured from
// primitive dimensions) reported a new analysis state while the string cache
// kept serving the stale scan plan/rows of the old state.

function makeApp() {
  const store = new Map([
    ['fileInfo', { hash: 'hash-5585', binaryId: 'bin-5585', slices: [] }],
    ['capability', { architecture: 'arm64', semanticVersion: 'test-v1' }],
    ['regions', [{ id: 'rA', section: '__cstring', size: 64n }]],
    ['currentRegion', null],
    ['sliceIndex', ['1']],
  ]);
  let backendCalls = 0;
  let stringsText = 'from-A';
  const app = {
    store: { get: (key) => store.get(key) ?? null },
    backend: {
      gen: 1,
      strings: async () => {
        backendCalls++;
        return { complete: true, results: [{ addr: 0n, text: stringsText }] };
      },
    },
    symbols: { gen: 0, functionEvidence: () => null, nameAt: () => null, nameEvidence: () => null },
  };
  app.analysisQueries = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  return { app, store, backendCalls: () => backendCalls, setStringsText: (t) => { stringsText = t; } };
}

test('structured sliceIndex must not alias the canonical index in the string cache (#5585)', async () => {
  const { app, store, setStringsText } = makeApp();
  const surface = createProductSurfaceQueries(app);

  const snapshotA = await app.analysisQueries.snapshot();
  const resultA = await surface.strings(snapshotA, {}, { offset: 0, limit: 10 }, {});
  assert.deepEqual((resultA.value || []).map((row) => row.text), ['from-A'], 'precondition: state A scanned its own region');

  // Canonical slice index with different regions: the snapshot authority sees
  // a distinct analysis state (structured vs primitive dimension), so the
  // string cache must NOT keep serving the old scan.
  store.set('sliceIndex', 1);
  store.set('regions', [{ id: 'rB', section: '__cstring', size: 64n }]);
  setStringsText('from-B');

  const snapshotB = await app.analysisQueries.snapshot();
  assert.notEqual(snapshotA.snapshotId, snapshotB.snapshotId, 'snapshot identity distinguishes structured from primitive sliceIndex');

  const resultB = await surface.strings(snapshotB, {}, { offset: 0, limit: 10 }, {});
  assert.deepEqual(
    (resultB.value || []).map((row) => row.text),
    ['from-B'],
    'state B must scan its own regions, not reuse the aliased cache (#5585)',
  );
});

test('repeated queries on one unchanged state still reuse the cached scan (#5585 control)', async () => {
  const { app, backendCalls } = makeApp();
  const surface = createProductSurfaceQueries(app);
  const snapshot = await app.analysisQueries.snapshot();
  const first = await surface.strings(snapshot, {}, { offset: 0, limit: 10 }, {});
  const second = await surface.strings(snapshot, {}, { offset: 0, limit: 10 }, {});
  assert.deepEqual((second.value || []).map((row) => row.text), (first.value || []).map((row) => row.text));
  assert.equal(backendCalls(), 1, 'the second query must be served from the scan cache');
});

test('two distinct structured sliceIndex values must not share one cache entry (#5585)', async () => {
  const { app, store, backendCalls, setStringsText } = makeApp();
  const surface = createProductSurfaceQueries(app);
  const snapshotA = await app.analysisQueries.snapshot();
  await surface.strings(snapshotA, {}, { offset: 0, limit: 10 }, {});

  // A different structured index is a different analysis state: both the
  // snapshot authority and the cache must see the rotation.
  store.set('sliceIndex', ['2']);
  store.set('regions', [{ id: 'rB', section: '__cstring', size: 64n }]);
  setStringsText('from-B');

  const snapshotB = await app.analysisQueries.snapshot();
  assert.notEqual(snapshotA.snapshotId, snapshotB.snapshotId, "['1'] and ['2'] are distinct states");
  const resultB = await surface.strings(snapshotB, {}, { offset: 0, limit: 10 }, {});
  assert.deepEqual(
    (resultB.value || []).map((row) => row.text),
    ['from-B'],
    "cache key must distinguish ['1'] from ['2'] (#5585)",
  );
  assert.ok(backendCalls() >= 2, 'the new state performs its own scan');
});

test('canonical sliceIndex transitions still rotate the cache (#5585 control)', async () => {
  const { app, store, backendCalls, setStringsText } = makeApp();
  const surface = createProductSurfaceQueries(app);
  app.backend.gen = 1;
  store.set('sliceIndex', -1);
  const snapshotA = await app.analysisQueries.snapshot();
  await surface.strings(snapshotA, {}, { offset: 0, limit: 10 }, {});

  store.set('sliceIndex', 0);
  store.set('regions', [{ id: 'rB', section: '__cstring', size: 64n }]);
  setStringsText('from-B');
  const snapshotB = await app.analysisQueries.snapshot();
  const resultB = await surface.strings(snapshotB, {}, { offset: 0, limit: 10 }, {});
  assert.deepEqual((resultB.value || []).map((row) => row.text), ['from-B'], 'canonical index change still rotates the state');
  assert.ok(backendCalls() >= 2, 'canonical transition performs its own scan');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisQueryAPI } from '../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/product-adapter.js';
import { createProductSurfaceQueries } from '../../js/analysis/query/product-surface.js';

function makeApp() {
  const stringsCalls = [];
  const app = {
    backend: {
      gen: 1,
      binaryId: 'bin-5585',
      strings() {
        stringsCalls.push(stringsCalls.length + 1);
        return Promise.resolve({
          complete: true,
          results: [{ addr: 0n, text: 'from-scan' }],
        });
      },
    },
    store: {
      _m: new Map(),
      get(key) { return this._m.get(key); },
      set(key, value) { this._m.set(key, value); },
    },
  };
  app.store.set('regions', [{ id: 'A', size: 16n, section: '__cstring', cstrings: true }]);
  app.analysisQueries = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  return { app, stringsCalls };
}

test('#5585 a structured sliceIndex state is not reused for the canonical index', async () => {
  const { app, stringsCalls } = makeApp();
  const product = createProductSurfaceQueries(app);

  app.store.set('sliceIndex', ['1']);
  const snapshotA = await app.analysisQueries.snapshot();
  const resultA = await product.strings(snapshotA);
  assert.equal(stringsCalls.length, 1, 'first snapshot scans once');

  // Different snapshot identity (structured -> canonical), so the string
  // state must be rebuilt, not reused (#5585).
  app.store.set('sliceIndex', 1);
  const snapshotB = await app.analysisQueries.snapshot();
  assert.notEqual(
    snapshotA.artifactVersions?.sliceIndex,
    snapshotB.artifactVersions?.sliceIndex,
    'snapshot identity must differ across slice spellings',
  );
  const resultB = await product.strings(snapshotB);
  assert.equal(stringsCalls.length, 2, `canonical slice index must rescan instead of reusing the structured state, saw ${stringsCalls.length}`);
});

test('#5585 repeated queries within one snapshot keep reusing the scan state', async () => {
  const { app, stringsCalls } = makeApp();
  const product = createProductSurfaceQueries(app);

  app.store.set('sliceIndex', 1);
  const snapshot = await app.analysisQueries.snapshot();
  await product.strings(snapshot);
  await product.strings(snapshot, { text: 'zzz' });
  assert.equal(stringsCalls.length, 1, `same-snapshot repeat queries must not rescan, saw ${stringsCalls.length}`);
});

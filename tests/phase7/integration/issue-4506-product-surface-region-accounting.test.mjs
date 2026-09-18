import assert from 'node:assert/strict';

import { createProductSurfaceQueries } from '../../../js/analysis/query/product-surface.js';
import { createAnalysisSnapshot } from '../../../js/analysis/query/snapshot.js';

const SNAPSHOT = createAnalysisSnapshot({ binaryId: 'issue-4506', analysisEpoch: 1 });

function makeApp(regions) {
  const calls = [];
  return {
    calls,
    app: {
      analysisQueries: { snapshot: async () => SNAPSHOT },
      backend: {
        gen: 1,
        strings: async (request) => {
          calls.push(request);
          return { complete: true, scannedBytes: request.maxBytes, results: [] };
        },
      },
      store: {
        get(key) {
          if (key === 'regions') return regions;
          if (key === 'sliceIndex') return 0;
          return null;
        },
      },
    },
  };
}

async function scan(regions) {
  const fixture = makeApp(regions);
  const result = await createProductSurfaceQueries(fixture.app).strings(SNAPSHOT, {}, { offset: 0, limit: 20 });
  return { result, calls: fixture.calls };
}

{
  const { result, calls } = await scan([{ id: 'small', section: '__cstring', cstrings: true, size: 1024n }]);
  assert.equal(result.completeness, 'complete');
  assert.equal(result.status.totalRegions, 1);
  assert.deepEqual(result.status.partiallyScannedRegions, []);
  assert.deepEqual(result.status.unscannedRegions, []);
  assert.equal(calls.length, 1);
}

{
  const { result, calls } = await scan([{ id: 'big', section: '__cstring', cstrings: true, size: 128n * 1024n * 1024n }]);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.status.totalRegions, 1, 'a partial region is counted once');
  assert.deepEqual(result.status.partiallyScannedRegions, ['big']);
  assert.deepEqual(result.status.unscannedRegions, [], 'partial coverage is not mislabeled as fully unscanned');
  assert.equal(calls[0].maxBytes, 64 * 1024 * 1024);
}

{
  const { result } = await scan([
    { id: 'full', section: '__cstring', cstrings: true, size: 32n * 1024n * 1024n },
    { id: 'partial', section: '__cstring', cstrings: true, size: 64n * 1024n * 1024n },
  ]);
  assert.equal(result.status.totalRegions, 2);
  assert.deepEqual(result.status.partiallyScannedRegions, ['partial']);
  assert.deepEqual(result.status.unscannedRegions, []);
}

{
  const { result } = await scan([
    { id: 'partial', section: '__cstring', cstrings: true, size: 128n * 1024n * 1024n },
    { id: 'skipped', section: '__cstring', cstrings: true, size: 1024n },
  ]);
  assert.equal(result.status.totalRegions, 2);
  assert.deepEqual(result.status.partiallyScannedRegions, ['partial']);
  assert.deepEqual(result.status.unscannedRegions, ['skipped']);
}

console.log('issue-4506-product-surface-region-accounting: ok');

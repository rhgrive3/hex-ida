import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

// #5772: the multi-region shapes cache keyed scans by `${epoch}:${region.id}`
// while handing the raw region.id to the backend. Template-literal coercion
// (`['text']` → `'text'`) made a malformed region's cached shape result
// reusable for the canonical region, and the combined key hid the difference.
// Region ids must be canonical strings end to end.

function shapesApp(producerIds, currentRegion) {
  return {
    backend: {
      gen: 1,
      valueShapes(regionId) {
        producerIds.push(regionId);
        return Promise.resolve([]);
      },
    },
    programRegions() { return [currentRegion.region]; },
  };
}

test('shapes scans never hand a structured region id to the backend (#5772)', async () => {
  const producerIds = [];
  const currentRegion = { region:{ id:['text'], exec:true, size:4n } };
  const app = shapesApp(producerIds, currentRegion);
  installDemandDrivenAnalysis(app);

  await app.ensureShapes();
  assert.deepEqual(producerIds, [], 'a region without a canonical string id must not be scanned');

  currentRegion.region = { id:'text', exec:true, size:4n };
  await app.ensureShapes();
  assert.deepEqual(producerIds, ['text'], 'the canonical region id reaches the backend verbatim');
});

test('a canonical region never reuses a structured region id scan result (#5772)', async () => {
  const producerIds = [];
  const currentRegion = { region:{ id:['text'], exec:true, size:4n } };
  const app = shapesApp(producerIds, currentRegion);
  installDemandDrivenAnalysis(app);

  const malformedShapes = await app.ensureShapes();
  currentRegion.region = { id:'text', exec:true, size:4n };
  const canonicalShapes = await app.ensureShapes();
  // On main the second call returned the first call's pinned shapes object
  // because both regions collapsed onto the combined key `1:text`.
  assert.notEqual(canonicalShapes, malformedShapes, 'the canonical region must get its own scan result');
  assert.deepEqual(producerIds, ['text']);
});

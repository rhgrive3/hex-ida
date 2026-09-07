import assert from 'node:assert/strict';
import test from 'node:test';

import { createHexAIContext } from '../js/ai/ui/hex-context-query-base.js';

function contextWithRegions(regions, searchByRegion) {
  const app = {
    analysisArtifactVersions: {},
    analysisQueries: {
      async snapshot() { return { id: 'snap-1', artifactVersions: {} }; },
      async binaryInfo() {
        return { value: { regions }, status: { completeness: 'complete' } };
      },
      async search(_snapshot, query) {
        return searchByRegion(query.regionId);
      },
    },
  };
  return createHexAIContext(app);
}

test('#5800 an unsupported region search producer fails the aggregate complete flag', async () => {
  const context = contextWithRegions([{ id: 'A' }, { id: 'B' }], (regionId) => {
    if (regionId === 'A') return { completeness: 'unsupported', value: null, page: { total: null } };
    return { completeness: 'complete', value: [], page: { total: 0 } };
  });
  const out = await context.searchStrings('needle', { limit: 10 });
  assert.equal(out.complete, false, 'an entire unsearched region must block completeness');
  assert.equal(out.truncated, true);
});

test('#5800 fully supported complete searches stay complete', async () => {
  const context = contextWithRegions([{ id: 'A' }, { id: 'B' }], () => ({
    completeness: 'complete', value: [], page: { total: 0 },
  }));
  const out = await context.searchStrings('needle', { limit: 10 });
  assert.equal(out.complete, true);
  assert.equal(out.truncated, false);
});

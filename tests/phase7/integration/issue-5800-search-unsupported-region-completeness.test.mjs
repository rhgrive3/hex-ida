import assert from 'node:assert/strict';
import test from 'node:test';

import { createHexAIContext } from '../../../js/ai/ui/hex-context-query-base.js';
import { createHexAIContext as createFacadeHexAIContext } from '../../../js/ai/ui/hex-context.js';

function contextWithRegions(regions, searchByRegion, createContext = createHexAIContext) {
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
  return createContext(app);
}

for (const [label, createContext] of [
  ['base', createHexAIContext],
  ['facade', createFacadeHexAIContext],
]) {
  test(`#5800 ${label} preserves partial results and the unsupported reason`, async () => {
    const context = contextWithRegions([{ id: 'A' }, { id: 'B' }], (regionId) => {
      if (regionId === 'A') {
        return {
          completeness: 'unsupported', value: null, page: { total: null },
          status: { completeness: 'unsupported', reason: 'typed-search-not-supported-for-A' },
        };
      }
      return {
        completeness: 'complete',
        value: [{ address: '0x2000', text: 'needle' }],
        page: { total: 1 },
      };
    }, createContext);
    const out = await context.searchStrings('needle', { limit: 10 });
    assert.equal(out.complete, false, 'an entire unsearched region must block completeness');
    assert.equal(out.truncated, true);
    assert.equal(out.total, null, 'an incomplete aggregate cannot publish a total');
    assert.equal(out.reason, 'typed-search-not-supported-for-A');
    assert.deepEqual(out.results.map((row) => row.regionId), ['B']);
  });

  test(`#5800 ${label} is invariant to unsupported region order`, async () => {
    const search = (regionId) => regionId === 'B'
      ? { completeness: 'unsupported', value: null, page: { total: null }, reason: 'region-B-unavailable' }
      : { completeness: 'complete', value: [], page: { total: 0 } };
    const first = await contextWithRegions([{ id: 'A' }, { id: 'B' }], search, createContext)
      .searchStrings('needle', { limit: 10 });
    const second = await contextWithRegions([{ id: 'B' }, { id: 'A' }], search, createContext)
      .searchStrings('needle', { limit: 10 });
    assert.deepEqual(
      { complete: first.complete, truncated: first.truncated, total: first.total, reason: first.reason },
      { complete: second.complete, truncated: second.truncated, total: second.total, reason: second.reason },
    );
  });

  test(`#5800 ${label} fully supported complete searches stay complete`, async () => {
    const context = contextWithRegions([{ id: 'A' }, { id: 'B' }], () => ({
      completeness: 'complete', value: [], page: { total: 0 },
    }), createContext);
    const out = await context.searchStrings('needle', { limit: 10 });
    assert.equal(out.complete, true);
    assert.equal(out.truncated, false);
    assert.equal(out.total, 0);
  });
}

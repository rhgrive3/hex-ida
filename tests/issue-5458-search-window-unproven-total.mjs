// Regression for #5458: a partial/truncated region's page.total counts only
// materialized rows, so it cannot prove the requested global offset lies
// beyond that region. Skipping into later regions on that basis fabricated
// the global window position.
import assert from 'node:assert/strict';
import { createHexAIContext } from '../js/ai/ui/hex-context.js';
import { createHexAIContext as createHexAIContextQueryBase } from '../js/ai/ui/hex-context-query-base.js';

function createMockApp() {
  const app = {
    analysisArtifactVersions: {},
    analysisQueries: {
      async snapshot() { return { id: 'snap-1', artifactVersions: {} }; },
      async binaryInfo() {
        return {
          value: { regions: [
            { id: 'rA', vmAddr: 0x1000n, size: 0x8000n },
            { id: 'rB', vmAddr: 0x10000n, size: 0x8000n },
          ] },
          status: { completeness: 'complete' },
        };
      },
      async search(_snapshot, query, page = {}) {
        if (query.regionId === 'rA') {
          const all = Array.from({ length: 100 }, (_, i) => ({ addr: BigInt(0x1000 + i * 4), text: `A_${i}` }));
          const offset = Math.max(0, Number(page.offset) || 0);
          const limit = Math.max(1, Number(page.limit) || 50);
          // Producer cap: only the first 50 matches are materialized. A page
          // beyond the cap returns no rows; page.total reports the
          // materialized count (50), not the true total (100).
          const slice = offset < 50 ? all.slice(offset, Math.min(offset + limit, 50)) : [];
          return {
            value: slice,
            page: { offset, limit, returned: slice.length, total: 50 },
            status: { completeness: 'partial', reason: 'search-result-cap' },
          };
        }
        const all = Array.from({ length: 30 }, (_, i) => ({ addr: BigInt(0x10000 + i * 4), text: `B_${i}` }));
        const offset = Math.max(0, Number(page.offset) || 0);
        const limit = Math.max(1, Number(page.limit) || 50);
        const slice = all.slice(offset, offset + limit);
        return {
          value: slice,
          page: { offset, limit, returned: slice.length, total: all.length },
          status: { completeness: 'complete' },
        };
      },
    },
  };
  return app;
}

function createProvenApp() {
  const app = {
    analysisArtifactVersions: {},
    analysisQueries: {
      async snapshot() { return { id: 'snap-1', artifactVersions: {} }; },
      async binaryInfo() {
        return {
          value: { regions: [
            { id: 'rA', vmAddr: 0x1000n, size: 0x8000n },
            { id: 'rB', vmAddr: 0x10000n, size: 0x8000n },
          ] },
          status: { completeness: 'complete' },
        };
      },
      async search(_snapshot, query, page = {}) {
        const count = query.regionId === 'rA' ? 30 : 30;
        const all = Array.from({ length: count }, (_, i) => ({
          addr: BigInt((query.regionId === 'rA' ? 0x1000 : 0x10000) + i * 4),
          text: `${query.regionId === 'rA' ? 'A' : 'B'}_${i}`,
        }));
        const offset = Math.max(0, Number(page.offset) || 0);
        const limit = Math.max(1, Number(page.limit) || 50);
        const slice = all.slice(offset, offset + limit);
        return {
          value: slice,
          page: { offset, limit, returned: slice.length, total: all.length },
          status: { completeness: 'complete' },
        };
      },
    },
  };
  return app;
}

for (const [name, create] of [['hex-context', createHexAIContext], ['query-base', createHexAIContextQueryBase]]) {
  const ctx = create(createMockApp());

  // Global offset 60 lies inside region A (100 true matches), but its
  // materialized total is only 50: the window position is unproven and the
  // result must stop truncated instead of serving region B rows.
  const res = await ctx.searchStrings('x', { offset: 60, limit: 10 });
  assert.equal(res.results.length, 0, `${name}: an unproven partial region must not serve later-region rows`);
  assert.equal(res.complete, false);
  assert.equal(res.truncated, true);

  // Rows inside the materialized prefix still stream normally.
  const head = await ctx.searchStrings('x', { offset: 10, limit: 5 });
  assert.deepEqual(head.results.map((row) => row.text), ['A_10', 'A_11', 'A_12', 'A_13', 'A_14'], `${name}: in-window rows keep streaming`);

  // A complete region with a proven total still advances the global offset.
  const proven = await create(createProvenApp()).searchStrings('x', { offset: 55, limit: 5 });
  assert.deepEqual(proven.results.map((row) => row.text), ['B_25', 'B_26', 'B_27', 'B_28', 'B_29'], `${name}: proven totals keep skipping into later regions`);
  assert.equal(proven.complete, true, 'a fully proven window completes');
  assert.equal(proven.total, 60);
}

console.log('issue #5458 unproven region-total window regressions PASS');

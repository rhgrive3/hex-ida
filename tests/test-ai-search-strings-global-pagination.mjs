import assert from "node:assert/strict";
import { createHexAIContext } from "../js/ai/ui/hex-context.js";
import { createHexAIContext as createHexAIContextQueryBase } from "../js/ai/ui/hex-context-query-base.js";

console.log("Testing Issue #2565 AI search_strings global pagination regressions...");

// Mock app with search API
function createMockApp(regionConfigs) {
  let searchCalls = 0;
  let totalRowsMaterialized = 0;

  const app = {
    analysisArtifactVersions: {},
    analysisQueries: {
      async snapshot(options) {
        if (options?.signal?.aborted) throw new Error("aborted");
        return { id: "snap-1", artifactVersions: {} };
      },
      async binaryInfo(snapshot, options) {
        return {
          value: {
            regions: regionConfigs.map(r => ({ id: r.id, vmAddr: r.vmAddr, size: r.size }))
          },
          status: { completeness: "complete" }
        };
      },
      async search(snapshot, query, page = {}, options = {}) {
        searchCalls++;
        if (options.signal?.aborted) throw new Error("aborted");
        const region = regionConfigs.find(r => r.id === query.regionId);
        if (!region) return { value: [], page: { offset: 0, limit: 0, returned: 0, total: 0 }, status: { completeness: "complete" } };
        
        const allMatches = region.matches || [];
        const offset = Math.max(0, Number(page.offset) || 0);
        const limit = Math.max(1, Number(page.limit) || 50);
        const slice = allMatches.slice(offset, offset + limit);
        totalRowsMaterialized += slice.length;

        return {
          value: slice,
          page: {
            offset,
            limit,
            returned: slice.length,
            total: allMatches.length,
            next: offset + slice.length < allMatches.length ? offset + slice.length : null
          },
          status: { completeness: region.completeness || "complete", reason: region.reason || null }
        };
      }
    },
    getSearchCalls: () => searchCalls,
    getTotalRowsMaterialized: () => totalRowsMaterialized,
    resetStats: () => { searchCalls = 0; totalRowsMaterialized = 0; }
  };

  return app;
}

// 1. Test >5000 matches traversal (7000 matches across 2 regions: 4000 in R1, 3000 in R2)
{
  const r1Matches = Array.from({ length: 4000 }, (_, i) => ({ addr: BigInt(0x1000 + i * 4), text: "str_" + i }));
  const r2Matches = Array.from({ length: 3000 }, (_, i) => ({ addr: BigInt(0x10000 + i * 4), text: "str_" + (4000 + i) }));

  const app = createMockApp([
    { id: "r1", vmAddr: 0x1000n, size: 0x8000n, matches: r1Matches },
    { id: "r2", vmAddr: 0x10000n, size: 0x8000n, matches: r2Matches }
  ]);

  const ctx = createHexAIContext(app);

  const allTraversed = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const res = await ctx.searchStrings("str_", { offset, limit });
    for (const r of res.results) {
      allTraversed.push(r.text);
    }
    if (res.complete) break;
    assert.ok(res.results.length > 0, "Non-complete page must return rows");
    offset += res.results.length;
  }

  assert.equal(allTraversed.length, 7000, "Must traverse all 7000 matches past 5000 boundary");
  assert.equal(allTraversed[0], "str_0");
  assert.equal(allTraversed[4999], "str_4999");
  assert.equal(allTraversed[5000], "str_5000");
  assert.equal(allTraversed[6999], "str_6999");

  // Check no quadratic search calls
  const calls = app.getSearchCalls();
  console.log("  Search calls for 7000 matches (140 pages):", calls);
  // For 140 pages, linear traversal makes ~140-280 search calls, NOT 140*140 = 19600 calls
  assert.ok(calls < 350, "Search calls must scale linearly with pages");
}

// 2. Exact boundary tests: 4999, 5000, 5001 matches
for (const count of [4999, 5000, 5001]) {
  const matches = Array.from({ length: count }, (_, i) => ({ addr: BigInt(0x1000 + i * 4), text: "s_" + i }));
  const app = createMockApp([{ id: "r1", vmAddr: 0x1000n, size: BigInt(count * 4), matches }]);
  const ctx = createHexAIContext(app);

  const traversed = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const res = await ctx.searchStrings("s_", { offset, limit });
    for (const r of res.results) traversed.push(r.text);
    if (res.complete) {
      assert.equal(res.total, count);
      break;
    }
    offset += res.results.length;
  }

  assert.equal(traversed.length, count);
  // Check uniqueness & order
  for (let i = 0; i < count; i++) {
    assert.equal(traversed[i], "s_" + i);
  }
}

// 3. Multi-region boundary: R1 has 20 matches, R2 has 30 matches. Page size 50 spans both.
{
  const r1 = Array.from({ length: 20 }, (_, i) => ({ addr: BigInt(0x1000 + i), text: "R1_" + i }));
  const r2 = Array.from({ length: 30 }, (_, i) => ({ addr: BigInt(0x2000 + i), text: "R2_" + i }));
  const app = createMockApp([
    { id: "r1", vmAddr: 0x1000n, size: 100n, matches: r1 },
    { id: "r2", vmAddr: 0x2000n, size: 100n, matches: r2 }
  ]);
  const ctx = createHexAIContext(app);

  const page = await ctx.searchStrings("R", { offset: 0, limit: 50 });
  assert.equal(page.results.length, 50);
  assert.equal(page.complete, true);
  assert.equal(page.total, 50);
  assert.equal(page.results[0].text, "R1_0");
  assert.equal(page.results[19].text, "R1_19");
  assert.equal(page.results[20].text, "R2_0");
  assert.equal(page.results[49].text, "R2_29");
}

// 4. Cancellation test: AbortSignal stops traversal immediately
{
  const controller = new AbortController();
  controller.abort("test-abort");
  const app = createMockApp([{ id: "r1", vmAddr: 0x1000n, size: 100n, matches: [{ addr: 0x1000n, text: "abc" }] }]);
  const ctx = createHexAIContext(app);

  await assert.rejects(
    async () => ctx.searchStrings("abc", { signal: controller.signal }),
    /test-abort|aborted/
  );
}

// 5. Incomplete region does not mark global complete
{
  const app = createMockApp([
    { id: "r1", vmAddr: 0x1000n, size: 100n, matches: [{ addr: 0x1000n, text: "match1" }], completeness: "partial", reason: "scan-budget" }
  ]);
  const ctx = createHexAIContext(app);
  const res = await ctx.searchStrings("match", { offset: 0, limit: 10 });
  assert.equal(res.complete, false);
  assert.equal(res.truncated, true);
  assert.equal(res.reason, "scan-budget");
}

// 6. HexContextQueryBase parity
{
  const r1Matches = Array.from({ length: 4000 }, (_, i) => ({ addr: BigInt(0x1000 + i * 4), text: "qb_" + i }));
  const r2Matches = Array.from({ length: 3000 }, (_, i) => ({ addr: BigInt(0x10000 + i * 4), text: "qb_" + (4000 + i) }));

  const app = createMockApp([
    { id: "r1", vmAddr: 0x1000n, size: 0x8000n, matches: r1Matches },
    { id: "r2", vmAddr: 0x10000n, size: 0x8000n, matches: r2Matches }
  ]);

  const ctx = createHexAIContextQueryBase(app);
  const page1 = await ctx.searchStrings("qb_", { offset: 0, limit: 50 });
  assert.equal(page1.results.length, 50);
  assert.equal(page1.results[0].text, "qb_0");
  assert.equal(page1.complete, false);

  const page101 = await ctx.searchStrings("qb_", { offset: 5000, limit: 50 });
  assert.equal(page101.results.length, 50);
  assert.equal(page101.results[0].text, "qb_5000");
  assert.equal(page101.complete, false);
}

console.log("Issue #2565 AI search_strings global pagination regressions PASS!");

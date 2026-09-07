import assert from 'node:assert/strict';
import { createHexAIContext } from '../../../js/ai/ui/hex-context-legacy.js';

function baseApp() {
  return {
    store: { get() { return null; } },
    async ensureRecognition() {},
  };
}

{
  const app = {
    ...baseApp(),
    recognition: { records: [] },
    async ensureStrings() {
      return [
        { text:'x0', addr:0x10n },
        { text:'other', addr:0x15n },
        { text:'x1', addr:0x20n },
        { text:'x2', addr:0x30n },
      ];
    },
  };
  const ctx = createHexAIContext(app);
  for (const [offset, expected] of [[0, 'x0'], [1, 'x1'], [2, 'x2']]) {
    const page = await ctx.searchStrings('x', { limit:1, offset });
    assert.deepEqual(page.map((row) => row.text), [expected], `string offset ${offset}`);
  }
  const exhaustedStrings = await ctx.searchStrings('x', { limit:1, offset:3 });
  assert.deepEqual(exhaustedStrings.map((row) => row.text), []);
  assert.equal(exhaustedStrings.offset, 3, 'exhausted pages still report their page origin');
}

{
  const records = [
    { address:0x1000n, name:'f0', score:3 },
    { address:0x1100n, name:'other', score:2 },
    { address:0x1200n, name:'f1', score:1 },
    { address:0x1300n, name:'f2', score:0 },
  ];
  const app = {
    ...baseApp(),
    recognition: {
      records,
      complete:true,
      scannedCount:records.length,
      total:records.length,
    },
  };
  const ctx = createHexAIContext(app);
  for (const [offset, expected] of [[0, 'f0'], [1, 'f1'], [2, 'f2']]) {
    const page = await ctx.searchFunctions('f', { limit:1, offset });
    assert.deepEqual(page.map((row) => row.name), [expected], `recognition offset ${offset}`);
  }
  const last = await ctx.searchFunctions('f', { limit:1, offset:2 });
  assert.equal(last.complete, true);
  assert.equal(last.truncationReason, null);
  const exhausted = await ctx.searchFunctions('f', { limit:1, offset:3 });
  assert.deepEqual([...exhausted], []);
  assert.equal(exhausted.complete, true);
}

{
  const app = {
    ...baseApp(),
    recognition: { records: [] },
    symbols: {
      names:['f0', 'other', 'f1', 'f2'],
      addrs:[0x2000n, 0x2100n, 0x2200n, 0x2300n],
    },
  };
  const ctx = createHexAIContext(app);
  for (const [offset, expected] of [[0, 'f0'], [1, 'f1'], [2, 'f2']]) {
    const page = await ctx.searchFunctions('f', { limit:1, offset });
    assert.deepEqual(page.map((row) => row.name), [expected], `symbol offset ${offset}`);
  }
  const last = await ctx.searchFunctions('f', { limit:1, offset:2 });
  assert.equal(last.complete, true);
  assert.equal(last.truncationReason, null);
  const exhausted = await ctx.searchFunctions('f', { limit:1, offset:3 });
  assert.deepEqual([...exhausted], []);
  assert.equal(exhausted.complete, true);
}

// Native offset paging metadata: the adapter must report its page origin so the
// tool registry can page directly instead of re-scanning a capped prefix.
{
  const rows = Array.from({ length: 250 }, (_, i) => ({ text:`x${i}`, addr:0x1000n + BigInt(i) }));
  const app = { ...baseApp(), recognition: { records: [] }, async ensureStrings() { return rows; } };
  const ctx = createHexAIContext(app);
  const deep = await ctx.searchStrings('x', { limit:5, offset:240 });
  assert.deepEqual(deep.map((row) => row.text), ['x240','x241','x242','x243','x244'], 'offset >= 200 must page natively, not return an empty prefix page');
  assert.equal(deep.offset, 240);
  assert.equal(deep.matchCount, 250);
  const beyond = await ctx.searchStrings('x', { limit:5, offset:250 });
  assert.deepEqual([...beyond], []);
  assert.equal(beyond.offset, 250);
  assert.equal(beyond.matchCount, 250, 'all 250 rows still match the query beyond the exhausted page');
}

// Completion metadata must satisfy the registry pagination contract: total is
// the matching-result count (when known), and a final page must not emit a
// continuation cursor through searchPage().
{
  const records = [
    { address:0x3000n, name:'m0', score:1 },
    { address:0x3100n, name:'noise', score:1 },
    { address:0x3200n, name:'m1', score:1 },
    { address:0x3300n, name:'m2', score:1 },
  ];
  const app = {
    ...baseApp(),
    recognition: { records, complete:true, scannedCount:records.length, total:records.length },
  };
  const ctx = createHexAIContext(app);
  const finalPage = await ctx.searchFunctions('m', { limit:2, offset:2 });
  assert.deepEqual(finalPage.map((row) => row.name), ['m2'], 'offset 2 skips m0 and m1; the final page holds only m2');
  assert.equal(finalPage.matchCount, 3, 'matchCount counts query matches, not the corpus');
  assert.equal(finalPage.complete, true);
  assert.equal(finalPage.truncationReason, null);
  const { createHexToolRegistry } = await import('../../../js/ai/tools/registry-base.js');
  const registry = createHexToolRegistry({ searchFunctions:(q, o) => ctx.searchFunctions(q, o) });
  const first = (await registry.execute('search_functions', { query:'m', limit:2 })).result;
  assert.deepEqual(first.results.map((row) => row.name), ['m0','m1']);
  assert.equal(first.total, 3);
  assert.equal(first.complete, false);
  assert.ok(first.continuation, 'a non-final page must emit a continuation cursor');
  const second = (await registry.execute('search_functions', { query:'m', limit:2, cursor: first.continuation.cursor })).result;
  assert.equal(second.total, 3, 'registry total must be the matching-result count');
  assert.equal(second.complete, true);
  assert.equal(second.truncated, false);
  assert.equal(second.continuation, undefined, 'final page must not emit a continuation cursor');
  assert.deepEqual(second.results.map((row) => row.name), ['m2'], 'offset 2 with lookahead limit 3 yields only the final row');
}

console.log('issue-3707-ai-legacy-pagination: ok');

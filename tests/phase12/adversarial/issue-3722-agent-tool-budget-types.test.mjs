import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentToolError, createAgentTools } from '../../../js/agent/tools.js';

const structuredBudgets = [
  ['1'],
  '1',
  true,
  [],
  { valueOf: () => 1 },
];

test('issue #3722 - structured top-level budgets fall back instead of becoming authority', () => {
  for (const value of structuredBudgets) {
    const tools = createAgentTools({ analyze: async () => null }, {
      maxFunctions: value,
      summaryCache: value,
      summaryDepth: value,
    });
    assert.equal(tools.__loader.maxFunctions, 64);
    assert.equal(tools.__summaries.maxEntries, 128);
    assert.equal(tools.__summaries.maxDepth, 3);
  }
});

test('issue #3722 - malformed maxFunctions cannot shrink function-analysis coverage', async () => {
  for (const value of structuredBudgets) {
    let analyzed = 0;
    const tools = createAgentTools({
      analyze: async () => { analyzed++; return null; },
    }, { maxFunctions: value });
    await tools.get_function(0x1000);
    await tools.get_function(0x2000);
    assert.equal(analyzed, 2);
  }
});

test('issue #3722 - structured per-tool limits use the canonical fallback', async () => {
  const seen = [];
  const tools = createAgentTools({
    searchStrings: async (_query, options) => {
      seen.push(options.limit);
      return [];
    },
  });
  for (const limit of structuredBudgets) await tools.search_strings('needle', { limit });
  assert.deepEqual(seen, structuredBudgets.map(() => 50));
});

test('issue #3722 - finite primitive numbers preserve floor and clamp semantics', async () => {
  const tools = createAgentTools({ analyze: async () => null }, {
    maxFunctions: 2.9,
    summaryCache: 20.9,
    summaryDepth: 4.9,
  });
  assert.equal(tools.__loader.maxFunctions, 2);
  assert.equal(tools.__summaries.maxEntries, 20);
  assert.equal(tools.__summaries.maxDepth, 4);

  await tools.get_function(0x1000);
  await tools.get_function(0x2000);
  await assert.rejects(
    tools.get_function(0x3000),
    (error) => error instanceof AgentToolError && error.code === 'function-budget',
  );

  let limit = null;
  const searchTools = createAgentTools({
    searchStrings: async (_query, options) => { limit = options.limit; return []; },
  });
  await searchTools.search_strings('needle', { limit: 2.9 });
  assert.equal(limit, 2);
  await searchTools.search_strings('needle', { limit: -10 });
  assert.equal(limit, 1);
  await searchTools.search_strings('needle', { limit: 500 });
  assert.equal(limit, 200);
});

test('issue #3722 - nullish and non-finite values retain existing defaults', async () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity]) {
    const tools = createAgentTools({ analyze: async () => null }, {
      maxFunctions: value,
      summaryCache: value,
      summaryDepth: value,
    });
    assert.equal(tools.__loader.maxFunctions, 64);
    assert.equal(tools.__summaries.maxEntries, 128);
    assert.equal(tools.__summaries.maxDepth, 3);
  }

  let limit = null;
  const tools = createAgentTools({
    searchStrings: async (_query, options) => { limit = options.limit; return []; },
  });
  for (const value of [undefined, null, NaN, Infinity, -Infinity]) {
    await tools.search_strings('needle', { limit: value });
    assert.equal(limit, 50);
  }
});

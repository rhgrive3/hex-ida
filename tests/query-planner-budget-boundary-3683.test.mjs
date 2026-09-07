import assert from 'node:assert/strict';
import test from 'node:test';

import { planAnalysisGoal } from '../js/query/planner.js';

const EMPTY_QUERY = Object.freeze({
  action: 'read',
  entity: { terms: [] },
  context: { terms: [] },
  event: { terms: [] },
});

async function plan(options = {}, context = {}) {
  return planAnalysisGoal(EMPTY_QUERY, context, { tools: {}, ...options });
}

test('#3683 rejects non-primitive function budgets instead of coercing them', async () => {
  for (const value of [['1'], [], '1', true, false]) {
    const result = await plan({ maxFunctions: value });
    assert.equal(result.budget.requested.functions, 48);
    assert.equal(result.budget.planner.functions, 19);
  }
});

test('#3683 keeps finite primitive budget floor/clamp semantics', async () => {
  const result = await plan({
    maxFunctions: 7.9,
    maxDisassembly: 1000.9,
    plannerBudgetFraction: 0.5,
  });

  assert.deepEqual(result.budget.requested, { functions: 7, disassembly: 1000 });
  assert.deepEqual(result.budget.planner, { functions: 3, disassembly: 500 });
});

test('#3683 rejects structured plannerBudgetFraction authority', async () => {
  const structured = await plan({ maxFunctions: 10, maxDisassembly: 1000, plannerBudgetFraction: ['0.8'] });
  assert.deepEqual(structured.budget.planner, { functions: 4, disassembly: 400 });

  const primitive = await plan({ maxFunctions: 10, maxDisassembly: 1000, plannerBudgetFraction: 0.8 });
  assert.deepEqual(primitive.budget.planner, { functions: 8, disassembly: 800 });
});

test('#3683 rejects structured maxSearchResults rather than shrinking search coverage', async () => {
  const limits = [];
  const query = { ...EMPTY_QUERY, entity: { terms: ['needle'] } };
  const tools = {
    search_functions(_term, options) { limits.push(options.limit); return { results: [], complete: true }; },
    search_strings(_term, options) { limits.push(options.limit); return { results: [], complete: true }; },
  };

  await planAnalysisGoal(query, {}, { tools, maxSearchResults: ['2'] });
  assert.deepEqual(limits, [40, 40]);
});

test('#3683 rejects structured maxExpansions rather than disabling graph expansion', async () => {
  let callers = 0;
  let callees = 0;
  const tools = {
    get_callers() { callers++; return { results: [] }; },
    get_callees() { callees++; return { results: [] }; },
    get_function() { return { found: false }; },
    get_semantic_facts() { return { results: [], complete: true }; },
  };
  const context = { candidateFunctions: [{ address: 0x1000n, score: 1 }] };

  await planAnalysisGoal(EMPTY_QUERY, context, { tools, maxExpansions: [] });
  assert.equal(callers, 1);
  assert.equal(callees, 1);
});

test('#3683 rejects structured timeoutMs instead of laundering it into a 1ms deadline', async () => {
  const query = { ...EMPTY_QUERY, entity: { terms: ['needle'] } };
  const tools = {
    async search_functions() {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { results: [], complete: true };
    },
    search_strings() { return { results: [], complete: true }; },
  };

  const result = await planAnalysisGoal(query, {}, { tools, timeoutMs: ['1'] });
  assert.equal(result.missingEvidence.includes('timeout'), false);
  assert.equal(result.completeness.reason, null);
});

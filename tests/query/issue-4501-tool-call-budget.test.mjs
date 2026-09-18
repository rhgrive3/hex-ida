import assert from 'node:assert/strict';
import test from 'node:test';

import { planAnalysisGoal } from '../../js/query/planner.js';

function contextWithCalls(calls) {
  return {
    async searchFunctions(term) {
      calls.push(['search_functions', term]);
      return [];
    },
    async searchStrings(term) {
      calls.push(['search_strings', term]);
      return [];
    },
  };
}

for (const limit of [0, 1, 3]) {
  test(`#4501 planner consumes at most maxToolCalls=${limit}`, async () => {
    const calls = [];
    const plan = await planAnalysisGoal('find password check', contextWithCalls(calls), {
      maxToolCalls: limit,
      maxFunctions: 8,
      maxDisassembly: 1024,
      timeoutMs: 1_000,
    });
    assert.equal(calls.length, limit);
    assert.equal(plan.stats.toolCalls, limit);
    assert.ok(plan.missingEvidence.includes('tool-call-budget'));
  });
}

test('#4501 planner leaves a shared budget untouched when it is already exhausted', async () => {
  const calls = [];
  const shared = {
    limit: 1,
    used: 1,
    remaining() { return 0; },
    consume() { throw new Error('consume must not be called after exhaustion'); },
  };
  const plan = await planAnalysisGoal('find password check', contextWithCalls(calls), {
    toolCallBudget: shared,
    timeoutMs: 1_000,
  });
  assert.equal(calls.length, 0);
  assert.equal(plan.stats.toolCalls, 1);
  assert.ok(plan.missingEvidence.includes('tool-call-budget'));
});

console.log('issue-4501 query planner tool-call budget: PASS');

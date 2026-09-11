import assert from 'node:assert/strict';
import { runAgent } from '../js/agent/runtime.js';

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

{
  const calls = [];
  let llmCalls = 0;
  const result = await runAgent({
    goal: 'find password check',
    context: contextWithCalls(calls),
    llm: { async next() { llmCalls += 1; throw new Error('maxToolCalls=0 must skip the model loop'); } },
    budget: { maxToolCalls: 0, maxFunctions: 8, maxDisassembly: 1024, timeoutMs: 1_000 },
  });
  assert.equal(llmCalls, 0);
  assert.equal(calls.length, 0, 'zero tool budget must also block the final planner');
  assert.equal(result.stats.toolCalls, 0);
  assert.equal(result.plan.stats.toolCalls, 0);
  assert.ok(result.missingEvidence.includes('tool-call-budget'));
}

{
  const calls = [];
  let llmCalls = 0;
  const result = await runAgent({
    goal: 'find password check',
    context: contextWithCalls(calls),
    llm: {
      async next({ observations }) {
        llmCalls += 1;
        return observations.length ? { answer: { confidence: 0 } } : { tool: 'search_strings', args: ['password'] };
      },
    },
    budget: { maxToolCalls: 1, maxFunctions: 8, maxDisassembly: 1024, timeoutMs: 1_000 },
  });
  assert.equal(llmCalls, 1);
  assert.equal(calls.length, 1, 'the final planner must not add a call after the LLM consumed the budget');
  assert.equal(result.observations.length, 1);
  assert.equal(result.stats.toolCalls, 1);
  assert.equal(result.plan.stats.toolCalls, 1);
}

{
  const calls = [];
  const result = await runAgent({
    goal: 'find password check',
    context: contextWithCalls(calls),
    llm: {
      async next({ observations }) {
        return observations.length ? { answer: { confidence: 0 } } : { tool: 'search_strings', args: ['password'] };
      },
    },
    budget: { maxToolCalls: 2, maxFunctions: 8, maxDisassembly: 1024, timeoutMs: 1_000 },
  });
  assert.equal(calls.length, 2, 'LLM and final planner calls must share one total budget');
  assert.equal(result.observations.length, 1);
  assert.equal(result.stats.toolCalls, 2);
  assert.equal(result.plan.stats.toolCalls, 2);
  assert.ok(result.missingEvidence.includes('tool-call-budget'));
}

console.log('issue-4501 agent runtime tool-call budget: PASS');

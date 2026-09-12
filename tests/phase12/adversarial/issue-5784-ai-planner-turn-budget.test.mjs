import assert from 'node:assert/strict';
import { AIRuntime } from '../../../js/ai/runtime.js';

function completeEmpty() {
  return { results: [], returned: 0, total: 0, complete: true, truncated: false };
}

function blankPlan() {
  return {
    query: {}, candidates: [], best: null, evidence: [], missingEvidence: [],
    exhausted: false, partial: false,
    stats: { analyzedFunctions: 0, candidateFunctions: 0, disassembly: 0, toolCalls: 0 },
  };
}

function contextWithSearchCounter(counter) {
  return {
    binaryId: 'issue-5784',
    functions: [],
    searchFunctions: async () => { counter.count += 1; return completeEmpty(); },
    searchStrings: async () => { counter.count += 1; return completeEmpty(); },
  };
}

function onePlannerSearch() {
  return async (_goal, _context, options) => {
    await options.tools.search_functions('planner', { limit: 1 });
    return blankPlan();
  };
}

function toolThenFinalProvider() {
  let calls = 0;
  return {
    async nextTurn() {
      calls += 1;
      if (calls === 1) return { type: 'tool', tool: 'search_functions', arguments: { query: 'model', limit: 1 } };
      return { type: 'final', answer: 'done', confidence: 0.5, evidenceIds: [], hypotheses: [], suggestedActions: [], followups: [] };
    },
  };
}

{
  const counter = { count: 0 };
  const runtime = new AIRuntime({ context: contextWithSearchCounter(counter), provider: null });
  const result = await runtime.turn({
    mode: 'agent', goal: 'find function password_check',
    budget: { maxToolCalls: 0, maxCost: 160, maxFunctions: 4, maxDisassembly: 100, timeoutMs: 2_000 },
  });
  assert.equal(counter.count, 0, 'maxToolCalls=0 must prevent deterministic-planner tool execution');
  assert.equal(result.usage.toolCalls, 0);
  assert.equal(result.usage.toolCost, 0);
  assert.equal(result.limits.reason, 'tool-call-budget');
}

{
  const counter = { count: 0 };
  const runtime = new AIRuntime({ context: contextWithSearchCounter(counter), provider: null });
  const result = await runtime.turn({
    mode: 'agent', goal: 'find function password_check',
    budget: { maxToolCalls: 1, maxCost: 160, maxFunctions: 4, maxDisassembly: 100, timeoutMs: 2_000 },
  });
  assert.equal(counter.count, 1, 'the last permitted planner call must finish before final usage is sampled');
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.usage.toolCost, 1);
  assert.equal(result.limits.reason, 'tool-call-budget');
}

{
  const counter = { count: 0 };
  const runtime = new AIRuntime({ context: contextWithSearchCounter(counter), provider: null });
  let capturedPlan = null;
  const ingestPlan = runtime.evidenceStore.ingestPlan.bind(runtime.evidenceStore);
  runtime.evidenceStore.ingestPlan = (plan) => { capturedPlan = plan; return ingestPlan(plan); };
  const result = await runtime.turn({
    mode: 'agent', goal: 'find function password_check',
    budget: { maxToolCalls: 24, maxCost: 0, maxFunctions: 4, maxDisassembly: 100, timeoutMs: 2_000 },
  });
  assert.equal(counter.count, 0, 'maxCost=0 must prevent deterministic-planner cost-bearing tool execution');
  assert.equal(result.usage.toolCalls, 0);
  assert.equal(result.usage.toolCost, 0);
  assert.equal(result.limits.reason, 'tool-cost-budget');
  assert.equal(capturedPlan?.exhausted, true, 'a cost-stopped plan must remain visibly budget-limited');
  assert.equal(capturedPlan?.completeness?.complete, false, 'cost exhaustion must not preserve complete planner evidence');
  assert.equal(capturedPlan?.completeness?.reason, 'tool-cost-budget');
  assert.ok(capturedPlan?.missingEvidence?.includes('tool-cost-budget'));
}

{
  const counter = { count: 0 };
  const runtime = new AIRuntime({
    context: contextWithSearchCounter(counter),
    planner: onePlannerSearch(),
    provider: toolThenFinalProvider(),
  });
  const result = await runtime.turn({
    mode: 'agent', goal: 'find function password_check',
    budget: { maxToolCalls: 1, maxCost: 160, maxFunctions: 4, maxDisassembly: 100, timeoutMs: 2_000 },
  });
  assert.equal(counter.count, 1, 'planner consumption must leave no hidden extra call for the model loop');
  assert.equal(result.usage.toolCalls, 1, 'usage must include planner executions');
  assert.equal(result.usage.toolCost, 1, 'planner execution must contribute registry cost accounting');
  assert.equal(result.limits.reason, 'tool-call-budget');
}

{
  const counter = { count: 0 };
  const runtime = new AIRuntime({
    context: contextWithSearchCounter(counter),
    planner: onePlannerSearch(),
    provider: toolThenFinalProvider(),
  });
  const result = await runtime.turn({
    mode: 'agent', goal: 'find function password_check',
    budget: { maxToolCalls: 4, maxCost: 1, maxFunctions: 4, maxDisassembly: 100, timeoutMs: 2_000 },
  });
  assert.equal(counter.count, 1, 'planner cost must reduce the model-loop cost remainder');
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.usage.toolCost, 1);
  assert.equal(result.limits.reason, 'tool-cost-budget');
}

{
  const counter = { count: 0 };
  const runtime = new AIRuntime({
    context: contextWithSearchCounter(counter),
    planner: onePlannerSearch(),
    provider: toolThenFinalProvider(),
  });
  const result = await runtime.turn({
    mode: 'agent', goal: 'find function password_check',
    budget: { maxToolCalls: 2, maxCost: 2, maxFunctions: 4, maxDisassembly: 100, timeoutMs: 2_000 },
  });
  assert.equal(counter.count, 2, 'planner and model should both execute when the shared remainder permits both');
  assert.equal(result.usage.toolCalls, 2, 'usage must equal planner + model tool executions');
  assert.equal(result.usage.toolCost, 2);
}

{
  const counter = { count: 0 };
  const runtime = new AIRuntime({
    context: contextWithSearchCounter(counter),
    planner: async (_goal, _context, options) => {
      await options.tools.search_functions('first', { limit: 1 });
      await options.tools.search_strings('second', { limit: 1 });
      return blankPlan();
    },
    provider: null,
  });
  const result = await runtime.turn({
    mode: 'agent', goal: 'find function password_check',
    budget: { maxToolCalls: 1, maxCost: 160, maxFunctions: 4, maxDisassembly: 100, timeoutMs: 2_000 },
  });
  assert.equal(counter.count, 1, 'an injected planner must not bypass the shared call ceiling');
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.limits.reason, 'tool-call-budget');
}

{
  const counter = { count: 0 };
  let coercions = 0;
  const structuredQuery = { toString() { coercions += 1; return 'coerced'; } };
  const runtime = new AIRuntime({
    context: contextWithSearchCounter(counter),
    planner: async (_goal, _context, options) => {
      await options.tools.search_functions(structuredQuery, { limit: 1 });
      return blankPlan();
    },
    provider: null,
  });
  const result = await runtime.turn({
    mode: 'agent', goal: 'find function password_check',
    budget: { maxToolCalls: 2, maxCost: 2, maxFunctions: 4, maxDisassembly: 100, timeoutMs: 2_000 },
  });
  assert.equal(coercions, 0, 'planner facade must not coerce structured query authority');
  assert.equal(counter.count, 0, 'schema-invalid planner input must fail before producer execution');
  assert.equal(result.usage.toolCalls, 0);
  assert.equal(result.limits.reason, 'invalid_tool_call');
}

console.log('issue-5784-ai-planner-turn-budget: PASS');

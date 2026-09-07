// Regression for #5784: the deterministic planner called registry.legacyTools
// directly, so its tool work bypassed ToolRegistry accounting —
// maxToolCalls:0/maxCost:0 still allowed real tool execution, and usage
// reported planner toolCalls/toolCost as zero. Planner invocations now flow
// through the same accounting as the model loop.
import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';

function runtimeWithCounter() {
  const state = { searches: 0 };
  const runtime = new AIRuntime({
    context: {
      binaryId: 'bin-A',
      functions: [],
      searchFunctions: async () => {
        state.searches += 1;
        return { results: [], total: 0, complete: true };
      },
    },
    provider: null,
  });
  return { runtime, state };
}

{
  const { runtime, state } = runtimeWithCounter();
  const result = await runtime.turn({
    mode: 'agent',
    goal: 'find function password_check',
    budget: { maxToolCalls: 0, maxCost: 0, maxFunctions: 4, maxDisassembly: 100 },
  });
  assert.equal(state.searches, 0, 'a zero tool budget must stop planner tool execution');
  assert.equal(result.usage.toolCalls, 0);
}

{
  const { runtime, state } = runtimeWithCounter();
  const result = await runtime.turn({
    mode: 'agent',
    goal: 'find function password_check',
    budget: { maxToolCalls: 3, maxCost: 100, maxFunctions: 4, maxDisassembly: 100 },
  });
  assert.ok(state.searches <= 3, `planner tool calls must respect maxToolCalls, saw ${state.searches}`);
  assert.ok(result.usage.toolCost >= 1, 'planner tool work must be reported in usage');
}

{
  // Non-agent chat turns are unaffected.
  const { runtime, state } = runtimeWithCounter();
  await runtime.turn({ goal: 'find function password_check', budget: { maxToolCalls: 0, maxCost: 0, maxFunctions: 4, maxDisassembly: 100 } });
  assert.equal(state.searches, 0);
}

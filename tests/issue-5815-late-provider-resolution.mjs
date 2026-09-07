// Regression for #5815: deadline enforcement depended on provider
// cooperation. A provider that ignored the abort signal and resolved after
// the runtime timer fired had its late decision validated and adopted as the
// turn's final answer, because no deadline check ran between
// `await provider.nextTurn(...)` and the decision adoption. The executor now
// re-checks the turn state immediately after the provider resolves.
import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';

{
  // Provider-level timeout declared (turnTimeoutMs = 10) but ignored.
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: {
      turnTimeoutMs: () => 10,
      nextTurn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { type: 'final', answer: 'late answer', confidence: 1, evidenceIds: [] };
      },
    },
  });
  const result = await runtime.turn({ goal: 'probe', mode: 'chat' });
  assert.notEqual(result.answer, 'late answer', 'a late final must not be adopted');
  assert.equal(result.limits?.exhausted, true, 'the exhausted budget must be reported');
}

{
  // Caller-capped budget: the provider resolves 15ms past the 40ms deadline.
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: {
      turnTimeoutMs: () => null,
      nextTurn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 55));
        return { type: 'final', answer: 'late answer 2', confidence: 1, evidenceIds: [] };
      },
    },
  });
  const result = await runtime.turn({ goal: 'probe', mode: 'chat', budget: { timeoutMs: 40 } });
  assert.notEqual(result.answer, 'late answer 2', 'a resolution past the caller budget must not be adopted');
  assert.equal(result.limits?.reason, 'budget_exhausted');
}

{
  // In-budget providers are untouched.
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: {
      turnTimeoutMs: () => null,
      nextTurn: async () => ({ type: 'final', answer: 'on time', confidence: 0.9, evidenceIds: [] }),
    },
  });
  const result = await runtime.turn({ goal: 'probe', mode: 'chat' });
  assert.equal(result.answer, 'on time');
  assert.notEqual(result.limits?.reason, 'budget_exhausted');
}

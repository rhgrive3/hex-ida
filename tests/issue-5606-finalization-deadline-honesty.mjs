// Regression for #5606: the turn deadline/cancellation contract holds through
// finalization. A budget that expires during finalize/persistence must not
// resolve as a normal success, and a cancelled turn must not resolve at all.
import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';

function makeRuntime(provider, sessionStore) {
  return new AIRuntime({ context: {}, planner: false, provider, sessionStore });
}
const finalProvider = () => ({
  async nextTurn() { return { type: 'final', answer: 'ok', evidenceIds: [], suggestedActions: [] }; },
});
const storeWithSlowAssistantPersist = () => ({
  async create(input) { return { id: 's1', goal: input.goal, messages: [], memory: null, status: 'active' }; },
  async get(id) { return { id, messages: [], memory: null, status: 'active' }; },
  async update() {},
  async appendMessage(id, message) { if (message.role === 'assistant') await new Promise((r) => setTimeout(r, 80)); return id; },
  async updateMemory() {},
});

// 1. A deadline that fires during the assistant persistence must demote the
// result to the budget-exhausted policy, never a clean success.
{
  const runtime = makeRuntime(finalProvider(), storeWithSlowAssistantPersist());
  const result = await runtime.turn({ mode: 'chat', goal: 'timeout-late', budget: { timeoutMs: 20, maxModelCalls: 1 } });
  assert.equal(result.limits.exhausted, true, `a late expiry must be honest, got ${JSON.stringify(result.limits)}`);
  assert.equal(result.limits.reason, 'budget_exhausted');
}

// 2. A caller cancellation during the assistant persistence rejects (the
// #5632 contract extends to late aborts).
{
  const controller = new AbortController();
  const runtime = makeRuntime(finalProvider(), (() => {
    const store = storeWithSlowAssistantPersist();
    const original = store.appendMessage;
    store.appendMessage = (id, message) => {
      if (message.role === 'assistant') { controller.abort('cancelled'); }
      return original(id, message);
    };
    return store;
  })());
  await assert.rejects(
    runtime.turn({ mode: 'chat', goal: 'cancel-late' }, { signal: controller.signal }),
    (error) => error.type === 'cancelled',
    'a late cancellation must reject instead of resolving a success',
  );
}

// 3. A turn that finishes well inside the deadline stays a clean success.
{
  const runtime = makeRuntime(finalProvider(), storeWithSlowAssistantPersist());
  const result = await runtime.turn({ mode: 'chat', goal: 'fast', budget: { timeoutMs: 120_000, maxModelCalls: 1 } });
  assert.equal(result.limits.exhausted, false);
  assert.equal(result.answer, 'ok');
}

console.log('issue #5606 finalization deadline honesty regressions PASS');

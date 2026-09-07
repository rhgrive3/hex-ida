// Regression for #6095: executeTurn's sub-budget accounting (ensureRunning,
// remainingTime, planner cancellation, usage.elapsedMs) derived elapsed time
// from Date.now(), so a wall-clock correction changed the turn budget: a
// forward jump could abort a just-started turn with budget_exhausted and a
// rollback could hand a subtask a remaining budget larger than the original
// timeout. Elapsed time now comes from a monotonic clock, so wall-clock jumps
// cannot move any budget boundary.
import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';
import { remainingTime, ensureRunning } from '../js/ai/control/runtime-support.js';

const originalDateNow = Date.now;

try {
  // Simulate a +1h wall-clock forward jump: budget helpers must not move.
  const remainingBefore = remainingTime(0, 30_000);
  Date.now = () => originalDateNow.call(Date) + 3_600_000;
  assert.ok(remainingTime(0, 30_000) <= 30_000, 'a wall-clock forward jump must not exhaust the remaining budget');
  assert.ok(remainingBefore <= 30_000, 'remainingTime stays within the initial timeout');
  assert.doesNotThrow(() => ensureRunning(null, Date.now() - 100, 30_000), 'a wall-clock forward jump must not exhaust the budget');
  assert.throws(() => ensureRunning(null, performance.now() - 31_000, 30_000), 'sanity: a genuinely elapsed monotonic budget still exhausts');
  Date.now = originalDateNow;

  // Rollback: the remaining budget may never exceed the initial timeout.
  Date.now = () => originalDateNow.call(Date) - 3_600_000;
  assert.ok(remainingTime(0, 30_000) <= 30_000, 'a wall-clock rollback must not inflate the remaining budget');
  Date.now = originalDateNow;

  // Full turn: a wall-clock forward jump during the model call must not turn
  // the turn into budget_exhausted, and usage stays within the timeout.
  let sawTimeoutMs = null;
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: {
      turnTimeoutMs: () => null,
      nextTurn: async (request, options) => {
        sawTimeoutMs = options.timeoutMs ?? null;
        // The wall clock jumps one hour while the model call is in flight.
        Date.now = () => originalDateNow.call(Date) + 3_600_000;
        return { type: 'final', answer: 'monotonic answer', confidence: 0.9, evidenceIds: [] };
      },
    },
  });
  const result = await runtime.turn({ goal: 'probe', mode: 'chat' });
  assert.equal(result.answer, 'monotonic answer', 'the turn completes despite the wall-clock jump');
  assert.notEqual(result.limits?.reason, 'budget_exhausted');
  assert.ok(result.usage.elapsedMs <= 240_000, `usage.elapsedMs stays within the turn ceiling, saw ${result.usage.elapsedMs}`);
  assert.ok(sawTimeoutMs != null && sawTimeoutMs <= 240_000, 'provider receives a bounded remaining budget');
} finally {
  Date.now = originalDateNow;
}

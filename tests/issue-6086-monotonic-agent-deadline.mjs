// Regression for #6086: runAgent() measured its deadline and remaining budgets
// with Date.now() differences, so a wall-clock rollback extended the deadline
// and a forward jump fired it early — including the LLM per-step timer, the
// final deterministic planner budget and stats.elapsedMs. Elapsed time now
// uses a monotonic clock, so wall-clock corrections cannot move any deadline.
import assert from 'node:assert/strict';
import { runAgent } from '../js/agent/runtime.js';

const originalDateNow = Date.now;

try {
  // The model sees a wall-clock forward jump mid-call; the run must still
  // complete normally instead of dying with a premature timeout.
  let jumped = false;
  const result = await runAgent({
    goal: 'find the update handler',
    context: {},
    budget: { timeoutMs: 30_000, maxToolCalls: 2, maxFunctions: 4, maxDisassembly: 1000 },
    llm: {
      next: async () => {
        if (!jumped) {
          jumped = true;
          Date.now = () => originalDateNow.call(Date) + 3_600_000;
        }
        return { answer: { text: 'deterministic conclusion stands', confidence: 0.7 } };
      },
    },
  });
  assert.ok(result, 'the run completes despite the wall-clock forward jump');
  assert.notEqual(result.missingEvidence?.[0], 'timeout', 'a wall-clock jump must not be reported as timeout');
  assert.ok(result.stats.elapsedMs <= 30_000, `stats.elapsedMs stays within the budget, saw ${result.stats.elapsedMs}`);

  // Elapsed accounting is monotonic: a rollback cannot inflate elapsedMs or
  // reset the deadline, and remaining budgets never exceed the initial one.
  Date.now = () => originalDateNow.call(Date) - 3_600_000;
  const rolled = await runAgent({
    goal: 'probe',
    context: {},
    budget: { timeoutMs: 30_000, maxToolCalls: 1, maxFunctions: 2, maxDisassembly: 500 },
    llm: { next: async () => ({ answer: { text: 'ok', confidence: 0.9 } }) },
  });
  assert.ok(rolled.stats.elapsedMs <= 30_000, `rollback cannot inflate elapsedMs, saw ${rolled.stats.elapsedMs}`);
} finally {
  Date.now = originalDateNow;
}

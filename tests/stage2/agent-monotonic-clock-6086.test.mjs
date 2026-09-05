import assert from 'node:assert/strict';
import { runAgent } from '../../js/agent/runtime.js';

const realDateNow = Date.now;
const withWallClock = async (value, fn) => {
  Date.now = () => value;
  try { return await fn(); } finally { Date.now = realDateNow; }
};
const emptyContext = () => ({ candidateFunctions: [], analyze: async (id) => ({ instructions: [] }) });

// Monotonic elapsed controls the deadline: wall-clock rollback must not extend it.
{
  let t = 1000;
  const seen = [];
  const result = await withWallClock(0, () => runAgent({
    goal: 'inspect function',
    context: emptyContext(),
    timeoutMs: 1000,
    maxToolCalls: 2,
    monotonicNow: () => t,
    llm: {
      async next({ budget }) {
        seen.push(budget.remainingMs);
        t += 10;
        return { answer: { conclusion: null, reasons: [], confidence: 0, missingEvidence: [] } };
      },
    },
  }));
  assert.ok(seen.length >= 1, 'llm must observe a remaining budget');
  assert.ok(seen[0] >= 900 && seen[0] <= 1000, `remainingMs must use monotonic elapsed, got ${seen[0]}`);
  assert.equal(result.stats.elapsedMs, 10, 'stats must report monotonic elapsed, not wall clock');
  assert.ok(!result.missingEvidence.includes('timeout'), 'monotonic elapsed below timeout must continue');
}

// Monotonic deadline fires even when the wall clock claims no time passed.
{
  let t = 5000;
  let modelCalls = 0;
  const result = await withWallClock(0, () => runAgent({
    goal: 'inspect function',
    context: emptyContext(),
    timeoutMs: 100,
    maxToolCalls: 5,
    monotonicNow: () => t,
    llm: {
      async next() {
        modelCalls++;
        t += 200;
        return { tool: 'no_such_tool_xyz', args: [] };
      },
    },
  }));
  assert.equal(modelCalls, 1, 'deadline must stop the run after the monotonic budget is spent');
  assert.ok(result.missingEvidence.includes('timeout'), 'monotonic expiry must record timeout');
}

// Wall-clock forward jump must not cause an early timeout while monotonic budget remains.
{
  let t = 2000;
  const seen = [];
  const result = await withWallClock(1_000_000_000_000, () => runAgent({
    goal: 'inspect function',
    context: emptyContext(),
    timeoutMs: 30_000,
    maxToolCalls: 2,
    monotonicNow: () => t,
    llm: {
      async next({ budget }) {
        seen.push(budget.remainingMs);
        return { answer: { conclusion: null, reasons: [], confidence: 0, missingEvidence: [] } };
      },
    },
  }));
  assert.ok(seen[0] > 29_000, `wall forward jump must not shrink remainingMs, got ${seen[0]}`);
  assert.ok(!result.missingEvidence.includes('timeout'), 'wall forward jump must not time out a fresh run');
}

console.log('stage2 agent-monotonic-clock-6086: PASS');

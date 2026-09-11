import assert from 'node:assert/strict';
import { runAgent } from '../js/agent/runtime.js';

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

// The final deterministic planner must receive only the time left after a
// model fallback. A real delayed search provider makes that budget observable:
// a wall-clock-only calculation would grant the full 100ms and complete it.
{
  let t = 1000;
  let searchStarted = 0;
  let searchCompleted = 0;
  let searchAborted = 0;
  const result = await withWallClock(0, () => runAgent({
    goal: 'read ad',
    context: {
      candidateFunctions: [],
      analyze: async () => ({ instructions: [] }),
      searchFunctions: (_term, options = {}) => {
        searchStarted++;
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            searchCompleted++;
            resolve({ results: [], complete: true });
          }, 50);
          options.signal?.addEventListener('abort', () => {
            searchAborted++;
            clearTimeout(timer);
          }, { once: true });
        });
      },
    },
    timeoutMs: 100,
    maxToolCalls: 32,
    monotonicNow: () => t,
    llm: {
      async next() {
        t += 80;
        return { tool: 'invalid_tool_for_final_planner_test', args: [] };
      },
    },
  }));
  assert.equal(searchStarted, 1, 'final planner must enter the real search provider path');
  assert.equal(searchAborted, 1, 'final planner must abort the provider at the remaining deadline');
  assert.equal(searchCompleted, 0, 'final planner must not receive the full original timeout');
  assert.equal(result.plan?.partial, true, 'final planner must report a remaining-budget cutoff');
  assert.equal(result.plan?.exhausted, true, 'final planner must expose the exhausted budget');
  assert.ok(result.plan?.missingEvidence.includes('timeout'), 'planner timeout must be observable in its result');
}

console.log('stage2 agent-monotonic-clock-6086: PASS');

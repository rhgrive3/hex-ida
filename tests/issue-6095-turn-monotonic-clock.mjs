import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AIRuntime } from '../js/ai/runtime.js';
import {
  createMonotonicClock, ensureRunning, remainingTime,
} from '../js/ai/control/runtime-support.js';

const support = fs.readFileSync(
  new URL('../js/ai/control/runtime-support.js', import.meta.url), 'utf8');
const executor = fs.readFileSync(
  new URL('../js/ai/control/turn-executor.js', import.meta.url), 'utf8');
const runtime = fs.readFileSync(
  new URL('../js/ai/runtime.js', import.meta.url), 'utf8');

// Budget helpers default to a monotonic clock, never to the wall clock.
assert.match(support, /export function defaultMonotonicNow\(\)/,
  'a monotonic time source must exist');
assert.match(support, /performance\.now/, 'monotonic source must prefer performance.now');
assert.match(support, /export function resolveMonotonicClock\(/,
  'callers must be able to inject a test clock');
assert.match(
  support,
  /export function ensureRunning\(signal, started, timeoutMs, nowFn = defaultMonotonicNow\)/,
  'ensureRunning must take an injectable clock');
assert.match(
  support,
  /export function remainingTime\(started, timeoutMs, nowFn = defaultMonotonicNow\)/,
  'remainingTime must take an injectable clock');
assert.match(
  support,
  /export function createMonotonicClock\(/,
  'the shared clock authority must clamp rollback and invalid readings');
assert.doesNotMatch(support, /Date\.now\(\) - started/,
  'no budget decision may read the wall clock directly');

// The turn orchestrator fixes one monotonic authority and shares it across
// the hard-timer-adjacent budget decisions.
assert.match(executor, /resolveMonotonicClock\(options\.clock, options\.monotonicNow, options\.now\)/,
  'executeTurn must resolve one injectable turn clock');
assert.match(executor, /createMonotonicClock\(resolveMonotonicClock\(options\.clock, options\.monotonicNow, options\.now\)\)/,
  'executeTurn must clamp the resolved clock authority');
assert.match(executor, /const started = monotonicNow\(\),/,
  'turn start must come from the monotonic clock');
assert.ok(
  (executor.match(/ensureRunning\(signal, started, turnTimeoutMs, monotonicNow\)/g) || []).length >= 5,
  'every ensureRunning check must share the turn clock');
assert.ok(
  (executor.match(/remainingTime\(started, turnTimeoutMs, monotonicNow\)/g) || []).length >= 3,
  'every remainingTime computation must share the turn clock');
assert.match(executor, /monotonicNow\(\) - started >= turnTimeoutMs/,
  'planner cancellation must share the turn clock');
assert.doesNotMatch(executor, /Date\.now\(\) - started/,
  'no turn budget path may read the wall clock directly');
assert.doesNotMatch(runtime, /Date\.now\(\) - started/,
  'reported turn elapsed time must use the protected clock');

// Exercise the real runtime-support helpers at the early, rollback, and
// deadline boundaries rather than copying their arithmetic in this test.
{
  const started = 10_000;
  const timeoutMs = 30_000;

  assert.doesNotThrow(
    () => ensureRunning(null, started, timeoutMs, () => 10_005),
    'a monotonic elapsed value below the timeout must continue',
  );
  assert.equal(remainingTime(started, timeoutMs, () => 10_005), 29_995);

  // A backward injected reading cannot produce negative elapsed time or grow
  // the remaining budget past the initial timeout.
  assert.doesNotThrow(
    () => ensureRunning(null, started, timeoutMs, () => 0),
    'a rollback must not stop a still-live turn',
  );
  assert.equal(remainingTime(started, timeoutMs, () => 0), timeoutMs,
    'rollback remaining must stay at the initial timeout');

  // The actual helper must stop exactly at the deadline and clamp its output.
  assert.throws(
    () => ensureRunning(null, started, timeoutMs, () => 40_000),
    /timed out/,
    'deadline arrival must stop the turn',
  );
  assert.equal(remainingTime(started, timeoutMs, () => 40_000), 1,
    'remaining time must clamp instead of going negative');

  // The production wrapper preserves the last observation on rollback or
  // an invalid clock sample.
  const readings = [10_000, 0, Number.NaN, 10_005];
  const protectedClock = createMonotonicClock(() => readings.shift());
  assert.deepEqual(
    [protectedClock(), protectedClock(), protectedClock(), protectedClock()],
    [10_000, 10_000, 10_000, 10_005],
  );
}

// Exercise the public executeTurn path with a caller clock and a wall-clock
// jump. The provider must receive the initial budget, and the returned usage
// must report the same monotonic elapsed time rather than Date.now() - started.
{
  let now = 10_000;
  const observedTimeouts = [];
  const runtime = new AIRuntime({
    context: { binaryId: 'fixture:6095', currentAddress: 0x1000n },
    planner: false,
    provider: {
      turnTimeoutMs: () => null,
      async nextTurn(_request, options) {
        observedTimeouts.push(options.timeoutMs);
        now = 10_025;
        return { type: 'final', answer: 'ok', confidence: 0.2, evidenceIds: [], suggestedActions: [] };
      },
    },
  });
  const wallNow = Date.now;
  Date.now = () => 3_610_000;
  let result;
  try {
    result = await runtime.turn(
      { mode: 'chat', scope: 'auto', goal: 'normal executeTurn clock path', budget: { timeoutMs: 30_000, maxModelCalls: 1 } },
      { monotonicNow: () => now },
    );
  } finally {
    Date.now = wallNow;
  }
  assert.deepEqual(observedTimeouts, [30_000],
    'a wall-clock jump must not shrink the provider remaining budget');
  assert.equal(result.limits.exhausted, false,
    'a live monotonic turn must complete normally');
  assert.equal(result.usage.elapsedMs, 25,
    'executeTurn usage must report protected monotonic elapsed time');
}

// Exercise the actual planner callback with the same turn clock. A planner
// that observes the deadline must be able to stop its work without a wall-clock
// calculation in the orchestrator.
{
  let now = 1_000;
  let plannerTimeout;
  let plannerWasRunning;
  const runtime = new AIRuntime({
    context: { binaryId: 'fixture:6095-planner', currentAddress: 0x1000n },
    planner: async (_goal, _context, options) => {
      plannerTimeout = options.timeoutMs;
      plannerWasRunning = options.isCancelled();
      now = 31_000;
      assert.equal(options.isCancelled(), true,
        'planner cancellation must observe the shared turn deadline');
      return { candidates: [], evidence: [], best: null, missingEvidence: [], exhausted: true };
    },
  });
  await runtime.turn(
    { mode: 'agent', scope: 'auto', goal: 'find function normally', budget: { timeoutMs: 30_000, maxModelCalls: 1 } },
    { monotonicNow: () => now },
  );
  assert.equal(plannerTimeout, 15_000, 'planner receives its bounded sub-timeout');
  assert.equal(plannerWasRunning, false, 'planner starts before the shared deadline');
}

// An invalid provider response must use the same remaining-time authority for
// the one permitted repair retry.
{
  let now = 5_000;
  let calls = 0;
  const repairTimeouts = [];
  const runtime = new AIRuntime({
    context: { binaryId: 'fixture:6095-repair', currentAddress: 0x1000n },
    planner: false,
    provider: {
      async nextTurn(_request, options) {
        repairTimeouts.push(options.timeoutMs);
        calls++;
        if (calls === 1) {
          now = 5_005;
          return { type: 'invalid' };
        }
        return { type: 'final', answer: 'ok', confidence: 0.2, evidenceIds: [], suggestedActions: [] };
      },
    },
  });
  const result = await runtime.turn(
    { mode: 'chat', scope: 'auto', goal: 'normal repair path', budget: { timeoutMs: 60_000, maxModelCalls: 2 } },
    { monotonicNow: () => now },
  );
  assert.deepEqual(repairTimeouts, [60_000, 59_995],
    'provider and repair retry must share the turn clock');
  assert.equal(result.limits.exhausted, false, 'a valid repair retry must complete normally');
}

console.log('issue #6095 executeTurn monotonic clock regressions PASS');

// Keep the late-provider await-boundary regression in the required ai:test
// denominator without weakening or replacing any existing suite entry.
await import('./issue-5815-late-provider-resolution.mjs');

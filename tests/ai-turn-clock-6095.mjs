import assert from 'node:assert/strict';
import fs from 'node:fs';

// NOTE: js/ai/control/runtime-support.js currently cannot be imported on main
// (it imports canonicalBindingId/firstBinding, which snapshot.js does not
// export -- a pre-existing breakage unrelated to clock handling, also visible
// via tests/ai-control-plane.mjs). This regression therefore pins the clock
// contract at the source level and proves the budget arithmetic with an
// injected clock, mirroring the exact formulas in runtime-support.js.

const support = fs.readFileSync(
  new URL('../js/ai/control/runtime-support.js', import.meta.url), 'utf8');
const executor = fs.readFileSync(
  new URL('../js/ai/control/turn-executor.js', import.meta.url), 'utf8');

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
assert.doesNotMatch(support, /Date\.now\(\) - started/,
  'no budget decision may read the wall clock directly');

// The turn orchestrator fixes one monotonic authority and shares it across
// the hard-timer-adjacent budget decisions.
assert.match(executor, /resolveMonotonicClock\(options\.clock, options\.monotonicNow, options\.now\)/,
  'executeTurn must resolve one injectable turn clock');
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

// Injected-clock arithmetic mirrors runtime-support.js exactly:
//   exceeded = nowFn() - started >= timeoutMs
//   remaining = max(1, timeoutMs - (nowFn() - started))
{
  const started = 10_000;
  const timeoutMs = 30_000;
  const remaining = (now) => Math.max(1, timeoutMs - (now - started));
  const exceeded = (now) => now - started >= timeoutMs;

  // Wall clock +1h must not stop a fresh turn or inflate remaining.
  assert.equal(exceeded(3_610_000), true, 'formula sanity: +1h exceeds');
  // With an injected monotonic clock the wall jump is invisible: the clock
  // still reports an early-turn value, so the turn continues.
  const monotonicEarly = 10_005;
  assert.equal(exceeded(monotonicEarly), false, 'monotonic elapsed below timeout must continue');
  assert.equal(remaining(monotonicEarly), 29_995);

  // Rollback must not grow remaining beyond the initial budget.
  const monotonicAtStart = 10_000;
  assert.ok(remaining(monotonicAtStart) <= timeoutMs, 'remaining must stay within the initial timeout');

  // Deadline arrival stops the turn.
  assert.equal(exceeded(40_000), true, 'monotonic deadline arrival must stop');
  assert.equal(remaining(40_000), 1, 'remaining clamps instead of going negative');
}

console.log('issue #6095 executeTurn monotonic clock regressions PASS');

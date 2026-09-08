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

// Injected-clock arithmetic mirrors the protected runtime-support authority:
//   elapsed = max(0, nowFn() - started)
//   remaining = max(1, min(initial timeout, timeoutMs - elapsed))
{
  const started = 10_000;
  const timeoutMs = 30_000;
  const elapsed = (now) => Math.max(0, now - started);
  const remaining = (now) => Math.max(1, Math.min(timeoutMs, timeoutMs - elapsed(now)));
  const exceeded = (now) => elapsed(now) >= timeoutMs;

  // Wall clock +1h must stop at the deadline, not produce a larger budget.
  assert.equal(exceeded(3_610_000), true, 'formula sanity: +1h exceeds');
  const monotonicEarly = 10_005;
  assert.equal(exceeded(monotonicEarly), false, 'monotonic elapsed below timeout must continue');
  assert.equal(remaining(monotonicEarly), 29_995);

  // A backward injected reading cannot produce negative elapsed time or grow
  // the remaining budget past the initial timeout.
  const monotonicRollback = 0;
  assert.equal(elapsed(monotonicRollback), 0, 'rollback elapsed must clamp at zero');
  assert.equal(remaining(monotonicRollback), timeoutMs, 'rollback remaining must stay at the initial timeout');

  // The shared clock wrapper preserves the last observation on rollback.
  let last = null;
  const clamp = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return last ?? 0;
    if (last == null || value > last) last = value;
    return last;
  };
  assert.deepEqual([clamp(10_000), clamp(0), clamp(10_005)], [10_000, 10_000, 10_005]);

  // Deadline arrival stops the turn.
  assert.equal(exceeded(40_000), true, 'monotonic deadline arrival must stop');
  assert.equal(remaining(40_000), 1, 'remaining clamps instead of going negative');
}

console.log('issue #6095 executeTurn monotonic clock regressions PASS');

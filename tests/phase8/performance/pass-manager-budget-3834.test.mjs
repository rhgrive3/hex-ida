import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_PASS_BUDGET, PassManager } from '../../../js/decompiler/passes/manager.js';

function withFakeClock(run) {
  const originalPerformance = globalThis.performance;
  let now = 0;
  globalThis.performance = { now: () => now };
  try {
    return run({ setNow(value) { now = value; } });
  } finally {
    globalThis.performance = originalPerformance;
  }
}

const MALFORMED_BUDGETS = [
  NaN,
  Infinity,
  -Infinity,
  -1,
  '40',
  'not-a-number',
  [],
  [40],
  {},
];

test('PassManager does not coerce malformed total time budgets', () => {
  let coerced = false;
  const coercive = { valueOf() { coerced = true; return 40; } };
  for (const value of [...MALFORMED_BUDGETS, coercive]) {
    const manager = new PassManager([], { timeBudgetMs: value });
    assert.equal(manager.budget.timeBudgetMs, DEFAULT_PASS_BUDGET.timeBudgetMs);
  }
  assert.equal(coerced, false);

  assert.equal(new PassManager([], { timeBudgetMs: 0 }).budget.timeBudgetMs, 0);
  assert.equal(new PassManager([], { timeBudgetMs: 12.5 }).budget.timeBudgetMs, 12.5);
});

test('malformed total budget cannot disable hard stop, cancellation, or overrun observability', () => {
  withFakeClock(({ setNow }) => {
    let abortObserved = false;
    const manager = new PassManager([
      {
        name: 'optional',
        run(state, budget) {
          setNow(DEFAULT_PASS_BUDGET.timeBudgetMs + 1);
          abortObserved = budget.shouldAbort();
          return state;
        },
      },
    ], { timeBudgetMs: {} });

    const state = manager.run({});
    assert.equal(abortObserved, true);
    assert.equal(state.degraded, true);
    assert.equal(state.passDeadlineExceeded, true);
  });
});

test('zero total budget still skips optional passes', () => {
  withFakeClock(() => {
    let ran = false;
    const state = new PassManager([{ name: 'optional', run() { ran = true; } }], { timeBudgetMs: 0 }).run({});
    assert.equal(ran, false);
    assert.equal(state.passMetrics[0]?.skipped, true);
    assert.equal(state.passMetrics[0]?.reason, 'deadline');
  });
});

test('PassManager does not coerce malformed pass-local time budgets', () => {
  withFakeClock(() => {
    let coerced = false;
    const coercive = { valueOf() { coerced = true; return 7; } };
    for (const value of [...MALFORMED_BUDGETS, coercive]) {
      let observed = null;
      const state = new PassManager([
        {
          name: 'optional',
          budget: { timeBudgetMs: value },
          run(innerState, budget) {
            observed = budget.timeBudgetMs;
            return innerState;
          },
        },
      ]).run({});
      assert.equal(observed, DEFAULT_PASS_BUDGET.timeBudgetMs);
      assert.equal(state.passMetrics[0]?.ok, true);
    }
    assert.equal(coerced, false);

    let zeroObserved = null;
    new PassManager([{ name: 'zero', budget: { timeBudgetMs: 0 }, run(state, budget) { zeroObserved = budget.timeBudgetMs; return state; } }]).run({});
    assert.equal(zeroObserved, 0);

    let positiveObserved = null;
    new PassManager([{ name: 'positive', budget: { timeBudgetMs: 7.5 }, run(state, budget) { positiveObserved = budget.timeBudgetMs; return state; } }]).run({});
    assert.equal(positiveObserved, 7.5);
  });
});

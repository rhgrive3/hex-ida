import assert from 'node:assert/strict';
import test from 'node:test';

import { expr } from '../../../js/decompiler/ast/nodes.js';
import { DEFAULT_PASS_BUDGET, PassManager } from '../../../js/decompiler/passes/manager.js';
import { DEFAULT_REWRITE_BUDGET, RewriteEngine } from '../../../js/decompiler/rewrite/engine.js';

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

const MALFORMED_WORK_LIMITS = [
  NaN,
  Infinity,
  -Infinity,
  -1,
  1.5,
  '12',
  true,
  [],
  [12],
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

test('PassManager malformed pass-local time budgets use the bounded default before the total cap', () => {
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
      ], { timeBudgetMs: 100 }).run({});
      assert.equal(observed, DEFAULT_PASS_BUDGET.timeBudgetMs);
      assert.equal(state.passMetrics[0]?.ok, true);
    }
    assert.equal(coerced, false);

    let cappedObserved = null;
    new PassManager([
      {
        name: 'capped',
        budget: { timeBudgetMs: {} },
        run(state, budget) { cappedObserved = budget.timeBudgetMs; return state; },
      },
    ], { timeBudgetMs: 7 }).run({});
    assert.equal(cappedObserved, 7);

    let zeroObserved = null;
    new PassManager([{ name: 'zero', budget: { timeBudgetMs: 0 }, run(state, budget) { zeroObserved = budget.timeBudgetMs; return state; } }]).run({});
    assert.equal(zeroObserved, 0);

    let positiveObserved = null;
    new PassManager([{ name: 'positive', budget: { timeBudgetMs: 7.5 }, run(state, budget) { positiveObserved = budget.timeBudgetMs; return state; } }]).run({});
    assert.equal(positiveObserved, 7.5);
  });
});

test('RewriteEngine strictly normalizes time and work budgets without coercion', () => {
  let coerced = false;
  const coercive = { valueOf() { coerced = true; return 12; } };

  for (const value of [...MALFORMED_BUDGETS, coercive]) {
    const engine = new RewriteEngine([], { timeBudgetMs: value });
    assert.equal(engine.budget.timeBudgetMs, DEFAULT_REWRITE_BUDGET.timeBudgetMs);
  }

  for (const key of ['maxIterations', 'nodeBudget', 'maxApplications']) {
    for (const value of [...MALFORMED_WORK_LIMITS, coercive]) {
      const engine = new RewriteEngine([], { [key]: value });
      assert.equal(engine.budget[key], DEFAULT_REWRITE_BUDGET[key], `${key}: ${String(value)}`);
    }
    assert.equal(new RewriteEngine([], { [key]: 0 }).budget[key], 0);
    assert.equal(new RewriteEngine([], { [key]: 3 }).budget[key], 3);
  }

  assert.equal(new RewriteEngine([], { timeBudgetMs: 0 }).budget.timeBudgetMs, 0);
  assert.equal(new RewriteEngine([], { timeBudgetMs: 7.5 }).budget.timeBudgetMs, 7.5);
  assert.equal(coerced, false);
});

test('RewriteEngine malformed time budget retains the bounded wall-clock stop', () => {
  withFakeClock(({ setNow }) => {
    const increment = {
      name: 'increment',
      phase: 'test',
      match(node) {
        setNow(DEFAULT_REWRITE_BUDGET.timeBudgetMs + 1);
        return node?.kind === 'const' ? {} : null;
      },
      rewrite(node) {
        return expr.constant(node.value + 1n);
      },
      proof() {
        return { reason: 'regression' };
      },
    };

    const engine = new RewriteEngine([increment], {
      timeBudgetMs: 'not-a-number',
      maxIterations: 4,
    });
    const result = engine.rewrite(expr.constant(0n));

    assert.equal(engine.budget.timeBudgetMs, DEFAULT_REWRITE_BUDGET.timeBudgetMs);
    assert.equal(result.stats.budgetExceeded, true);
    assert.equal(result.stats.iterations, 1);
  });
});

test('RewriteEngine deterministic mode still ignores only the wall-clock cutoff', () => {
  withFakeClock(({ setNow }) => {
    const increment = {
      name: 'increment',
      phase: 'test',
      match(node) {
        setNow(DEFAULT_REWRITE_BUDGET.timeBudgetMs + 1);
        return node?.kind === 'const' ? {} : null;
      },
      rewrite(node) {
        return expr.constant(node.value + 1n);
      },
      proof() {
        return { reason: 'deterministic-regression' };
      },
    };

    const result = new RewriteEngine([increment], {
      timeBudgetMs: 0,
      maxIterations: 1,
    }).rewrite(expr.constant(0n), { deterministicTransforms: true });

    assert.equal(result.stats.iterations, 1);
    assert.equal(result.stats.budgetExceeded, false);
    assert.equal(result.root.value, 1n);
  });
});

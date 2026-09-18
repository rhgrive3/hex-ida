import assert from 'node:assert/strict';
import test from 'node:test';

import { PassManager } from '../../../js/decompiler/passes/manager.js';

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

test('#5024 a pass-local budget bounds shouldAbort before the global deadline', () => {
  withFakeClock(({ setNow }) => {
    const polls = [];
    const manager = new PassManager([
      {
        name: 'locally-bounded',
        budget: { timeBudgetMs: 1 },
        run(state, budget) {
          for (let ms = 0; ms <= 100; ms += 1) {
            setNow(ms);
            if (budget.shouldAbort()) break;
          }
          polls.push({
            timeBudgetMs: budget.timeBudgetMs,
            allowance: budget.deadline - 0,
            remaining: budget.remainingTimeMs,
          });
          return state;
        },
      },
    ], { timeBudgetMs: 100 });

    const state = manager.run({});
    assert.ok(state.passMetrics[0]?.ok, 'pass still succeeds');
    assert.equal(polls[0].timeBudgetMs, 1);
    assert.equal(polls[0].allowance, 1, 'deadline - passStart equals the local allowance');
    assert.ok(polls[0].remaining <= 1);
  });
});

test('#5024 a pass-local budget larger than the global deadline clamps to the global deadline', () => {
  withFakeClock(({ setNow }) => {
    let observed = null;
    const manager = new PassManager([
      {
        name: 'globally-bounded',
        budget: { timeBudgetMs: 200 },
        run(state, budget) {
          setNow(20);
          observed = { shouldAbort: budget.shouldAbort(), deadline: budget.deadline };
          return state;
        },
      },
    ], { timeBudgetMs: 20 });

    manager.run({});
    assert.equal(observed.shouldAbort, true, 'global deadline still applies');
    assert.equal(observed.deadline, 20);
  });
});

test('#5024 a pass without a pass-local budget keeps the global deadline contract', () => {
  withFakeClock(({ setNow }) => {
    let observed = null;
    const manager = new PassManager([
      {
        name: 'global-only',
        run(state, budget) {
          setNow(50);
          observed = { shouldAbort: budget.shouldAbort(), deadline: budget.deadline, remaining: budget.remainingTimeMs };
          setNow(100);
          observed.lateAbort = budget.shouldAbort();
          return state;
        },
      },
    ], { timeBudgetMs: 100 });

    manager.run({});
    assert.equal(observed.shouldAbort, false, 'mid-global-budget polling must not abort');
    assert.equal(observed.deadline, 100);
    assert.equal(observed.remaining, 100, 'remainingTimeMs is the pass-start snapshot against the global deadline');
    assert.equal(observed.lateAbort, true);
  });
});

test('#5024 malformed pass-local budgets keep the #3834 bounded default for the deadline too', () => {
  withFakeClock(({ setNow }) => {
    let observed = null;
    const manager = new PassManager([
      {
        name: 'malformed-local',
        budget: { timeBudgetMs: {} },
        run(state, budget) {
          setNow(40);
          observed = { shouldAbort: budget.shouldAbort(), timeBudgetMs: budget.timeBudgetMs };
          return state;
        },
      },
    ], { timeBudgetMs: 100 });

    manager.run({});
    assert.equal(observed.timeBudgetMs, 40, 'bounded default still reported');
    assert.equal(observed.shouldAbort, true, 'the bounded default bounds shouldAbort as well');
  });
});

test('#5024 a pass that overruns its local budget is recorded as degraded', () => {
  withFakeClock(({ setNow }) => {
    const manager = new PassManager([
      {
        name: 'overruns-local',
        budget: { timeBudgetMs: 1 },
        run(state, budget) {
          setNow(5);
          assert.equal(budget.shouldAbort(), true);
          return state;
        },
      },
    ], { timeBudgetMs: 100 });

    const state = manager.run({});
    assert.equal(state.passMetrics[0]?.degraded, true, 'local overrun reflected in metrics');
    assert.equal(state.degraded, true);
  });
});

test('#5024 deterministic mode still ignores only the wall-clock valve', () => {
  withFakeClock(({ setNow }) => {
    let abortObserved = null;
    const manager = new PassManager([
      {
        name: 'deterministic-local',
        budget: { timeBudgetMs: 1 },
        run(state, budget) {
          setNow(50);
          abortObserved = budget.shouldAbort();
          return state;
        },
      },
    ], { timeBudgetMs: 100 }).run({ opts: { deterministicTransforms: true } });

    assert.equal(abortObserved, false, 'deterministic runs ignore the wall-clock valve');
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { buildFixture } from '../corpus/fixtures.mjs';

// #5322: the termination gates compare `iterations` against
// `budget.maxIterations` / `budget.widenAfterIterations`, so NaN (or any
// non-finite / non-integer number) made both comparisons false forever and the
// synchronous fixed-point solve never terminated. Budget values are
// termination authority and must fail closed at the option boundary.

const run = (budget) => {
  const built = buildFixture('cyclic-pointer-phi');
  return analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, { budget });
};

test('#5322 NaN budget values fail closed instead of disabling termination', () => {
  assert.throws(() => run({ maxIterations: NaN, widenAfterIterations: NaN }), /points-to-invalid-budget-value/);
  assert.throws(() => run({ maxIterations: NaN }), /points-to-invalid-budget-value/);
  assert.throws(() => run({ widenAfterIterations: NaN }), /points-to-invalid-budget-value/);
});

test('#5322 no other budget value can silently disable termination', () => {
  for (const invalid of [Infinity, -Infinity, 1.5, '32', null, true]) {
    assert.throws(() => run({ maxIterations: invalid }), /points-to-invalid-budget-value/, `maxIterations=${String(invalid)}`);
    assert.throws(() => run({ widenAfterIterations: invalid }), /points-to-invalid-budget-value/, `widenAfterIterations=${String(invalid)}`);
  }
  assert.throws(() => run({ maxIterations: 0 }), /points-to-invalid-budget-value/, 'maxIterations=0');
});

test('#5322 valid budgets keep their contracts', () => {
  const truncated = run({ maxIterations: 1, widenAfterIterations: 99 });
  assert.equal(truncated.status.completeness, 'truncated');
  assert.equal(truncated.status.stopReason, 'iteration-limit');

  const solved = run({ maxIterations: 32, widenAfterIterations: 3 });
  assert.equal(solved.status.completeness, 'complete');

  const zeroWiden = run({ maxIterations: 8, widenAfterIterations: 0 });
  assert.ok(zeroWiden.status.completeness === 'complete' || zeroWiden.status.completeness === 'truncated');
});

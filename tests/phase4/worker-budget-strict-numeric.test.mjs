import assert from 'node:assert/strict';
import test from 'node:test';

await import('../../js/worker-budget.js');
const budgetApi = globalThis.HexWorkerBudget;

test('#3291 supplemental budget rejects coercible non-numbers and non-finite amounts', () => {
  for (const value of ['1', true, [1], NaN, Infinity, -Infinity, -1]) {
    const budget = budgetApi.createSupplementalBudget();
    assert.equal(budget.takeRead(value), false, `takeRead must reject ${String(value)}`);
    assert.equal(budget.snapshot().read, 0, 'rejected values must not affect accounting');
  }

  const budget = budgetApi.createSupplementalBudget();
  assert.equal(budget.takeRead(0), true, 'zero preserves the existing no-op number semantics');
  assert.equal(budget.takeRead(0.5), true, 'finite fractional numbers preserve existing accounting semantics');
  assert.equal(budget.takeRead(1), true, 'valid primitive numbers remain accepted');
  assert.equal(budget.snapshot().read, 1.5);
});

test('#3291 resident release uses the same strict primitive-number boundary', () => {
  const budget = budgetApi.createSupplementalBudget();
  assert.equal(budget.takeResident(10), true);
  for (const value of ['5', true, [5], NaN, Infinity, -Infinity, 0, -1]) {
    budget.releaseResident(value);
    assert.equal(budget.snapshot().resident, 10, `releaseResident must ignore ${String(value)}`);
  }
  budget.releaseResident(0.5);
  assert.equal(budget.snapshot().resident, 9.5, 'finite fractional release preserves existing number semantics');
  budget.releaseResident(1.5);
  assert.equal(budget.snapshot().resident, 8, 'valid primitive-number release remains accepted');
});

test('#3291 functionAuxLimit never coerces structured or string inputs', () => {
  for (const value of ['50000', true, [50000], NaN, Infinity, -Infinity]) {
    assert.equal(budgetApi.functionAuxLimit(value), 32_768, `invalid ${String(value)} must use the fallback`);
  }
  assert.equal(budgetApi.functionAuxLimit(-1), 32_768);
  assert.equal(budgetApi.functionAuxLimit(0), 32_768);
  assert.equal(budgetApi.functionAuxLimit(20_000.9), 40_000, 'finite fractions retain floor-then-scale semantics');
  assert.equal(budgetApi.functionAuxLimit(50_000), 100_000, 'valid primitive numbers retain existing semantics');
});

test('#3291 withinProgramBudget requires finite primitive-number operands', () => {
  for (const pair of [
    ['1', 1], [1, '1'], [true, 1], [1, [1]], [NaN, 1], [1, Infinity], [-Infinity, 1], [-1, 1], [1, -1],
  ]) {
    assert.equal(budgetApi.withinProgramBudget(pair[0], pair[1]), false,
      `withinProgramBudget must reject ${String(pair[0])}, ${String(pair[1])}`);
  }
  assert.equal(budgetApi.withinProgramBudget(0, 0), true, 'zero-byte accounting remains valid');
  assert.equal(budgetApi.withinProgramBudget(0.5, 0.5), true, 'finite fractions retain existing number semantics');
  assert.equal(budgetApi.withinProgramBudget(1, 1), true, 'valid primitive numbers remain accepted');
});

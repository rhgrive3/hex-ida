import assert from 'node:assert/strict';

await import('../js/worker-budget.js');

const budgetApi = globalThis.HexWorkerBudget;
assert.ok(budgetApi, 'HexWorkerBudget must be installed');

{
  const budget = budgetApi.createSupplementalBudget();
  assert.equal(budget.takeRead('1'), false);
  assert.equal(budget.takeRead(true), false);
  assert.equal(budget.takeRead([1]), false);
  assert.equal(budget.takeRead(NaN), false);
  assert.equal(budget.takeRead(Infinity), false);
  assert.equal(budget.takeRead(-1), false);
  assert.equal(budget.snapshot().read, 0);

  assert.equal(budget.takeRead(0), true);
  assert.equal(budget.takeRead(1), true);
  assert.equal(budget.snapshot().read, 1);
}

{
  const budget = budgetApi.createSupplementalBudget();
  assert.equal(budget.takeResident(4), true);
  budget.releaseResident('4');
  budget.releaseResident(true);
  budget.releaseResident([4]);
  budget.releaseResident(NaN);
  budget.releaseResident(Infinity);
  budget.releaseResident(-1);
  budget.releaseResident(0);
  assert.equal(budget.snapshot().resident, 4);

  budget.releaseResident(2);
  assert.equal(budget.snapshot().resident, 2);
  budget.releaseResident(10);
  assert.equal(budget.snapshot().resident, 0);
}

assert.equal(budgetApi.functionAuxLimit('50000'), 32_768);
assert.equal(budgetApi.functionAuxLimit(true), 32_768);
assert.equal(budgetApi.functionAuxLimit([50_000]), 32_768);
assert.equal(budgetApi.functionAuxLimit(NaN), 32_768);
assert.equal(budgetApi.functionAuxLimit(Infinity), 32_768);
assert.equal(budgetApi.functionAuxLimit(-1), 32_768);
assert.equal(budgetApi.functionAuxLimit(0), 32_768);
assert.equal(budgetApi.functionAuxLimit(50_000), 100_000);
assert.equal(budgetApi.functionAuxLimit(50_000.9), 100_000);
assert.equal(budgetApi.functionAuxLimit(500_000), 800_000);

const MiB = 1024 * 1024;
assert.equal(budgetApi.withinProgramBudget('1', 1), false);
assert.equal(budgetApi.withinProgramBudget(1, '1'), false);
assert.equal(budgetApi.withinProgramBudget([1], 1), false);
assert.equal(budgetApi.withinProgramBudget(1, true), false);
assert.equal(budgetApi.withinProgramBudget(NaN, 1), false);
assert.equal(budgetApi.withinProgramBudget(1, Infinity), false);
assert.equal(budgetApi.withinProgramBudget(-1, 1), false);
assert.equal(budgetApi.withinProgramBudget(1, -1), false);
assert.equal(budgetApi.withinProgramBudget(0, 0), true);
assert.equal(budgetApi.withinProgramBudget(95 * MiB, 1 * MiB), true);
assert.equal(budgetApi.withinProgramBudget(95 * MiB, 1 * MiB + 1), false);

console.log('worker budget strict numeric boundary: PASS');

import assert from 'node:assert/strict';
import { createResourceBudget, assertBudgetComplete } from '../../../js/phase12/resource-budget.js';

const controller = new AbortController();
const budget = createResourceBudget({ signal: controller.signal });
controller.abort(new Error('test-cancel'));

assert.equal(budget.checkpoint(), false);
assert.equal(budget.stopped?.status, 'partial');
assert.equal(budget.stopped?.reason, 'cancelled');
assert.throws(
  () => assertBudgetComplete(budget),
  (error) => error?.code === 'phase12-resource-limit' && error?.reason === 'cancelled',
);

const live = createResourceBudget();
assert.equal(live.checkpoint(), true);
assert.equal(live.stopped, null);
assert.equal(assertBudgetComplete(live), true);

console.log('phase12 resource budget cancellation: ok');

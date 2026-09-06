import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDynamicSymbolBudget,
  DEFAULT_DYNAMIC_SYMBOL_LIMITS,
} from '../../../js/binary/dynamic-symbol-budget.js';

const LIMIT_FIELDS = Object.keys(DEFAULT_DYNAMIC_SYMBOL_LIMITS);

function assertDefaultsFor(value) {
  const limits = Object.fromEntries(LIMIT_FIELDS.map((field) => [field, value]));
  limits.now = () => 0;
  const budget = createDynamicSymbolBudget({ limits });
  for (const field of LIMIT_FIELDS) {
    assert.equal(budget.limits[field], DEFAULT_DYNAMIC_SYMBOL_LIMITS[field], field);
  }
}

test('#3692 primitive positive safe integer limits are preserved', () => {
  const limits = Object.fromEntries(LIMIT_FIELDS.map((field, index) => [field, index + 1]));
  limits.now = () => 0;
  const budget = createDynamicSymbolBudget({ limits });
  for (const [index, field] of LIMIT_FIELDS.entries()) {
    assert.equal(budget.limits[field], index + 1, field);
  }
});

test('#3692 coercible non-number limits fall back to defaults', () => {
  for (const value of ['1', ['1'], true, { valueOf: () => 1 }]) {
    assertDefaultsFor(value);
  }
});

test('#3692 invalid primitive number limits still fall back to defaults', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assertDefaultsFor(value);
  }
});

test('#3692 claimInput accounting is unchanged for valid typed limits', () => {
  const budget = createDynamicSymbolBudget({ limits: { maxInputBytes: 4, now: () => 0 } });
  assert.equal(budget.claimInput(4), true);
  assert.equal(budget.claimInput(1), false);
  assert.equal(budget.stopped, true);
});

test('#3692 step accounting is unchanged for valid typed limits', () => {
  const budget = createDynamicSymbolBudget({ limits: { maxOperations: 2, now: () => 0 } });
  assert.equal(budget.step(), true);
  assert.equal(budget.step(), true);
  assert.equal(budget.step(), false);
  assert.equal(budget.stopped, true);
});

test('#3692 claimOutput accounting is unchanged for valid typed limits', () => {
  const budget = createDynamicSymbolBudget({
    limits: { maxOutputObjects: 2, maxEstimatedBytes: 16, now: () => 0 },
  });
  assert.equal(budget.claimOutput(2, 8), true);
  assert.equal(budget.claimOutput(1, 8), false);
  assert.equal(budget.stopped, true);
});

import assert from 'node:assert/strict';
import {
  createDynamicSymbolBudget,
  DEFAULT_DYNAMIC_SYMBOL_LIMITS,
} from '../../js/binary/dynamic-symbol-budget.js';

const fields = [
  'maxSymbolRecords',
  'maxOutputObjects',
  'maxInputBytes',
  'maxOperations',
  'maxWallMs',
  'maxEstimatedBytes',
];

const configured = Object.fromEntries(fields.map((field, index) => [field, index + 1]));
const valid = createDynamicSymbolBudget({ limits: { ...configured, now: () => 0 } });
for (const field of fields) assert.equal(valid.limits[field], configured[field]);

const invalidValues = [
  '1',
  ['1'],
  true,
  false,
  { valueOf() { return 1; } },
  null,
  1.5,
  0,
  -1,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
];
for (const value of invalidValues) {
  const limits = Object.fromEntries(fields.map((field) => [field, value]));
  const budget = createDynamicSymbolBudget({ limits: { ...limits, now: () => 0 } });
  for (const field of fields) {
    assert.equal(
      budget.limits[field],
      DEFAULT_DYNAMIC_SYMBOL_LIMITS[field],
      `${field} should reject ${Object.prototype.toString.call(value)}`,
    );
  }
}

const counterexample = createDynamicSymbolBudget({
  limits: {
    maxSymbolRecords: ['1'],
    maxOperations: true,
    maxInputBytes: '1024',
    now: () => 0,
  },
});
assert.equal(counterexample.limits.maxSymbolRecords, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxSymbolRecords);
assert.equal(counterexample.limits.maxOperations, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxOperations);
assert.equal(counterexample.limits.maxInputBytes, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxInputBytes);

const accounting = createDynamicSymbolBudget({
  limits: {
    maxSymbolRecords: 2,
    maxOutputObjects: 1,
    maxInputBytes: 4,
    maxOperations: 2,
    maxWallMs: 10_000,
    maxEstimatedBytes: 8,
    now: () => 0,
  },
});
assert.equal(accounting.claimInput(4), true);
assert.equal(accounting.step(2), true);
assert.equal(accounting.claimOutput(1, 8), true);
const snapshot = accounting.snapshot();
assert.deepEqual(
  {
    inputBytes: snapshot.inputBytes,
    operations: snapshot.operations,
    outputObjects: snapshot.outputObjects,
    estimatedBytes: snapshot.estimatedBytes,
  },
  { inputBytes: 4, operations: 2, outputObjects: 1, estimatedBytes: 8 },
);

console.log('issue-3692-dynamic-symbol-budget-limit-types: PASS');

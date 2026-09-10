import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRelocationBudget,
  DEFAULT_RELOCATION_BUDGET_LIMITS,
} from '../../../js/binary/relocation-budget.js';

const LIMIT_FIELDS = Object.keys(DEFAULT_RELOCATION_BUDGET_LIMITS);

function budgetWithEveryLimit(value) {
  return createRelocationBudget({
    limits: {
      ...Object.fromEntries(LIMIT_FIELDS.map((field) => [field, value])),
      now: () => 0,
    },
  });
}

function assertDefaultsFor(value) {
  const budget = budgetWithEveryLimit(value);
  for (const field of LIMIT_FIELDS) {
    assert.equal(budget.limits[field], DEFAULT_RELOCATION_BUDGET_LIMITS[field], field);
  }
}

test('#5136 primitive positive safe-integer limits are preserved', () => {
  const values = {
    maxOutput: 1,
    maxInputBytes: 2,
    maxOperations: 3,
    maxWallMs: 4,
  };
  const budget = createRelocationBudget({ limits: { ...values, now: () => 0 } });
  assert.deepEqual(budget.limits, values);
});

test('#5136 coercible non-number limits fall back instead of entering resource accounting', () => {
  for (const value of ['1', ['1'], true, false, null, { valueOf: () => 1 }]) {
    assertDefaultsFor(value);
  }
});

test('#5136 malformed objects are not coerced while validating limits', () => {
  let coercions = 0;
  const hostile = {
    valueOf() {
      coercions += 1;
      return 1;
    },
    toString() {
      coercions += 1;
      return '1';
    },
  };
  assertDefaultsFor(hostile);
  assert.equal(coercions, 0, 'typed budget validation must not execute coercion hooks');
});

test('#5136 invalid primitive-number limits fall back to defaults', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assertDefaultsFor(value);
  }
});

test('#5136 valid limit accounting, stop latch, and snapshot semantics are unchanged', () => {
  const input = createRelocationBudget({ limits: { maxInputBytes: 4, now: () => 0 } });
  assert.equal(input.claimInput(4), true);
  assert.equal(input.claimInput(1), false);
  assert.equal(input.stopped, true);
  const inputReason = input.reason;
  assert.equal(input.claimInput(0), false, 'stopped budget stays latched');
  assert.equal(input.reason, inputReason);
  assert.equal(input.snapshot().inputBytes, 4);

  const ops = createRelocationBudget({ limits: { maxOperations: 2, maxWallMs: 10_000, now: () => 0 } });
  assert.equal(ops.step(), true);
  assert.equal(ops.step(), true);
  assert.equal(ops.step(), false);
  assert.equal(ops.snapshot().operations, 3);

  const output = createRelocationBudget({ limits: { maxOutput: 1, now: () => 0 } });
  const out = [];
  assert.equal(output.push(out, 'first'), true);
  assert.equal(output.push(out, 'second'), false);
  assert.deepEqual(out, ['first']);
});

test('#5136 claimInput/step reject malformed costs without coercion', () => {
  const input = createRelocationBudget({ limits: { now: () => 0 } });
  assert.equal(input.claimInput('1'), false);
  assert.equal(input.snapshot().inputBytes, 0);

  const ops = createRelocationBudget({ limits: { now: () => 0 } });
  assert.equal(ops.step(['1']), false);
  assert.equal(ops.snapshot().operations, 0);
});

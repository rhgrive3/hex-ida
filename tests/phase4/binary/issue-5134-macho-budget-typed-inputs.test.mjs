import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMachOMetadataBudget,
  MACHO_METADATA_LIMITS,
} from '../../../js/binary/macho-budget.js';

const LIMIT_FIELDS = Object.keys(MACHO_METADATA_LIMITS);
const COST_FIELDS = LIMIT_FIELDS.filter((field) => field !== 'wallClockMs');

function image() {
  return { metadata: {}, warnings: [] };
}

function assertLimitFallback(value) {
  for (const option of ['limits', 'metadataLimits']) {
    const target = image();
    const limits = Object.fromEntries(LIMIT_FIELDS.map((field) => [field, value]));
    const budget = createMachOMetadataBudget(target, { [option]: limits });
    for (const field of LIMIT_FIELDS) {
      assert.equal(budget.limits[field], MACHO_METADATA_LIMITS[field], `${option}.${field}`);
      assert.equal(target.metadata.machoMetadata.limits[field], MACHO_METADATA_LIMITS[field], `metadata ${option}.${field}`);
    }
  }
}

test('#5134 primitive safe integer limits keep their exact values, including the established zero budget', () => {
  const target = image();
  const limits = Object.fromEntries(LIMIT_FIELDS.map((field, index) => [field, index]));
  const budget = createMachOMetadataBudget(target, { limits });
  for (const [index, field] of LIMIT_FIELDS.entries()) {
    assert.equal(budget.limits[field], index, field);
  }
});

test('#5134 coercible structured/non-number limits fall back without invoking coercion hooks', () => {
  let valueOfCalls = 0;
  const coercibleObject = { valueOf() { valueOfCalls += 1; return 1; } };
  for (const value of ['1', ['1'], true, false, null, 1n, Symbol('1'), coercibleObject]) assertLimitFallback(value);
  assert.equal(valueOfCalls, 0, 'limit validation must not invoke valueOf/ToNumber');
});

test('#5134 invalid primitive number limits still fall back to defaults', () => {
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assertLimitFallback(value);
});

test('#5134 primitive non-negative safe integer costs preserve existing accounting', () => {
  const target = image();
  const budget = createMachOMetadataBudget(target, {
    limits: Object.fromEntries(LIMIT_FIELDS.map((field) => [field, 100])),
  });
  const cost = Object.fromEntries(COST_FIELDS.map((field, index) => [field, index]));
  assert.equal(budget.take(cost, 'typed-cost'), true);
  for (const [index, field] of COST_FIELDS.entries()) assert.equal(budget.used[field], index, field);
  assert.equal(target.metadata.machoMetadata.complete, true);
});

test('#5134 malformed cost fails closed atomically and is never recorded as coerced usage', () => {
  const malformedValues = ['4', '', [1], [], true, false, null, 1n, Symbol('1'), { valueOf: () => 1 }, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const field of COST_FIELDS) {
    for (const value of malformedValues) {
      const target = image();
      const budget = createMachOMetadataBudget(target);
      const before = { ...budget.used };
      assert.equal(budget.take({ [field]: value }, 'schema-invalid'), false, `${field}: ${String(value)}`);
      assert.equal(budget.stopped, true, field);
      assert.equal(target.metadata.machoMetadata.complete, false, field);
      assert.deepEqual(budget.used, before, `${field} must not record coerced usage`);
    }
  }
});

test('#5134 malformed cost cannot invoke user coercion hooks', () => {
  let valueOfCalls = 0;
  const target = image();
  const budget = createMachOMetadataBudget(target);
  assert.equal(budget.take({ records: { valueOf() { valueOfCalls += 1; return 1; } } }, 'coercion'), false);
  assert.equal(valueOfCalls, 0);
  assert.equal(budget.used.records, 0);
});

import assert from 'node:assert/strict';
import {
  createELFMetadataBudget,
  ELF_METADATA_LIMITS,
} from '../../js/binary/elf-budget.js';

function image() {
  return { metadata:{}, warnings:[] };
}

const fields = Object.keys(ELF_METADATA_LIMITS);
const validLimits = Object.fromEntries(fields.map((field, index) => [field, index]));
const valid = createELFMetadataBudget(image(), { limits:validLimits });
for (const field of fields) assert.equal(valid.limits[field], validLimits[field]);

const invalidValues = [
  '1',
  ['1'],
  true,
  false,
  { valueOf() { return 1; } },
  null,
  1.5,
  -1,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
];
for (const value of invalidValues) {
  const limits = Object.fromEntries(fields.map((field) => [field, value]));
  const budget = createELFMetadataBudget(image(), { limits });
  for (const field of fields) {
    assert.equal(
      budget.limits[field],
      ELF_METADATA_LIMITS[field],
      `${field} should reject ${Object.prototype.toString.call(value)}`,
    );
  }
}

const counterexample = createELFMetadataBudget(image(), {
  limits: {
    records: ['1'],
    stringBytes: '8',
  },
});
assert.equal(counterexample.limits.records, ELF_METADATA_LIMITS.records);
assert.equal(counterexample.limits.stringBytes, ELF_METADATA_LIMITS.stringBytes);

const accountingImage = image();
const accounting = createELFMetadataBudget(accountingImage, {
  limits: {
    inputBytes: 4,
    records: 1,
    objects: 1,
    stringBytes: 8,
    operations: 2,
    estimatedHeapBytes: 16,
    wallClockMs: 10_000,
  },
});
assert.equal(accounting.take({
  inputBytes: 4,
  records: 1,
  objects: 1,
  stringBytes: 8,
  operations: 2,
  estimatedHeapBytes: 16,
}, 'valid'), true);
assert.deepEqual(accounting.snapshot().used, {
  inputBytes: 4,
  records: 1,
  objects: 1,
  stringBytes: 8,
  operations: 2,
  estimatedHeapBytes: 16,
});

for (const [key, value] of [
  ['records', [1]],
  ['inputBytes', '4'],
  ['operations', true],
  ['objects', { valueOf() { return 1; } }],
  ['stringBytes', null],
  ['estimatedHeapBytes', 1.5],
]) {
  const img = image();
  const budget = createELFMetadataBudget(img, { limits:{ wallClockMs:10_000 } });
  assert.equal(budget.take({ [key]:value }, `invalid-${key}`), false);
  assert.equal(budget.stopped, true);
  assert.deepEqual(budget.snapshot().used, {
    inputBytes: 0,
    records: 0,
    objects: 0,
    stringBytes: 0,
    operations: 0,
    estimatedHeapBytes: 0,
  });
  assert.ok(
    budget.snapshot().reasons.includes(`budget:invalid-${key}:${key}:invalid-cost`),
    `${key} invalid cost must fail closed`,
  );
}

console.log('issue-3699-elf-budget-limit-cost-types: PASS');

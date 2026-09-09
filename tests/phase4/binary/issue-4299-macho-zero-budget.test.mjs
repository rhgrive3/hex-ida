import assert from 'node:assert/strict';
import test from 'node:test';
import { createMachOMetadataBudget, MACHO_METADATA_LIMITS } from '../../../js/binary/macho-budget.js';

for (const dimension of Object.keys(MACHO_METADATA_LIMITS)) {
  test(`Mach-O preserves explicit zero ${dimension} in both option spellings`, () => {
    for (const option of ['limits', 'metadataLimits']) {
      const image = { metadata: {}, warnings: [] };
      const budget = createMachOMetadataBudget(image, { [option]: { [dimension]: 0 } });
      assert.equal(budget.limits[dimension], 0);
      assert.equal(budget.remaining(dimension), 0);
      assert.equal(budget.snapshot().limits[dimension], 0);
      if (dimension !== 'wallClockMs') {
        assert.equal(budget.take({ [dimension]: 1 }), false);
        assert.equal(budget.used[dimension], 0);
        assert.equal(image.metadata.machoMetadata.complete, false);
      }
    }
  });
}

test('zero warning budget emits no warning and clamps a seeded count', () => {
  const image = { metadata: {}, warnings: ['preexisting'] };
  const budget = createMachOMetadataBudget(image, { limits: { warnings: 0 } });
  assert.equal(budget.used.warnings, 0);
  assert.equal(budget.warn('new'), false);
  assert.deepEqual(image.warnings, ['preexisting']);
});

test('zero wall-clock budget uses the existing sampled deadline check', () => {
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const image = { metadata: {}, warnings: [] };
    const budget = createMachOMetadataBudget(image, { limits: { wallClockMs: 0 } });
    now = 1;
    assert.equal(budget.take({ operations: 1024 }), false);
    assert.deepEqual(image.metadata.machoMetadata.reasons, ['budget:wall-clock']);
  } finally {
    Date.now = realNow;
  }
});

test('zero does not turn omitted, malformed or coercive zero values into restrictive defaults', () => {
  for (const value of [undefined, null, false, '', ' ', '1', [], {}, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const budget = createMachOMetadataBudget({ metadata: {}, warnings: [] }, { limits: { records: value } });
    assert.equal(budget.limits.records, MACHO_METADATA_LIMITS.records, String(value));
  }
  for (const value of [1, 2]) {
    const budget = createMachOMetadataBudget({ metadata: {}, warnings: [] }, { limits: { records: value } });
    assert.equal(budget.limits.records, value);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

// #4313: compareExpected() chose the expected field width with a bare
// Number(expected.field.bits || 64) coercion. A structured / boolean / string
// width was promoted to a canonical width and changed the modulo normalization
// itself, so a value that clearly differs at the real width (e.g. 257n vs 1n at
// 64 bits) could be reported `supported`. Width authority must be validated:
// only an explicit canonical width is accepted; nullish keeps the 64 default;
// invalid / zero / fraction / unsafe widths fail closed to inconclusive.
import { compareExpected } from '../../js/dynamic/experiments.js';

function spec(bits) {
  const field = { offset: 0n, value: 1n, signed: false };
  if (bits !== undefined) field.bits = bits;
  return { expected: { field } };
}

test('#4313 structured Array bits cannot coerce a differing value to supported', () => {
  // Number(['8']) === 8 so 257n % 2**8 === 1n would alias to the expected 1n.
  const result = compareExpected(spec(['8']), {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, size: 1, value: 257n }],
    memoryDelta: [],
  });
  assert.notEqual(result.status, 'supported');
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'invalid-expected-field-bits');
});

test('#4313 string bits cannot coerce a differing value to supported', () => {
  // Number('64') === 64 lets 1n match at width 64 even though the width was
  // a schema-violating string, not a canonical number.
  const result = compareExpected(spec('64'), {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, size: 8, value: 1n }],
    memoryDelta: [],
  });
  assert.notEqual(result.status, 'supported');
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'invalid-expected-field-bits');
});

test('#4313 explicit bits:0 is not conflated with the unspecified default', () => {
  // 0 || 64 would silently use 64 and "support" a real match; 0 is an invalid
  // width, not "unspecified".
  const result = compareExpected(spec(0), {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, size: 8, value: 1n }],
    memoryDelta: [],
  });
  assert.notEqual(result.status, 'supported');
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'invalid-expected-field-bits');
});

test('#4313 boolean / unsafe / fraction / out-of-domain widths fail closed', () => {
  for (const bits of [true, false, 9007199254740993, 8.5, -8, 12, 72, {}, ['64']]) {
    const result = compareExpected(spec(bits), {
      stop: { kind: 'return' },
      memoryAfter: [{ offset: 0n, size: 8, value: 1n }],
      memoryDelta: [],
    });
    assert.notEqual(result.status, 'supported', `width ${String(bits)} was accepted`);
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.reason, 'invalid-expected-field-bits');
  }
});

test('#4313 canonical widths and the nullish default are preserved', () => {
  const width64 = compareExpected(spec(64), {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, size: 8, value: 1n }],
    memoryDelta: [],
  });
  assert.equal(width64.status, 'supported');

  const width16 = compareExpected(
    { expected: { field: { offset: 0n, value: 1n, bits: 16, signed: false } } },
    { stop: { kind: 'return' }, memoryAfter: [{ offset: 0n, size: 2, value: 1n }], memoryDelta: [] },
  );
  assert.equal(width16.status, 'supported');

  const defaulted = compareExpected(spec(undefined), {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, size: 8, value: 1n }],
    memoryDelta: [],
  });
  assert.equal(defaulted.status, 'supported');
  assert.equal(defaulted.expected, 1n);
});

test('#4313 generated expected fields still verify end to end', () => {
  const contradicted = compareExpected(spec(64), {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, size: 8, value: 257n }],
    memoryDelta: [],
  });
  assert.equal(contradicted.status, 'contradicted');
});

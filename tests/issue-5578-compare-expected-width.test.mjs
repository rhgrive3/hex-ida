import test from 'node:test';
import assert from 'node:assert/strict';
import { compareExpected } from '../js/dynamic/experiments.js';

// #5578: compareExpected() selected memory observations by offset alone and
// ignored the observation entry's `size`, so a 1-byte observation could
// validate (or contradict) a 64-bit field expectation. The observation width
// is part of the field contract (compileExperiment() watches exactly
// fieldBits/8 bytes); only an exactly-wide observation may produce the strong
// supported/contradicted verdicts — anything else is inconclusive.

const caseSpec = {
  expected: { field: { offset: 0n, value: 1n, bits: 64, signed: false } },
};

test('5578: under-width observation cannot support a 64-bit expectation', () => {
  const result = compareExpected(caseSpec, {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, size: 1, value: 1n }],
    memoryDelta: [],
  });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'observed-field-width-mismatch');
  assert.equal(result.observedWidth, 1);
  assert.equal(result.expectedWidth, 8);
});

test('5578: under-width observation cannot contradict a 64-bit expectation', () => {
  const result = compareExpected(caseSpec, {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, size: 1, value: 2n }],
    memoryDelta: [],
  });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'observed-field-width-mismatch');
});

test('5578: observation without a width is inconclusive', () => {
  const result = compareExpected(caseSpec, {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, value: 1n }],
    memoryDelta: [],
  });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'observed-field-width-unknown');
});

test('5578: delta-fallback observations honor the same width contract', () => {
  const result = compareExpected(caseSpec, {
    stop: { kind: 'return' },
    memoryAfter: [],
    memoryDelta: [{ offset: 0n, size: 8, after: 1n }],
  });
  assert.equal(result.status, 'supported', 'an exactly-wide delta observation still supports');
  assert.equal(result.source, 'delta-final');
});

test('5578: over-width observation is inconclusive', () => {
  const result = compareExpected(caseSpec, {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, size: 16, value: 1n }],
    memoryDelta: [],
  });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'observed-field-width-mismatch');
});

test('5578: exactly-wide matching observation still supports', () => {
  const result = compareExpected(caseSpec, {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, size: 8, value: 1n }],
    memoryDelta: [],
  });
  assert.equal(result.status, 'supported');
  assert.equal(result.observed, 1n);
  assert.equal(result.expected, 1n);
});

test('5578: exactly-wide contradicting observation still contradicts', () => {
  const result = compareExpected(caseSpec, {
    stop: { kind: 'return' },
    memoryAfter: [{ offset: 0n, size: 8, value: 0xFFFFn }],
    memoryDelta: [],
  });
  assert.equal(result.status, 'contradicted');
  assert.equal(result.reason, 'observed-field-mismatch');
});

import assert from 'node:assert/strict';
import { compileExperiment } from '../js/dynamic/experiments.js';

// Issue #5060: relationExpected() wrapped the arithmetic result into the fixed
// field width (normalizeInteger) BEFORE applying clampMin/clampMax, so an
// unsigned underflow wrapped to 2^bits-1 and slipped past the lower bound (and
// an overflow slipped past the upper bound). Clamps must saturate the raw
// mathematical result; only afterwards may the value be normalized. Without
// clamps the existing fixed-width wrap behavior is unchanged.

function expectedFor(hypothesisOverrides, value) {
  const experiment = compileExperiment({
    id: 'clamp-order',
    functionAddress: 0x1000n,
    fieldOffset: 0n,
    ...hypothesisOverrides,
  }, { inputs: [{ id: 'one', kind: 'scalar', value }] });
  assert.equal(experiment.cases.length, 1);
  return experiment.cases[0].expected.field.value;
}

assert.equal(
  expectedFor({ fieldSize: 1, signed: false, initial: 0n, operation: 'sub', clampMin: 0n }, 1n),
  0n, 'uint8 0-1 with clampMin 0 saturates to 0');

assert.equal(
  expectedFor({ fieldSize: 1, signed: false, initial: 255n, operation: 'add', clampMax: 255n }, 1n),
  255n, 'uint8 255+1 with clampMax 255 saturates to 255');

assert.equal(
  expectedFor({ fieldSize: 1, signed: true, initial: 127n, operation: 'add', clampMax: 127n }, 1n),
  127n, 'int8 127+1 with clampMax 127 saturates to 127');

assert.equal(
  expectedFor({ fieldSize: 1, signed: true, initial: -128n, operation: 'sub', clampMin: -128n }, 1n),
  -128n, 'int8 -128-1 with clampMin -128 saturates to -128');

assert.equal(
  expectedFor({ fieldSize: 1, signed: false, initial: 0n, operation: 'sub' }, 1n),
  255n, 'clamp-free uint8 sub still wraps');
assert.equal(
  expectedFor({ fieldSize: 1, signed: false, initial: 255n, operation: 'add' }, 1n),
  0n, 'clamp-free uint8 add still wraps');
assert.equal(
  expectedFor({ fieldSize: 1, signed: true, initial: 127n, operation: 'add' }, 1n),
  -128n, 'clamp-free int8 add still wraps');

assert.equal(
  expectedFor({ fieldSize: 1, signed: false, initial: 5n, operation: 'add', clampMin: 0n, clampMax: 255n }, 3n),
  8n, 'in-range add is identical with clamps');
assert.equal(
  expectedFor({ fieldSize: 1, signed: false, initial: 5n, operation: 'add' }, 3n),
  8n, 'in-range add without clamps');
assert.equal(
  expectedFor({ fieldSize: 1, signed: true, initial: -5n, operation: 'sub', clampMin: -128n, clampMax: 127n }, -3n),
  -2n, 'in-range signed sub is identical with clamps');

assert.equal(
  expectedFor({ fieldSize: 1, signed: false, initial: 5n, operation: 'damage', clampMin: 0n }, 10n),
  0n, 'damage alias saturates at clampMin');
assert.equal(
  expectedFor({ fieldSize: 1, signed: false, initial: 5n, operation: 'decrement', clampMin: 0n }, 10n),
  0n, 'decrement alias saturates at clampMin');
assert.equal(
  expectedFor({ fieldSize: 1, signed: false, initial: 250n, operation: 'increment', clampMax: 255n }, 10n),
  255n, 'increment alias saturates at clampMax');

console.log('issue-5060 clamp-before-wrap: ok');

// Regression for #5724: dynamic experiment machine-integer inputs must reject
// unsafe numbers instead of silently freezing an IEEE-754-rounded value into a
// BigInt machine value.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateDifferentialInputs, compileExperiment } from '../js/dynamic/experiments.js';

const UNSAFE = 9007199254740993; // 2^53 + 1, not representable as a number

test('#5724 differential boundary from an unsafe number fails closed', () => {
  assert.throws(() => generateDifferentialInputs({ bits: 64, signed: false, boundary: UNSAFE }), /machine integer|invalid-number/i);
});

test('#5724 differential expected from an unsafe number fails closed', () => {
  assert.throws(() => generateDifferentialInputs({ bits: 64, signed: false, expected: UNSAFE }), /machine integer|invalid-number/i);
});

test('#5724 no silently rounded boundary value reaches the generated inputs', () => {
  // If any conversion path still accepts the unsafe number, the generated
  // inputs contain 2^53 (the rounded neighbour) as a machine value.
  try {
    const inputs = generateDifferentialInputs({ bits: 64, signed: false, boundary: UNSAFE, limit: 64 });
    assert.ok(!inputs.some((i) => i.kind === 'scalar' && i.value === 9007199254740992n), 'rounded 2^53 must not appear as a machine value');
  } catch (error) {
    // Failing closed is the expected outcome.
    assert.match(error.message, /machine integer|invalid-number/i);
  }
});

test('#5724 compileExperiment initial from an unsafe number fails closed', () => {
  assert.throws(
    () => compileExperiment({ id: 'x', functionAddress: 0x1000n, fieldOffset: 0n, fieldSize: 8, initial: UNSAFE, argumentIndex: 1, operation: 'set' }),
    /machine integer|invalid-number/i,
  );
});

test('#5724 clamp bounds from unsafe numbers fail closed', () => {
  assert.throws(
    () => compileExperiment({ id: 'x', functionAddress: 0x1000n, fieldOffset: 0n, fieldSize: 8, argumentIndex: 1, operation: 'add', clampMin: UNSAFE }),
    /machine integer|invalid-number/i,
  );
});

test('#5724 canonical machine-integer inputs keep working', () => {
  const inputs = generateDifferentialInputs({ bits: 32, boundary: 100, pointer: false });
  assert.ok(inputs.some((x) => x.kind === 'scalar' && x.value === 100n));
  assert.ok(inputs.some((x) => x.kind === 'scalar' && x.value === 99n));
  const fromString = generateDifferentialInputs({ bits: 64, signed: false, boundary: '9223372036854775807', limit: 64 });
  assert.ok(fromString.some((x) => x.kind === 'scalar' && x.value === 9223372036854775807n));
  const exp = compileExperiment({ id: 'ok', functionAddress: 0x1000n, fieldOffset: 0n, fieldSize: 8, initial: 100n, argumentIndex: 1, operation: 'add' });
  assert.ok(exp.cases.length >= 6);
});

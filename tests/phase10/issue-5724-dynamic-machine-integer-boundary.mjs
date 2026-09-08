// Regression for #5724: dynamic experiment machine-integer inputs must reject
// unsafe numbers instead of silently freezing an IEEE-754-rounded value into a
// BigInt machine value.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateDifferentialInputs, compileExperiment } from '../../js/dynamic/experiments.js';

const UNSAFE = 9007199254740993; // 2^53 + 1, not representable as a number

function assertInvalidMachineInteger(fn) {
  assert.throws(fn, (error) => error?.code === 'invalid-machine-integer');
}

test('#5724 differential boundary from an unsafe number fails closed', () => {
  assertInvalidMachineInteger(() => generateDifferentialInputs({ bits: 64, signed: false, boundary: UNSAFE }));
});

test('#5724 differential expected from an unsafe number fails closed', () => {
  assertInvalidMachineInteger(() => generateDifferentialInputs({ bits: 64, signed: false, expected: UNSAFE }));
});

test('#5724 no silently rounded boundary value reaches the generated inputs', () => {
  // Rejecting before conversion is the only safe outcome: the original
  // integer cannot be recovered from an IEEE-754-rounded number.
  assertInvalidMachineInteger(() => generateDifferentialInputs({ bits: 64, signed: false, boundary: UNSAFE, limit: 64 }));
});

test('#5724 compileExperiment initial from an unsafe number fails closed', () => {
  assertInvalidMachineInteger(
    () => compileExperiment({ id: 'x', functionAddress: 0x1000n, fieldOffset: 0n, fieldSize: 8, initial: UNSAFE, argumentIndex: 1, operation: 'set' }),
  );
});

test('#5724 clampMin from an unsafe number fails closed', () => {
  assertInvalidMachineInteger(
    () => compileExperiment({ id: 'x', functionAddress: 0x1000n, fieldOffset: 0n, fieldSize: 8, argumentIndex: 1, operation: 'add', clampMin: UNSAFE }),
  );
});

test('#5724 clampMax from an unsafe number fails closed', () => {
  assertInvalidMachineInteger(
    () => compileExperiment({ id: 'x', functionAddress: 0x1000n, fieldOffset: 0n, fieldSize: 8, argumentIndex: 1, operation: 'add', clampMax: UNSAFE }),
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

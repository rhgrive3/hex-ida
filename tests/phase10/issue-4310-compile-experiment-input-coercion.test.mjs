import assert from 'node:assert/strict';
import { test } from 'node:test';

// #4310: compileExperiment() promoted caller-supplied options.inputs values
// with a bare BigInt() coercion, so a schema-violating structured value such as
// ['5'] became a canonical integer runtime case (input argument, scalar AND the
// expected field value). Custom scalar/pointer input values must be validated as
// canonical machine integers and fail closed instead of being coerced.
import { compileExperiment } from '../../js/dynamic/experiments.js';

const STRUCTURED = [
  ['5'],
  { toString: () => '5' },
  true,
  false,
  [],
  Symbol('5'),
  null,
  undefined,
  {},
];

function assertInvalidInput(fn) {
  assert.throws(fn, (error) => error?.code === 'invalid-experiment-input');
}

test('#4310 structured / coerced custom input value fails closed', () => {
  for (const value of STRUCTURED) {
    assertInvalidInput(() => compileExperiment(
      { id: 'h1', functionAddress: 0x1000n, fieldOffset: 0n, operation: 'set' },
      { inputs: [{ id: 'malformed', kind: 'scalar', value }] },
    ));
  }
});

test('#4310 a coerced Array input never reaches the runtime case', () => {
  let experiment;
  try {
    experiment = compileExperiment(
      { id: 'h1', functionAddress: 0x1000n, fieldOffset: 0n, operation: 'set' },
      { inputs: [{ id: 'malformed', kind: 'scalar', value: ['5'] }] },
    );
  } catch {
    return; // fail closed is the expected outcome
  }
  assert.fail(`structured input produced a case: ${JSON.stringify(experiment.cases[0]?.input?.scalar)}`);
});

test('#4310 invalid (non-object) custom input item is handled explicitly', () => {
  assertInvalidInput(() => compileExperiment(
    { id: 'h1', functionAddress: 0x1000n, fieldOffset: 0n, operation: 'set' },
    { inputs: [null] },
  ));
  assertInvalidInput(() => compileExperiment(
    { id: 'h1', functionAddress: 0x1000n, fieldOffset: 0n, operation: 'set' },
    { inputs: [undefined] },
  ));
});

test('#4310 canonical custom scalar / pointer integer inputs are preserved', () => {
  const fromBigInt = compileExperiment(
    { id: 'h1', functionAddress: 0x1000n, fieldOffset: 0n, fieldSize: 8, signed: false, initial: 0n, operation: 'set' },
    { inputs: [{ id: 'a', kind: 'scalar', value: 5n }] },
  );
  assert.equal(fromBigInt.cases[0].input.scalar, 5n);
  assert.equal(fromBigInt.cases[0].expected.field.value, 5n);

  const fromSafeNumber = compileExperiment(
    { id: 'h1', functionAddress: 0x1000n, fieldOffset: 0n, fieldSize: 8, signed: false, initial: 0n, operation: 'set' },
    { inputs: [{ id: 'a', kind: 'scalar', value: 5 }] },
  );
  assert.equal(fromSafeNumber.cases[0].input.scalar, 5n);

  const pointer = compileExperiment(
    { id: 'h1', functionAddress: 0x1000n, fieldOffset: 0n, operation: 'set', argumentKind: 'pointer' },
    { inputs: [{ id: 'p', kind: 'pointer', value: 0n }] },
  );
  assert.equal(pointer.cases[0].input.scalar, 0n);
});

test('#4310 generator-produced bigint inputs keep the existing case set', () => {
  const generated = compileExperiment({
    id: 'gen', functionAddress: 0x1000n, fieldOffset: 0n, fieldSize: 8,
    signed: false, initial: 100n, argumentIndex: 1, operation: 'add',
  });
  assert.ok(generated.cases.length >= 6);
  for (const testCase of generated.cases) {
    assert.equal(typeof testCase.input.scalar, 'bigint');
  }
});

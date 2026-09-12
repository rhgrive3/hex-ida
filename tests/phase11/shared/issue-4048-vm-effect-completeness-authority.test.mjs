import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createVMEffectBundle,
  createVMEffectFunction,
  validateVMEffectBundle,
  validateVMEffectFunction,
} from '../../../js/managed/shared/vm-effects.js';

const identity = {
  frontendId: 'wasm',
  methodId: 'managed-method:issue-4048',
  operationId: 'vm-op:managed-method:issue-4048:0x0:0',
};

test('#4048 omitted completeness cannot mint exact authority', () => {
  assert.throws(
    () => createVMEffectBundle(identity),
    /vm-effect-completeness-required/,
  );
});

test('#4048 exact authority requires structural operation semantics', () => {
  for (const completeness of ['exact', 'exact-with-intrinsic']) {
    assert.throws(
      () => createVMEffectBundle({ ...identity, completeness }),
      /vm-effect-exact-semantics-required/,
      `${completeness} identity-only bundle must fail closed`,
    );
  }

  const forged = {
    schemaVersion: 1,
    contractVersion: '1.0.0',
    frontendId: 'wasm',
    frontendSemanticVersion: '1.0.0',
    profileId: null,
    methodId: identity.methodId,
    operationId: identity.operationId,
    bytecodeOffset: 0,
    opcode: null,
    mnemonic: null,
    consumedValues: [], producedValues: [],
    locationReads: [], locationWrites: [], memoryEffects: [],
    callEffects: [], controlEffects: [], possibleExceptions: [],
    origin: {}, completeness: 'exact', unknownEffects: [], metadata: {},
  };
  assert.throws(
    () => validateVMEffectBundle(forged),
    /vm-effect-exact-semantics-required/,
    'validator must not bless a hand-made identity-only exact bundle',
  );
  for (const fakeEvidence of [new Array(1), [undefined], [null]]) {
    assert.throws(
      () => createVMEffectBundle({ ...identity, completeness: 'exact', consumedValues: fakeEvidence }),
      /vm-effect-exact-semantics-required/,
      'sparse/nullish collection slots are not semantic evidence',
    );
  }
});

test('#4048 known operations remain exact across all four managed frontends', () => {
  const fixtures = [
    ['wasm', 0x41, 'i32.const', { producedValues: [{ bits: 32, constant: 1 }] }],
    ['dex', 0x52, 'iget', { memoryEffects: [{ space: 'field', isWrite: false }] }],
    ['cil', 0x28, 'call', { callEffects: [{ target: 'M::F', unresolved: false }] }],
    ['jvm', 0xa7, 'goto', { controlEffects: [{ kind: 'branch', targetOffset: 4 }] }],
  ];
  for (const [frontendId, opcode, mnemonic, effects] of fixtures) {
    const bundle = createVMEffectBundle({
      frontendId,
      methodId: `managed-method:issue-4048:${frontendId}`,
      operationId: `vm-op:issue-4048:${frontendId}:0`,
      opcode,
      mnemonic,
      completeness: 'exact',
      ...effects,
    });
    assert.equal(bundle.completeness, 'exact');
    assert.equal(validateVMEffectBundle(bundle), true);
  }

  const nop = createVMEffectBundle({
    frontendId: 'wasm',
    methodId: 'managed-method:issue-4048:nop',
    operationId: 'vm-op:issue-4048:nop:0',
    opcode: 0x01,
    mnemonic: 'nop',
    completeness: 'exact',
  });
  assert.equal(validateVMEffectBundle(nop), true, 'an identified exact no-op remains representable');
});

test('#4048 unknown/partial still require explicit unknown effects', () => {
  for (const completeness of ['partial', 'unknown']) {
    assert.throws(
      () => createVMEffectBundle({ ...identity, opcode: 0xff, completeness }),
      /vm-effect-partial-must-specify-unknown-effects/,
    );
  }
});

test('#4048 omitted function resolution cannot mint complete authority', () => {
  const bundle = createVMEffectBundle({
    ...identity,
    opcode: 0x01,
    mnemonic: 'nop',
    completeness: 'exact',
  });
  const conservative = createVMEffectFunction({
    frontendId: 'wasm',
    methodId: identity.methodId,
    bundles: [bundle],
  });
  assert.equal(conservative.aggregateCompleteness, 'exact');
  assert.equal(conservative.resolutionCompleteness, 'partial');
  assert.equal(validateVMEffectFunction(conservative), true);

  const explicit = createVMEffectFunction({
    frontendId: 'wasm',
    methodId: identity.methodId,
    bundles: [bundle],
    resolutionCompleteness: 'complete',
  });
  assert.equal(explicit.resolutionCompleteness, 'complete');
});

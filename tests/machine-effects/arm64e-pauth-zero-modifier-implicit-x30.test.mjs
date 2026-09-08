import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import {
  ARM64E_PAUTH_KEYS,
  isArm64ePointerAuthenticationInstruction,
  liftArm64eEffects,
} from '../../js/targets/architecture/arm64e/index.js';
import { ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { arm64ePointerAuthenticationMnemonics } from '../../js/targets/architecture/arm64e/effects.js';
import { arm64ePointerAuthenticationOperandArities } from '../../js/targets/architecture/arm64e/encoding.js';

let sequence = 0;
function instruction(mnemonic, opStr = '') {
  sequence += 1;
  const instructionId = `arm64e-pauth-z-alias-${sequence}`;
  return {
    instructionId,
    mnemonic,
    opStr,
    ops: parseOperands(opStr),
    mode: 'arm64e',
    address: 0x1000n + BigInt(sequence * 4),
    origin: { instructionIds: [instructionId] },
  };
}

function intrinsic(bundle, id) {
  return bundle.operations.find((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === id);
}

function writtenRegisters(bundle) {
  return bundle.operations
    .filter((operation) => operation.kind === 'register-write')
    .map((operation) => operation.register.registerId);
}

function readRegisters(bundle) {
  return bundle.operations
    .filter((operation) => operation.kind === 'register-read')
    .map((operation) => operation.register.registerId);
}

const ZERO_MODIFIER = { kind: 'constant-zero' };

for (const [mnemonic, transform, keyId] of [
  ['paciaz', 'arm64e.pointer.sign', ARM64E_PAUTH_KEYS.ia],
  ['pacibz', 'arm64e.pointer.sign', ARM64E_PAUTH_KEYS.ib],
  ['autiaz', 'arm64e.pointer.authenticate', ARM64E_PAUTH_KEYS.ia],
  ['autibz', 'arm64e.pointer.authenticate', ARM64E_PAUTH_KEYS.ib],
]) {
  const bundle = liftArm64eEffects(instruction(mnemonic));
  assert.ok(bundle, `${mnemonic}: valid HINT-space PAuth must lift instead of returning null`);
  assert.equal(isArm64ePointerAuthenticationInstruction({ mnemonic }), true, `${mnemonic}: registry membership`);
  assert.equal(bundle.completeness, 'exact-with-intrinsic', `${mnemonic}: zero-modifier implicit-X30 form is exact`);
  assert.equal(bundle.architectureId, 'arm64e');
  assert.ok(intrinsic(bundle, transform), `${mnemonic}: must emit the ${transform} intrinsic`);
  assert.equal(bundle.metadata.keyIdentity, keyId, `${mnemonic}: key identity`);
  assert.equal(bundle.metadata.destinationRegister, 'x30', `${mnemonic}: implicit X30 destination`);
  assert.deepEqual(bundle.metadata.modifier, ZERO_MODIFIER, `${mnemonic}: zero modifier`);
  assert.deepEqual(writtenRegisters(bundle), ['x30'], `${mnemonic}: writes the implicit X30 destination`);
  assert.ok(readRegisters(bundle).includes('x30'), `${mnemonic}: reads the implicit X30 source`);
  assert.ok(readRegisters(bundle).includes(keyId), `${mnemonic}: reads the PAuth key state`);
  assert.ok(readRegisters(bundle).includes('PAuthState'), `${mnemonic}: reads the PAuth architecture state`);
  assert.ok(readRegisters(bundle).every((registerId) => registerId !== 'sp'), `${mnemonic}: SP is not the modifier`);
  if (transform === 'arm64e.pointer.authenticate') {
    assert.equal(bundle.possibleFaults[0].condition.kind, 'pointer-authentication-failed', `${mnemonic}: auth-failure semantics`);
  }
}

for (const mnemonic of ['paciaz', 'pacibz', 'autiaz', 'autibz']) {
  const decoded = instruction(mnemonic, 'x0');
  const bundle = ARM64E_ARCHITECTURE.liftExact(decoded, {});
  assert.ok(bundle, `${mnemonic}: extra operand must fail closed`);
  assert.equal(bundle.completeness, 'partial', `${mnemonic}: extra operand is partial`);
  assert.equal(bundle.metadata?.failClosed, true, `${mnemonic}: arity contract stays fail-closed`);
  assert.equal(bundle.operations.length, 0, `${mnemonic}: extra operand emits zero definite operations`);
  assert.equal(bundle.unknownEffects?.reason, `arm64e-${mnemonic}-operand-shape-invalid`);
  assert.equal(bundle.unknownEffects?.detail?.expectedOperandCount, 0);
  assert.equal(bundle.unknownEffects?.detail?.actualOperandCount, 1);
}

for (const [mnemonic, keyId] of [['paciza', ARM64E_PAUTH_KEYS.ia], ['autiza', ARM64E_PAUTH_KEYS.ia]]) {
  const bundle = liftArm64eEffects(instruction(mnemonic, 'x4'));
  assert.equal(bundle.completeness, 'exact-with-intrinsic', `${mnemonic}: explicit-destination sibling unchanged`);
  assert.equal(bundle.metadata.destinationRegister, 'x4', `${mnemonic}: explicit destination preserved`);
  assert.equal(bundle.metadata.keyIdentity, keyId);
}
for (const [mnemonic, modifier] of [['paciasp', 'sp'], ['autiasp', 'sp']]) {
  const bundle = liftArm64eEffects(instruction(mnemonic));
  assert.equal(bundle.completeness, 'exact-with-intrinsic', `${mnemonic}: SP-modifier sibling unchanged`);
  assert.deepEqual(bundle.metadata.modifier, { kind: 'register', registerId: modifier }, `${mnemonic}: SP modifier preserved`);
}

const mnemonics = arm64ePointerAuthenticationMnemonics();
for (const mnemonic of ['paciaz', 'pacibz', 'autiaz', 'autibz']) {
  assert.ok(mnemonics.includes(mnemonic), `${mnemonic}: production mnemonic registry`);
  assert.equal(arm64ePointerAuthenticationOperandArities()[mnemonic], 0, `${mnemonic}: zero-operand arity`);
}

console.log('arm64e PAuth zero-modifier implicit-X30 aliases: PASS');

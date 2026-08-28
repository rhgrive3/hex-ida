import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { arm64ePointerAuthenticationMnemonics } from '../../js/targets/architecture/arm64e/effects.js';
import { arm64ePointerAuthenticationOperandArities } from '../../js/targets/architecture/arm64e/encoding.js';
import { ARM64E_PAC_ENCODING_FAMILIES } from '../../tools/validation/machine-effects/arm64e-pac-denominator.mjs';

const arities = arm64ePointerAuthenticationOperandArities();
assert.deepEqual(Object.keys(arities).sort(), [...arm64ePointerAuthenticationMnemonics()].sort(), 'operand-arity registry must cover the production PAuth registry exactly');
for (const family of ARM64E_PAC_ENCODING_FAMILIES) {
  assert.equal(arities[family.mnemonic], family.fields.length, `${family.mnemonic}: production operand arity must match the finite encoding denominator`);
}

let sequence = 0;
function instruction(mnemonic, operands) {
  sequence += 1;
  const instructionId = `arm64e-pauth-arity-${sequence}`;
  return {
    instructionId,
    mnemonic,
    operands,
    ops:parseOperands(operands),
    mode:'arm64e',
    address:0x10000n + BigInt(sequence * 4),
    origin:{ instructionIds:[instructionId] },
  };
}

function operandNames(mnemonic, count) {
  if (count === 0) return [];
  if (mnemonic === 'pacga') return ['x0','x1','x2'];
  if (/^(?:bra|blra)/.test(mnemonic)) return ['x16','x17'].slice(0, count);
  return ['x0','x1','x2','x3'].slice(0, count);
}

function lift(mnemonic, names) {
  return ARM64E_ARCHITECTURE.liftExact(instruction(mnemonic, names.join(', ')));
}

function assertFailClosed(mnemonic, names, expected) {
  const bundle = lift(mnemonic, names);
  assert.ok(bundle, `${mnemonic}: invalid shape must produce an explicit fail-closed bundle`);
  assert.equal(bundle.completeness, 'partial', `${mnemonic}: invalid shape is partial`);
  assert.equal(bundle.metadata?.failClosed, true, `${mnemonic}: invalid shape is marked failClosed`);
  assert.equal(bundle.operations.length, 0, `${mnemonic}: invalid shape produces no semantic operations`);
  assert.equal(bundle.unknownEffects?.reason, `arm64e-${mnemonic}-operand-shape-invalid`);
  assert.equal(bundle.unknownEffects?.detail?.expectedOperandCount, expected);
  assert.equal(bundle.unknownEffects?.detail?.actualOperandCount, names.length);
}

function assertClassFailClosed(mnemonic, names, operandIndex, expectedClass) {
  const bundle = lift(mnemonic, names);
  assert.ok(bundle, `${mnemonic}: invalid register class must produce an explicit fail-closed bundle`);
  assert.equal(bundle.completeness, 'partial', `${mnemonic}: invalid register class is partial`);
  assert.equal(bundle.metadata?.failClosed, true, `${mnemonic}: invalid register class is marked failClosed`);
  assert.equal(bundle.metadata?.encodingValidation, 'operand-register-class');
  assert.equal(bundle.operations.length, 0, `${mnemonic}: invalid register class produces no semantic operations`);
  assert.equal(bundle.unknownEffects?.reason, `arm64e-${mnemonic}-operand-register-class-invalid`);
  assert.equal(bundle.unknownEffects?.detail?.operandIndex, operandIndex);
  assert.equal(bundle.unknownEffects?.detail?.expectedRegisterClass, expectedClass);
}

for (const [mnemonic, expected] of Object.entries(arities)) {
  const valid = operandNames(mnemonic, expected);
  assert.equal(valid.length, expected, `${mnemonic}: test fixture arity`);
  const bundle = lift(mnemonic, valid);
  assert.ok(bundle, `${mnemonic}: valid encoding shape must lift`);
  assert.notEqual(bundle.metadata?.failClosed, true, `${mnemonic}: valid encoding shape remains accepted`);
  assert.ok(bundle.operations.length > 0, `${mnemonic}: valid encoding shape keeps existing semantics`);

  assertFailClosed(mnemonic, [...valid, 'x3'], expected);
  if (expected > 0) assertFailClosed(mnemonic, valid.slice(0, -1), expected);
}

for (const mnemonic of ['paciasp','autiasp','xpaclri','retaa','retab']) {
  assertFailClosed(mnemonic, ['x0'], 0);
}

for (const [mnemonic, operands] of [
  ['pacia', ['x0','x1','x2']],
  ['braaz', ['x16','x17']],
  ['blraaz', ['x16','x17']],
]) {
  const bundle = lift(mnemonic, operands);
  assert.equal(bundle.operations.length, 0, `${mnemonic}: minimal extra-operand counterexample stays effect-free`);
}

// Register 31 has instruction-position-specific semantics in A64 PAuth encodings.
// Ordinary X fields may denote XZR; modifier fields spelled <Xn|SP> or <Xm|SP>
// use encoding 31 as SP instead and therefore do not accept XZR.
for (const [mnemonic, operands, operandIndex, expectedClass] of [
  ['pacia', ['sp','x1'], 0, 'x-or-zr'],
  ['autia', ['sp','x1'], 0, 'x-or-zr'],
  ['paciza', ['sp'], 0, 'x-or-zr'],
  ['xpaci', ['sp'], 0, 'x-or-zr'],
  ['braaz', ['sp'], 0, 'x-or-zr'],
  ['braa', ['sp','x1'], 0, 'x-or-zr'],
  ['blraaz', ['sp'], 0, 'x-or-zr'],
  ['blraa', ['sp','x1'], 0, 'x-or-zr'],
  ['pacga', ['x0','sp','x2'], 1, 'x-or-zr'],
  ['pacia', ['x0','xzr'], 1, 'x-or-sp'],
  ['braa', ['x16','xzr'], 1, 'x-or-sp'],
  ['pacga', ['x0','x1','xzr'], 2, 'x-or-sp'],
]) assertClassFailClosed(mnemonic, operands, operandIndex, expectedClass);

for (const [mnemonic, operands] of [
  ['pacia', ['x0','sp']],
  ['autia', ['x0','sp']],
  ['braa', ['x16','sp']],
  ['blraa', ['x16','sp']],
  ['pacga', ['x0','x1','sp']],
  ['pacia', ['xzr','sp']],
  ['braaz', ['xzr']],
  ['pacga', ['xzr','xzr','sp']],
]) {
  const bundle = lift(mnemonic, operands);
  assert.ok(bundle, `${mnemonic}: architecturally valid register class must lift`);
  assert.notEqual(bundle.metadata?.failClosed, true, `${mnemonic}: valid SP/XZR position remains accepted`);
  assert.ok(bundle.operations.length > 0, `${mnemonic}: valid register-class form keeps semantics`);
}

for (const [mnemonic, operands, operandIndex, expectedClass] of [
  ['pacia', ['w0','x1'], 0, 'x-or-zr'],
  ['pacia', ['x0','w1'], 1, 'x-or-sp'],
  ['braaz', ['w16'], 0, 'x-or-zr'],
  ['braa', ['x16','w17'], 1, 'x-or-sp'],
  ['pacga', ['x0','w1','x2'], 1, 'x-or-zr'],
  ['pacga', ['x0','x1','w2'], 2, 'x-or-sp'],
]) assertClassFailClosed(mnemonic, operands, operandIndex, expectedClass);

console.log('arm64e-pauth-operand-arity: PASS');

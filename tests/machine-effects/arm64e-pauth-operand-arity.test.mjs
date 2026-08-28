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

console.log('arm64e-pauth-operand-arity: PASS');

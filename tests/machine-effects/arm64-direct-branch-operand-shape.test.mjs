import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64ControlEffects } from '../../js/targets/architecture/arm64/effects/control.js';

function lift(mnemonic, operands, address = 0x800n, resolved = {}) {
  return liftArm64ControlEffects({
    instructionId:`direct-shape:${mnemonic}:${operands || 'none'}`,
    mnemonic,
    operands,
    ops:parseOperands(operands),
    address,
    mode:'a64',
    ...resolved,
  });
}

function assertAccepted(mnemonic, operands, resolved = {}) {
  const effects = lift(mnemonic, operands, 0x800n, resolved);
  assert.ok(effects, `${mnemonic} ${operands}: owned`);
  assert.notEqual(effects.completeness, 'partial', `${mnemonic} ${operands}: valid shape`);
  assert.notEqual(effects.controlEffect?.kind, 'unknown', `${mnemonic} ${operands}: concrete control`);
}

function assertRejected(mnemonic, operands) {
  const effects = lift(mnemonic, operands);
  const reason = `arm64-${mnemonic}-operand-shape-invalid`;
  assert.ok(effects, `${mnemonic} ${operands}: owned`);
  assert.equal(effects.completeness, 'partial', `${mnemonic} ${operands}: fail closed`);
  assert.equal(effects.unknownEffects?.reason, reason, `${mnemonic} ${operands}: reason`);
  assert.equal(effects.controlEffect?.kind, 'unknown', `${mnemonic} ${operands}: no concrete edge`);
  assert.equal(effects.operations.some((operation) => operation.kind === 'register-read'), false, `${mnemonic} ${operands}: no register read`);
}

for (const [mnemonic, operands] of [
  ['b', '#0x1000'],
  ['bl', '#0x1000'],
  ['b.eq', '#0x1000'],
  ['cbz', 'x0, #0x1000'],
  ['cbnz', 'w0, #0x1000'],
  ['tbz', 'x0, #0, #0x1000'],
  ['tbnz', 'x0, #63, #0x1000'],
  ['tbnz', 'w0, #31, #0x1000'],
]) assertAccepted(mnemonic, operands);

// Compiler-truth and other decoded-model inputs may retain a symbolic label in
// the presentation operand while carrying the resolved target separately. Keep
// that decoder-owned target evidence valid without reopening extra-operand arity.
assertAccepted('b.eq', '.LBB0_1', { branchTarget:0x1000n });
assertAccepted('cbz', 'w0, .LBB0_1', { branchTarget:0x1000n });
assertAccepted('tbnz', 'x0, #0, .LBB0_1', { branchTarget:0x1000n });
assertAccepted('bl', 'callee', { callTarget:0x1000n });

for (const [mnemonic, operands] of [
  ['b', '#0x1000, x0'],
  ['bl', '#0x1000, x0'],
  ['b.eq', '#0x1000, x0'],
  ['cbz', 'x0, #0x1000, x1'],
  ['cbnz', 'w0, #0x1000, w1'],
  ['tbz', 'x0, #0, #0x1000, x1'],
  ['tbnz', 'x0, #0, #0x1000, x1'],
  ['b', 'x0'],
  ['cbz', '#0, #0x1000'],
  ['cbz', '#0x1000, x0'],
  ['tbz', 'x0, x1, #0x1000'],
  ['tbz', 'x0, #0'],
]) assertRejected(mnemonic, operands);

console.log('ARM64 direct branch operand-shape regression: PASS');

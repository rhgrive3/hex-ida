import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';

function lift(mnemonic, operands) {
  return liftArm64SystemEffects({
    instructionId:`maintenance-shape:${mnemonic}:${operands || 'none'}`,
    mnemonic,
    operands,
    ops:parseOperands(operands),
    mode:'a64',
  });
}

function assertAccepted(mnemonic, operands) {
  const effects = lift(mnemonic, operands);
  assert.ok(effects, `${mnemonic} ${operands}: owned`);
  assert.notEqual(effects.completeness, 'partial', `${mnemonic} ${operands}: valid shape`);
  assert.equal(effects.operations.some((operation) => operation.kind === 'unknown'), false, `${mnemonic} ${operands}: no unknown`);
}

function assertRejected(mnemonic, operands, reason) {
  const effects = lift(mnemonic, operands);
  assert.ok(effects, `${mnemonic} ${operands}: owned`);
  assert.equal(effects.completeness, 'partial', `${mnemonic} ${operands}: fail closed`);
  assert.equal(effects.unknownEffects?.reason, reason, `${mnemonic} ${operands}: reason`);
  assert.equal(effects.operations.some((operation) => operation.kind === 'intrinsic'), false, `${mnemonic} ${operands}: no intrinsic`);
  assert.equal(effects.operations.some((operation) => operation.kind === 'register-read'), false, `${mnemonic} ${operands}: no register read`);
}

for (const [mnemonic, operands] of [
  ['dc', 'cvau, x0'],
  ['ic', 'ivau, x0'],
  ['ic', 'iallu'],
  ['ic', 'ialluis'],
  ['tlbi', 'vaae1is, x0'],
  ['tlbi', 'vmalle1is'],
  ['tlbi', 'alle1'],
  ['sys', '#0, c0, c0, #0'],
  ['sys', '#7, c15, c15, #7, xzr'],
  ['sys', '#0, c7, c5, #0, x0'],
]) assertAccepted(mnemonic, operands);

for (const [mnemonic, operands] of [
  ['dc', 'cvau'],
  ['ic', 'ivau'],
  ['tlbi', 'vaae1is'],
  ['dc', 'cvau, x0, x1'],
  ['ic', 'ivau, x0, x1'],
  ['tlbi', 'vaae1is, x0, x1'],
  ['ic', 'iallu, x0'],
  ['tlbi', 'vmalle1is, x0'],
  ['dc', 'bogus, x0'],
  ['ic', 'bogus'],
  ['tlbi', 'bogus, x0'],
  ['dc', 'cvau, w0'],
  ['ic', 'ivau, #1'],
  ['tlbi', 'vaae1is, w0'],
  ['dc', 'cvau, x0, lsl #1'],
  ['dc', '#1, x0'],
  ['ic', 'x0'],
  ['tlbi', ''],
]) assertRejected(mnemonic, operands, `${mnemonic}-operand-shape-invalid`);

for (const operands of [
  '#0, c7, c5, #0, x0, x1',
  '#8, c7, c5, #0, x0',
  '#0, c16, c5, #0, x0',
  '#0, c7, c16, #0, x0',
  '#0, c7, c5, #8, x0',
  '#0, c7, c5, #0, w0',
  '#0, c7, c5, #0, x0, lsl #1',
  '#0, c7, c5',
]) assertRejected('sys', operands, 'sys-operand-shape-invalid');

console.log('ARM64 system maintenance operand-shape regression: PASS');

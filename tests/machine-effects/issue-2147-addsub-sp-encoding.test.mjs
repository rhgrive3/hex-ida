import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const lift = (mnemonic, operands) => liftArm64MachineEffects({
  instructionId:`${mnemonic}:${operands}`,
  mnemonic,
  mode:'a64',
  ops:parseOperands(operands),
});

for (const [mnemonic, operands] of [
  ['add','sp, sp, #0'],
  ['add','sp, sp, #4095'],
  ['add','sp, sp, #1, lsl #12'],
  ['sub','sp, sp, #1'],
  ['adds','x0, sp, #1'],
  ['add','sp, x0, x1'],
  ['add','x0, sp, w1, uxtw #4'],
  ['add','x0, x1, x2, lsr #63'],
  ['adds','xzr, sp, #1'],
]) {
  assert.notEqual(lift(mnemonic, operands).completeness, 'partial', `${mnemonic} valid SP/ZR encoding regressed: ${operands}`);
}

for (const [mnemonic, operands] of [
  ['adc','sp, x0, x1'],
  ['adc','x0, sp, x1'],
  ['adds','sp, sp, #1'],
  ['neg','sp, x0'],
  ['add','sp, x0, x1, lsr #1'],
  ['add','x0, sp, x1, lsr #1'],
  ['add','x0, sp, w1, uxtw #5'],
  ['add','sp, sp, #-1'],
  ['add','xzr, x0, #1'],
  ['add','x0, xzr, #1'],
  ['add','sp, x0, x1, lsl #5'],
]) {
  const result = lift(mnemonic, operands);
  assert.equal(result.completeness, 'partial', `${mnemonic} illegal SP/ZR encoding must fail closed: ${operands}`);
  assert.equal(result.operations.filter((operation) => operation.kind !== 'unknown').length, 0,
    `${mnemonic} illegal SP/ZR encoding emitted exact operations: ${operands}`);
}

console.log('issue #2147 regression: PASS');

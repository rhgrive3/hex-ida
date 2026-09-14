import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const lift = (mnemonic, operands) => liftArm64MachineEffects({
  instructionId:`${mnemonic}:${operands}`,
  mnemonic,
  mode:'a64',
  ops:parseOperands(operands),
});

for (const [mnemonic, valid, invalid] of [
  ['cmp','x0, #1','#1, #2'],
  ['cmn','x0, x1','#1, #2'],
  ['ccmp','x0, x1, #0, eq','#1, x1, #0, eq'],
  ['ccmn','x0, #3, #0, eq','#1, #3, #0, eq'],
]) {
  assert.notEqual(lift(mnemonic, valid).completeness, 'partial', `${mnemonic} valid shape regressed`);
  const result = lift(mnemonic, invalid);
  assert.equal(result.completeness, 'partial', `${mnemonic} immediate lhs must fail closed`);
  assert.equal(result.operations.filter((op) => op.kind !== 'unknown').length, 0, `${mnemonic} invalid lhs emitted exact operations`);
}

for (const [mnemonic, operands] of [
  ['cmp','sp, #0'],
  ['cmp','sp, #4095'],
  ['cmp','sp, #1, lsl #12'],
  ['cmn','sp, #1'],
]) {
  assert.notEqual(lift(mnemonic, operands).completeness, 'partial', `${mnemonic} valid SP/immediate form regressed: ${operands}`);
}

for (const [mnemonic, operands] of [
  ['cmp','sp, #-1'],
  ['cmp','sp, #4096'],
  ['cmp','sp, #1, lsl #1'],
  ['cmn','sp, #-1'],
  ['cmn','sp, #4096'],
]) {
  const result = lift(mnemonic, operands);
  assert.equal(result.completeness, 'partial', `${mnemonic} invalid SP/immediate form must fail closed: ${operands}`);
  assert.equal(result.operations.filter((op) => op.kind !== 'unknown').length, 0, `${mnemonic} invalid SP/immediate emitted exact operations: ${operands}`);
}

for (const [mnemonic, operands] of [
  ['cmp','x0, x1'],
  ['cmp','w0, w1'],
  ['cmp','x0, x1, lsl #63'],
  ['cmp','w0, w1, asr #31'],
  ['cmp','sp, x1'],
  ['cmp','sp, x1, lsl #4'],
  ['cmp','sp, w1, uxtw #4'],
  ['cmn','x0, w1, sxtw #4'],
  ['ccmp','x0, x1, #0, eq'],
  ['ccmn','w0, w1, #15, ne'],
]) {
  assert.notEqual(lift(mnemonic, operands).completeness, 'partial', `${mnemonic} valid register form regressed: ${operands}`);
}

for (const [mnemonic, operands] of [
  ['cmp','x0, w1'],
  ['cmp','x0, x1, ror #1'],
  ['cmn','x0, x1, ror #1'],
  ['cmp','x0, x1, lsl #64'],
  ['cmp','sp, x1, lsl #5'],
  ['cmp','sp, x1, lsr #1'],
  ['cmp','x0, w1, uxtw #5'],
  ['ccmp','x0, w1, #0, eq'],
  ['ccmn','w0, x1, #0, eq'],
  ['ccmp','x0, x1, lsl #1, #0, eq'],
]) {
  const result = lift(mnemonic, operands);
  assert.equal(result.completeness, 'partial', `${mnemonic} invalid register encoding must fail closed: ${operands}`);
  assert.equal(result.operations.filter((op) => op.kind !== 'unknown').length, 0, `${mnemonic} invalid register encoding emitted exact operations: ${operands}`);
}

console.log('issues #2115/#2144/#2145 regression: PASS');

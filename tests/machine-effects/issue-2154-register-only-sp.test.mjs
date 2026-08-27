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
  ['lsl','x0, x1, #1'],
  ['clz','x0, x1'],
  ['csel','x0, x1, x2, eq'],
  ['extr','x0, x1, x2, #1'],
  ['ubfx','x0, x1, #0, #1'],
  ['bfc','x0, #0, #1'],
]) {
  assert.notEqual(lift(mnemonic, operands).completeness, 'partial', `${mnemonic} valid register-only form regressed: ${operands}`);
}

for (const [mnemonic, operands] of [
  ['lsl','sp, x1, #1'],
  ['clz','sp, x1'],
  ['csel','sp, x1, x2, eq'],
  ['extr','sp, x1, x2, #1'],
  ['ubfx','sp, x1, #0, #1'],
  ['bfc','sp, #0, #1'],
  ['lsl','x0, sp, #1'],
  ['csel','x0, sp, x2, eq'],
  ['ubfx','x0, sp, #0, #1'],
]) {
  const result = lift(mnemonic, operands);
  assert.equal(result.completeness, 'partial', `${mnemonic} illegal SP form must fail closed: ${operands}`);
  assert.equal(result.operations.filter((operation) => operation.kind !== 'unknown').length, 0,
    `${mnemonic} illegal SP form emitted exact operations: ${operands}`);
}

console.log('issue #2154 regression: PASS');

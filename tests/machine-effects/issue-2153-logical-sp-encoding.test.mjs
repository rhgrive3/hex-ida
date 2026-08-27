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
  ['and','x0, x1, x2'],
  ['ands','xzr, x1, x2'],
  ['orr','x0, x1, xzr'],
  ['mvn','x0, x1'],
  ['tst','x0, x1'],
  // Logical-immediate AND/ORR/EOR encode Rd=31 as SP. This is distinct from
  // their shifted-register forms, where register 31 is ZR and SP is illegal.
  ['and','sp, x0, #1'],
  ['orr','wsp, w1, #255'],
  ['eor','sp, xzr, #255'],
]) {
  assert.notEqual(lift(mnemonic, operands).completeness, 'partial', `${mnemonic} valid logical form regressed: ${operands}`);
}

for (const [mnemonic, operands] of [
  ['and','sp, x0, x1'],
  ['orr','sp, x0, x1'],
  ['ands','sp, x0, x1'],
  ['mvn','sp, x1'],
  ['tst','sp, x1'],
  ['tst','x0, sp'],
  ['and','sp, x0, #0'],
  ['orr','sp, x0, #-1'],
  ['eor','sp, sp, #1'],
]) {
  const result = lift(mnemonic, operands);
  assert.equal(result.completeness, 'partial', `${mnemonic} illegal SP logical form must fail closed: ${operands}`);
  assert.equal(result.operations.filter((operation) => operation.kind !== 'unknown').length, 0,
    `${mnemonic} illegal SP logical form emitted exact operations: ${operands}`);
}

console.log('issue #2153 regression: PASS');
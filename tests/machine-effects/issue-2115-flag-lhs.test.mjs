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

console.log('issue #2115 regression: PASS');

import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const lift = (operands) => liftArm64MachineEffects({
  instructionId:`mov:${operands}`,
  mnemonic:'mov',
  mode:'a64',
  ops:parseOperands(operands),
});

for (const operands of [
  'x0, x1',
  'w0, w1',
  'x0, xzr',
  'xzr, x0',
  'sp, x0',
  'x0, sp',
  'sp, sp',
  'x0, #0',
]) {
  assert.notEqual(lift(operands).completeness, 'partial', `valid MOV alias regressed: ${operands}`);
}

for (const operands of [
  'x0, w1',
  'sp, #1',
  'sp, xzr',
  'xzr, sp',
  'x0, x1, x2',
]) {
  const result = lift(operands);
  assert.equal(result.completeness, 'partial', `illegal MOV encoding must fail closed: ${operands}`);
  assert.equal(result.operations.filter((operation) => operation.kind !== 'unknown').length, 0,
    `illegal MOV emitted exact operations: ${operands}`);
}

console.log('issue #2156 regression: PASS');

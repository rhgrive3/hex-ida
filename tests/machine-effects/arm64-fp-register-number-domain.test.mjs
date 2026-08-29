import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function lift(mnemonic, operands, mutate = null) {
  const ops = parseOperands(operands);
  mutate?.(ops);
  const instructionId = `arm64-fp-register-number-${++sequence}`;
  return liftArm64MachineEffects({ instructionId, mnemonic, operands, ops, mode:'a64', origin:{ instructionIds:[instructionId] } });
}

for (const [mnemonic, operands] of [
  ['fadd','s0, s1, s31'],
  ['fmov','d31, d0'],
  ['scvtf','d31, x31'],
]) {
  const effect = lift(mnemonic, operands);
  assert.ok(effect);
  assert.notEqual(effect.completeness, 'partial', `${mnemonic} ${operands}: legal register numbers must remain exact`);
}

for (const [mnemonic, operands, index, num] of [
  ['fadd','s0, s1, s2',0,32],
  ['fadd','s0, s1, s2',1,99],
  ['fmov','x0, d1',0,99],
  ['fmov','d0, x1',1,32],
  ['scvtf','d0, x1',1,99],
]) {
  const effect = lift(mnemonic, operands, (ops) => { ops[index].num = num; });
  assert.ok(effect);
  assert.equal(effect.completeness, 'partial', `${mnemonic} ${operands}: register number ${num} must fail closed`);
  assert.equal(
    effect.operations.filter((operation) => ['register-read','register-write','intrinsic'].includes(operation.kind)).length,
    0,
    `${mnemonic} ${operands}: invalid register number must not publish definite register/intrinsic effects`,
  );
}

console.log('arm64 scalar FP register-number domain validation: PASS');

import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;

function lift(mnemonic, operands, mutate = null) {
  const ops = parseOperands(operands);
  mutate?.(ops);
  const instructionId = `arm64-simd-gp-modifier-${++sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    operands,
    ops,
    mode:'a64',
    origin:{ instructionIds:[instructionId] },
  });
}

for (const [mnemonic, operands] of [
  ['dup', 'v0.4s, w1'],
  ['dup', 'v0.2d, x1'],
  ['ins', 'v0.s[0], w1'],
  ['umov', 'w0, v1.s[0]'],
  ['umov', 'x0, v1.d[0]'],
  ['smov', 'w0, v1.h[0]'],
  ['smov', 'x0, v1.s[0]'],
]) {
  const effect = lift(mnemonic, operands);
  assert.ok(effect, `${mnemonic} ${operands}: expected MachineEffects`);
  assert.notEqual(effect.completeness, 'partial', `${mnemonic} ${operands}: legal form must remain exact`);
}

for (const [mnemonic, operands, index, field] of [
  ['dup', 'v0.4s, w1', 1, 'shift'],
  ['dup', 'v0.2d, x1', 1, 'extend'],
  ['ins', 'v0.s[0], w1', 1, 'extend'],
  ['umov', 'w0, v1.s[0]', 0, 'shift'],
  ['umov', 'x0, v1.d[0]', 0, 'extend'],
  ['smov', 'w0, v1.h[0]', 0, 'extend'],
  ['smov', 'x0, v1.s[0]', 0, 'shift'],
]) {
  const effect = lift(mnemonic, operands, (ops) => {
    ops[index][field] = field === 'shift'
      ? { op:'lsl', amount:1 }
      : { op:'uxtw', amount:0 };
  });
  assert.ok(effect, `${mnemonic} ${operands}: expected fail-closed MachineEffects`);
  assert.equal(effect.completeness, 'partial', `${mnemonic} ${operands}: modified GP/ZR operand must fail closed`);
  assert.equal(
    effect.operations.filter((operation) => ['register-read','register-write','intrinsic'].includes(operation.kind)).length,
    0,
    `${mnemonic} ${operands}: invalid encoding must not publish definite register/intrinsic effects`,
  );
}

console.log('arm64 SIMD GP/ZR register modifier validation: PASS');

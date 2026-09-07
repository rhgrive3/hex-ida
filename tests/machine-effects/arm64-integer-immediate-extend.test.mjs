import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function lift(mnemonic, operands, extendIndex = null) {
  const ops = parseOperands(operands);
  if (extendIndex != null) ops[extendIndex].extend = { op:'uxtw', amount:0 };
  const instructionId = `arm64-immediate-extend-${++sequence}`;
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
  ['add', 'x0, x1, #1'],
  ['add', 'x0, x1, #1, lsl #12'],
  ['sub', 'w0, w1, #4095'],
  ['and', 'x0, x1, #1'],
  ['orr', 'w0, w1, #1'],
  ['tst', 'x0, #1'],
  ['cmp', 'x0, #4095, lsl #12'],
  ['cmn', 'sp, #1'],
  ['mov', 'x0, #1'],
]) {
  const effect = lift(mnemonic, operands);
  assert.ok(effect, `${mnemonic} ${operands}: effect required`);
  assert.ok(['exact','exact-with-intrinsic'].includes(effect.completeness), `${mnemonic} ${operands}: legal immediate form`);
}

for (const [mnemonic, operands, index] of [
  ['add', 'x0, x1, #1', 2],
  ['adds', 'x0, x1, #1', 2],
  ['sub', 'w0, w1, #1', 2],
  ['subs', 'w0, w1, #1', 2],
  ['and', 'x0, x1, #1', 2],
  ['ands', 'x0, x1, #1', 2],
  ['orr', 'x0, x1, #1', 2],
  ['eor', 'x0, x1, #1', 2],
  ['tst', 'x0, #1', 1],
  ['cmp', 'x0, #1', 1],
  ['cmn', 'sp, #1', 1],
  ['mov', 'x0, #1', 1],
]) {
  const effect = lift(mnemonic, operands, index);
  assert.ok(effect, `${mnemonic} ${operands}: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${mnemonic}: structured immediate extend must fail closed`);
  assert.equal(effect.operations.length, 0, `${mnemonic}: invalid immediate must not emit definite register/NZCV operations`);
}

console.log('arm64 integer immediate extend: PASS');

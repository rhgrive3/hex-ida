import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function lift(mnemonic, operands, ops = parseOperands(operands)) {
  const instructionId = `arm64-move-wide-shape-${++sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    operands,
    ops,
    mode: 'a64',
    origin: { instructionIds: [instructionId] },
  });
}

for (const [mnemonic, operands] of [
  ['movz', 'w0, #0'],
  ['movz', 'w0, #65535, lsl #16'],
  ['movz', 'x0, #65535, lsl #48'],
  ['movn', 'x0, #1'],
  ['movk', 'x0, #1, lsl #32'],
  ['movz', 'xzr, #1'],
  ['movz', 'wzr, #1'],
]) {
  const effect = lift(mnemonic, operands);
  assert.ok(effect, `${mnemonic} ${operands}: effect required`);
  assert.ok(['exact', 'exact-with-intrinsic'].includes(effect.completeness), `${mnemonic} ${operands}: legal move-wide form`);
}

for (const [mnemonic, operands] of [
  ['movz', 'x0, #1, lsr #16'],
  ['movn', 'x0, #1, asr #16'],
  ['movk', 'x0, #1, ror #16'],
  ['movz', 'w0, #1, uxtw'],
  ['movz', 'w0, #1, lsl #32'],
  ['movz', 'x0, #1, lsl #8'],
  ['movz', 'sp, #1'],
  ['movn', 'wsp, #1'],
  ['movk', 'sp, #1'],
  ['movz', 'x0, x1'],
  ['movz', 'x0, #1, x2'],
]) {
  const parsed = parseOperands(operands);
  const effect = lift(mnemonic, operands, parsed);
  assert.ok(effect, `${mnemonic} ${operands}: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${mnemonic} ${operands}: invalid move-wide shape must be partial`);
  assert.equal(
    effect.operations.some((operation) => ['register-read', 'register-write', 'value', 'intrinsic'].includes(operation.kind)),
    false,
    `${mnemonic} ${operands}: invalid form must not emit definite register semantics`,
  );
}

{
  const ops = parseOperands('x0, #1');
  ops[1].extend = { op: 'uxtw', amount: 0 };
  const effect = lift('movz', 'x0, #1', ops);
  assert.equal(effect.completeness, 'partial', 'structured immediate extend must fail closed');
  assert.equal(effect.operations.length, 0, 'structured immediate extend must not emit definite operations');
}

console.log('arm64 move-wide operand shape: PASS');

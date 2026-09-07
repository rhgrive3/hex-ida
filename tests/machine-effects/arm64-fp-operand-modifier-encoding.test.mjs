import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64FpEffects } from '../../js/targets/architecture/arm64/effects/fp.js';

let sequence = 0;
function lift(mnemonic, operands) {
  sequence += 1;
  const instructionId = `arm64-fp-modifier-${sequence}`;
  return liftArm64FpEffects({
    instructionId,
    mnemonic,
    operands,
    ops: parseOperands(operands),
    mode: 'a64',
    origin: { instructionIds: [instructionId] },
  });
}

for (const [mnemonic, operands] of [
  ['fadd', 'd0, d1, d2'],
  ['fmadd', 'd0, d1, d2, d3'],
  ['fsqrt', 'd0, d1'],
  ['scvtf', 'd0, x1'],
  ['fcvtzs', 'x0, d1, #1'],
  ['fcsel', 'd0, d1, d2, eq'],
  ['fcmp', 'd0, d1'],
]) {
  const effect = lift(mnemonic, operands);
  assert.ok(effect, `${mnemonic} ${operands}: effect required`);
  assert.ok(['exact','exact-with-intrinsic'].includes(effect.completeness), `${mnemonic} ${operands}: valid scalar FP shape`);
}

for (const [mnemonic, operands] of [
  ['fadd', 'd0, d1, d2, lsl #1'],
  ['fmadd', 'd0, d1, d2, d3, ror #1'],
  ['fsqrt', 'd0, d1, lsl #1'],
  ['scvtf', 'd0, x1, lsl #1'],
  ['fcvtzs', 'x0, d1, #1, lsl #1'],
  ['fcsel', 'd0, d1, d2, eq, lsl #1'],
  ['fcmp', 'd0, d1, lsl #1'],
]) {
  const effect = lift(mnemonic, operands);
  assert.ok(effect, `${mnemonic} ${operands}: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${mnemonic} modified scalar FP operand must fail closed`);
  assert.equal(effect.operations.some((operation) => operation.kind === 'intrinsic'), false,
    `${mnemonic}: invalid encoding must not emit a definite FP intrinsic`);
  assert.equal(effect.operations.some((operation) => operation.kind === 'register-write'), false,
    `${mnemonic}: invalid encoding must not emit a definite register write`);
}

console.log('arm64 scalar FP operand modifier encoding: PASS');

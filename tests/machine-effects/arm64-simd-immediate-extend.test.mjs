import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64SimdEffects } from '../../js/targets/architecture/arm64/effects/simd.js';

let sequence = 0;
function liftParsed(mnemonic, operands, mutate = null) {
  const ops = parseOperands(operands);
  if (mutate) mutate(ops);
  const instructionId = `arm64-simd-immediate-extend-${++sequence}`;
  return liftArm64SimdEffects({
    instructionId,
    mnemonic,
    operands,
    ops,
    mode: 'a64',
    origin: { instructionIds: [instructionId] },
  });
}

function addExtend(ops, index) {
  ops[index] = { ...ops[index], extend: { op: 'uxtw', amount: 0 } };
}

for (const [mnemonic, operands] of [
  ['cmeq', 'v0.4s, v1.4s, #0'],
  ['shl', 'v0.4s, v1.4s, #3'],
  ['ext', 'v0.16b, v1.16b, v2.16b, #1'],
  ['fcvtzs', 'v0.4s, v1.4s, #16'],
  ['movi', 'v0.4s, #3, lsl #8'],
]) {
  const effect = liftParsed(mnemonic, operands);
  assert.ok(effect && ['exact', 'exact-with-intrinsic'].includes(effect.completeness), `${mnemonic} ${operands}: legal immediate form`);
}

for (const [mnemonic, operands, index] of [
  ['cmeq', 'v0.4s, v1.4s, #0', 2],
  ['shl', 'v0.4s, v1.4s, #3', 2],
  ['ext', 'v0.16b, v1.16b, v2.16b, #1', 3],
  ['fcvtzs', 'v0.4s, v1.4s, #16', 2],
]) {
  const effect = liftParsed(mnemonic, operands, (ops) => addExtend(ops, index));
  assert.ok(effect, `${mnemonic} ${operands}: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${mnemonic}: impossible immediate extend must be partial`);
  assert.equal(
    effect.operations.some((operation) => ['register-read', 'register-write', 'intrinsic'].includes(operation.kind)),
    false,
    `${mnemonic}: invalid immediate extend must not emit definite SIMD effects`,
  );
}

for (const [mnemonic, amount] of [['cmeq', 0n], ['shl', 3n]]) {
  const instructionId = `arm64-simd-scalar-immediate-extend-${++sequence}`;
  const ops = [
    { k:'reg', cls:'fp', bits:64, num:0, text:'d0' },
    { k:'reg', cls:'fp', bits:64, num:1, text:'d1' },
    { k:'imm', value:amount, text:`#${amount}`, extend:{ op:'uxtw', amount:0 } },
  ];
  const effect = liftArm64SimdEffects({ instructionId, mnemonic, ops, mode:'a64', origin:{ instructionIds:[instructionId] } });
  assert.ok(effect, `${mnemonic} scalar: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${mnemonic} scalar: immediate extend must be partial`);
  assert.equal(
    effect.operations.some((operation) => ['register-read', 'register-write', 'intrinsic'].includes(operation.kind)),
    false,
    `${mnemonic} scalar: invalid record must not emit definite SIMD effects`,
  );
}

console.log('arm64 SIMD immediate extend validation: PASS');

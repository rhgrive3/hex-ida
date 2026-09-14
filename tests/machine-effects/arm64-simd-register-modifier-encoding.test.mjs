import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64SimdEffects } from '../../js/targets/architecture/arm64/effects/simd.js';

let sequence = 0;
function lift(mnemonic, operands) {
  const instructionId = `arm64-simd-register-modifier-${++sequence}`;
  return liftArm64SimdEffects({
    instructionId,
    mnemonic,
    operands,
    ops: parseOperands(operands),
    mode: 'a64',
    origin: { instructionIds: [instructionId] },
  });
}

for (const [mnemonic, operands] of [
  ['add', 'v0.4s, v1.4s, v2.4s'],
  ['and', 'v0.16b, v1.16b, v2.16b'],
  ['cmeq', 'v0.4s, v1.4s, v2.4s'],
  ['fadd', 'v0.4s, v1.4s, v2.4s'],
  ['shl', 'v0.4s, v1.4s, #3'],
  ['movi', 'v0.4s, #3, lsl #8'],
]) {
  const effect = lift(mnemonic, operands);
  assert.ok(effect && ['exact', 'exact-with-intrinsic'].includes(effect.completeness), `${mnemonic} ${operands}: legal SIMD form`);
}

for (const [mnemonic, operands] of [
  ['add', 'v0.4s, v1.4s, v2.4s, lsl #1'],
  ['and', 'v0.16b, v1.16b, v2.16b, lsl #1'],
  ['cmeq', 'v0.4s, v1.4s, v2.4s, lsl #1'],
  ['fadd', 'v0.4s, v1.4s, v2.4s, lsl #1'],
  ['fmul', 'v0.4s, v1.4s, v2.s[1], lsl #1'],
]) {
  const effect = lift(mnemonic, operands);
  assert.ok(effect, `${mnemonic} ${operands}: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${mnemonic} ${operands}: impossible register modifier must be partial`);
  assert.equal(
    effect.operations.some((operation) => ['register-read', 'register-write', 'intrinsic'].includes(operation.kind)),
    false,
    `${mnemonic} ${operands}: invalid form must not emit definite SIMD effects`,
  );
}

// Maintainer-owned assertion head after canonical generated artifacts are synchronized.
console.log('arm64 SIMD register modifier encoding: PASS');

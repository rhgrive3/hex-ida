import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';

let sequence = 0;
function lift(mnemonic, operands) {
  sequence += 1;
  const instructionId = `arm64-system-symbolic-modifier-${sequence}`;
  return liftArm64SystemEffects({ instructionId, mnemonic, operands, ops:parseOperands(operands), mode:'a64', origin:{instructionIds:[instructionId]} });
}

for (const [mnemonic, operands] of [
  ['bti','c'], ['bti','j'], ['bti','jc'],
  ['mrs','x0, nzcv'], ['msr','nzcv, x0'],
  ['dc','cvau, x0'], ['ic','ivau, x0'], ['tlbi','vaae1is, x0'],
  ['sys','#0, c7, c5, #0, x0'],
]) {
  const effect=lift(mnemonic,operands);
  assert.ok(effect && ['exact','exact-with-intrinsic'].includes(effect.completeness), `${mnemonic} ${operands}: legal form`);
}

for (const [mnemonic, operands] of [
  ['bti','c, lsl #1'],
  ['mrs','x0, nzcv, lsl #1'],
  ['msr','nzcv, lsl #1, x0'],
  ['dc','cvau, lsl #1, x0'],
  ['ic','ivau, lsl #1, x0'],
  ['tlbi','vaae1is, lsl #1, x0'],
  ['sys','#0, c7, lsl #1, c5, #0, x0'],
  ['sys','#0, c7, c5, lsl #1, #0, x0'],
]) {
  const effect=lift(mnemonic,operands);
  assert.ok(effect, `${mnemonic} ${operands}: fail-closed effect required`);
  assert.equal(effect.completeness,'partial', `${mnemonic} ${operands}: modifier contradiction must be partial`);
  assert.equal(effect.operations.some((op)=>op.kind==='intrinsic' || op.kind==='register-write'),false, `${mnemonic}: invalid symbolic modifier must not emit definite intrinsic/register write`);
}

console.log('arm64 system symbolic modifier encoding: PASS');

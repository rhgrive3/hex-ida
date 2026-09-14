import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MemoryEffects } from '../../js/targets/architecture/arm64/effects/memory.js';

let sequence=0;
function lift(mnemonic, operands) {
  sequence += 1;
  const instructionId=`arm64-memory-data-register-modifier-${sequence}`;
  return liftArm64MemoryEffects({instructionId,mnemonic,operands,ops:parseOperands(operands),mode:'a64',origin:{instructionIds:[instructionId]}});
}

for (const [mnemonic,operands] of [
  ['ldr','x0, [x1]'],
  ['str','w0, [x1, #4]'],
  ['ldp','x0, x1, [sp, #16]'],
  ['stp','x0, x1, [x2, #16]'],
  ['ldr','x0, [x1, x2, lsl #3]'],
]) {
  const effect=lift(mnemonic,operands);
  assert.ok(effect && ['exact','exact-with-intrinsic'].includes(effect.completeness), `${mnemonic} ${operands}: legal memory form`);
}

for (const [mnemonic,operands] of [
  ['ldr','x0, lsl #1, [x1]'],
  ['str','w0, uxtw #2, [x1]'],
  ['ldp','x0, x1, lsl #1, [x2]'],
  ['stp','x0, x1, sxtx #0, [x2]'],
]) {
  const effect=lift(mnemonic,operands);
  assert.ok(effect, `${mnemonic} ${operands}: fail-closed effect required`);
  assert.equal(effect.completeness,'partial', `${mnemonic}: data-register modifier contradiction must be partial`);
  assert.equal(effect.operations.length,0, `${mnemonic}: invalid data-register modifier must not emit definite memory/register/writeback effects`);
}

// Maintainer-owned assertion head after canonical generated artifacts are synchronized.
console.log('arm64 memory data-register modifier encoding: PASS');

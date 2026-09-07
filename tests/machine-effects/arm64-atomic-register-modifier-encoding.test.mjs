import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64AtomicEffects } from '../../js/targets/architecture/arm64/effects/atomic.js';

let sequence=0;
function lift(mnemonic, operands) {
  sequence += 1;
  const instructionId=`arm64-atomic-register-modifier-${sequence}`;
  return liftArm64AtomicEffects({instructionId,mnemonic,operands,ops:parseOperands(operands),mode:'a64',origin:{instructionIds:[instructionId]}});
}

for (const [mnemonic,operands] of [
  ['ldxr','x0, [x1]'],
  ['stxr','w0, x1, [x2]'],
  ['cas','x0, x1, [x2]'],
  ['swp','x0, x1, [x2]'],
  ['ldadd','x0, x1, [x2]'],
]) {
  const effect=lift(mnemonic,operands);
  assert.ok(effect && ['exact','exact-with-intrinsic'].includes(effect.completeness), `${mnemonic} ${operands}: legal atomic form`);
}

for (const [mnemonic,operands] of [
  ['ldxr','x0, lsl #1, [x1]'],
  ['stxr','w0, x1, lsl #1, [x2]'],
  ['cas','x0, x1, lsl #1, [x2]'],
  ['swp','x0, x1, lsl #1, [x2]'],
  ['ldadd','x0, x1, lsl #1, [x2]'],
]) {
  const effect=lift(mnemonic,operands);
  assert.ok(effect, `${mnemonic} ${operands}: fail-closed effect required`);
  assert.equal(effect.completeness,'partial', `${mnemonic}: modifier contradiction must be partial`);
  assert.equal(effect.operations.length,0, `${mnemonic}: invalid atomic register modifier must not emit definite effects`);
}

// Addressing modifiers live inside the memory operand and remain valid evidence.
const addressed=lift('ldxr','x0, [x1]');
assert.ok(addressed && addressed.completeness === 'exact-with-intrinsic');

// Keep this regression on a maintainer-owned head after canonical generated artifacts are synchronized.
console.log('arm64 atomic register modifier encoding: PASS');

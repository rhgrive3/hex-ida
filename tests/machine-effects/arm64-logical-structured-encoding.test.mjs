import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function lift(mnemonic, operands, suffix) {
  return liftArm64MachineEffects({
    instructionId:`arm64-logical-structured-${suffix}`,
    mnemonic,
    mode:'a64',
    ops:parseOperands(operands),
  });
}

for (const [mnemonic, operands] of [
  ['and','x0, x1, #1'],
  ['and','x0, x1, x2, lsr #63'],
  ['bic','x0, x1, x2, ror #1'],
  ['orn','w0, w1, w2, asr #31'],
  ['mvn','x0, x1, lsl #3'],
  ['tst','x0, #1'],
  ['tst','x0, x1, ror #7'],
]) {
  const effects = lift(mnemonic, operands, `valid-${mnemonic}-${operands.replace(/\W+/g,'-')}`);
  assert.equal(effects.completeness, 'exact', `${mnemonic}:${effects.unknownEffects?.reason}`);
}

for (const [mnemonic, operands, reason] of [
  ['and','x0, #1, #1','arm64-and-lhs-register-required'],
  ['and','x0, #1, x2','arm64-and-lhs-register-required'],
  ['bic','x0, x1, #1','arm64-bic-logical-immediate-unencodable'],
  ['orn','x0, #1, x2','arm64-orn-lhs-register-required'],
  ['mvn','x0, #1','arm64-mvn-source-register-required'],
  ['tst','#1, #1','arm64-tst-lhs-register-required'],
  ['tst','x0, #0','arm64-tst-logical-immediate-unencodable'],
]) {
  const effects = lift(mnemonic, operands, `invalid-${mnemonic}-${operands.replace(/\W+/g,'-')}`);
  assert.equal(effects.completeness, 'partial', `${mnemonic} malformed logical shape must fail closed`);
  assert.equal(effects.unknownEffects?.reason, reason);
  assert.equal(effects.metadata?.failClosed, true);
}

console.log('ARM64 scalar logical structured encoding validation: PASS');

import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function lift(mnemonic, operands, suffix) {
  return liftArm64MachineEffects({
    instructionId:`arm64-unary-shift-${suffix}`,
    mnemonic,
    mode:'a64',
    ops:parseOperands(operands),
  });
}

for (const [mnemonic, operands] of [
  ['clz','x0, x1'],
  ['rev','x0, x1'],
  ['sxtb','x0, w1'],
  ['lsl','x0, x1, #3'],
  ['ror','x0, x1, #63'],
  ['lslv','x0, x1, x2'],
  ['asrv','w0, w1, w2'],
]) {
  const effects = lift(mnemonic, operands, `valid-${mnemonic}`);
  assert.equal(effects.completeness, 'exact', `${mnemonic}:${effects.unknownEffects?.reason}`);
}

for (const [mnemonic, operands, reason] of [
  ['clz','x0, #1','arm64-clz-source-register-required'],
  ['rev','x0, #1','arm64-rev-source-register-required'],
  ['sxtb','x0, #1','arm64-sxtb-source-register-required'],
  ['lsl','x0, #1, #3','arm64-lsl-source-register-required'],
  ['ror','x0, #1, #3','arm64-ror-source-register-required'],
  ['lslv','x0, x1, #2','arm64-lslv-shift-register-required'],
  ['asrv','x0, #1, x2','arm64-asrv-source-register-required'],
]) {
  const effects = lift(mnemonic, operands, `invalid-${mnemonic}-${operands.replace(/\W+/g,'-')}`);
  assert.equal(effects.completeness, 'partial', `${mnemonic} malformed source must fail closed`);
  assert.equal(effects.unknownEffects?.reason, reason);
  assert.equal(effects.metadata?.failClosed, true);
}

console.log('ARM64 unary/shift structured encoding validation: PASS');

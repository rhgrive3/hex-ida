import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

// Keep this focused on canonical structured-input validation; the finite decoder
// denominator remains the authority for valid encoded instruction coverage.
function lift(mnemonic, operands, suffix) {
  return liftArm64MachineEffects({
    instructionId:`arm64-structured-encoding-${suffix}`,
    mnemonic,
    mode:'a64',
    ops:parseOperands(operands),
  });
}

for (const [suffix, operands] of [
  ['zero','x0, x1, #0'],
  ['imm12-max','x0, x1, #4095'],
  ['shifted-one','x0, x1, #1, lsl #12'],
  ['shifted-imm12-max','x0, x1, #4095, lsl #12'],
]) {
  const effects = lift('add', operands, suffix);
  assert.equal(effects.completeness, 'exact', `${operands}:${effects.unknownEffects?.reason}`);
}

for (const [mnemonic, operands] of [
  ['add','x0, x1, x2, lsl #0'],
  ['add','x0, x1, x2, lsr #63'],
  ['add','x0, x1, x2, asr #63'],
  ['add','w0, w1, w2, lsl #31'],
]) {
  const effects = lift(mnemonic, operands, `valid-shift-${operands.replace(/\W+/g,'-')}`);
  assert.equal(effects.completeness, 'exact', `${mnemonic} ${operands}:${effects.unknownEffects?.reason}`);
}

for (const [mnemonic, operands, reason] of [
  ['add','x0, x1, #4097','arm64-add-immediate-out-of-range'],
  ['sub','x0, x1, #-1','arm64-sub-immediate-out-of-range'],
  ['adds','x0, x1, #4096, lsl #12','arm64-adds-immediate-out-of-range'],
  ['subs','x0, x1, #1, lsr #12','arm64-subs-immediate-shift-unencodable'],
  ['adc','x0, x1, #1','arm64-adc-immediate-form-unencodable'],
  ['adcs','x0, x1, #1','arm64-adcs-immediate-form-unencodable'],
  ['sbc','x0, x1, #1','arm64-sbc-immediate-form-unencodable'],
  ['sbcs','x0, x1, #1','arm64-sbcs-immediate-form-unencodable'],
  ['neg','x0, #1','arm64-neg-immediate-form-unencodable'],
  ['negs','x0, #1','arm64-negs-immediate-form-unencodable'],
  ['ngc','x0, #1','arm64-ngc-immediate-form-unencodable'],
  ['ngcs','x0, #1','arm64-ngcs-immediate-form-unencodable'],
  ['add','x0, #1, x2','arm64-add-lhs-immediate-unencodable'],
  ['add','x0, x1, x2, ror #1','arm64-add-ror-shift-unencodable'],
  ['adds','x0, x1, x2, ror #1','arm64-adds-ror-shift-unencodable'],
  ['sub','x0, x1, x2, ror #1','arm64-sub-ror-shift-unencodable'],
  ['subs','x0, x1, x2, ror #1','arm64-subs-ror-shift-unencodable'],
]) {
  const effects = lift(mnemonic, operands, `${mnemonic}-${reason}`);
  assert.equal(effects.completeness, 'partial', `${mnemonic} ${operands} must fail closed`);
  assert.equal(effects.unknownEffects?.reason, reason);
  assert.equal(effects.metadata?.failClosed, true);
}

const rev32X = lift('rev32', 'x0, x1', 'rev32-x');
assert.equal(rev32X.completeness, 'exact', rev32X.unknownEffects?.reason);

for (const [operands, reason] of [
  ['w0, w1','arm64-rev32-destination-width-unencodable'],
  ['w0, x1','arm64-rev32-destination-width-unencodable'],
  ['x0, w1','arm64-rev32-source-width-unencodable'],
]) {
  const effects = lift('rev32', operands, `rev32-${operands.replace(/\W+/g,'-')}`);
  assert.equal(effects.completeness, 'partial', `rev32 ${operands} must fail closed`);
  assert.equal(effects.unknownEffects?.reason, reason);
  assert.equal(effects.metadata?.failClosed, true);
}

console.log('ARM64 structured encoding validation: PASS');

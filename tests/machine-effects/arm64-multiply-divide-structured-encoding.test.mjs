import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function lift(mnemonic, operands, suffix) {
  return liftArm64MachineEffects({
    instructionId:`arm64-muldiv-structured-${suffix}`,
    mnemonic,
    mode:'a64',
    ops:parseOperands(operands),
  });
}

for (const [mnemonic, operands] of [
  ['mul','x0, x1, x2'],
  ['sdiv','x0, x1, x2'],
  ['madd','x0, x1, x2, x3'],
  ['smull','x0, w1, w2'],
  ['smulh','x0, x1, x2'],
  ['umaddl','x0, w1, w2, x3'],
]) {
  const effects = lift(mnemonic, operands, `valid-${mnemonic}`);
  assert.equal(effects.completeness, 'exact', `${mnemonic}:${effects.unknownEffects?.reason}`);
}

for (const [mnemonic, operands] of [
  ['mul','x0, x1, #2'],
  ['sdiv','x0, x1, #2'],
  ['madd','x0, x1, x2, #3'],
  ['smull','x0, w1, #2'],
  ['smulh','x0, x1, #2'],
  ['umaddl','x0, w1, w2, #3'],
]) {
  const effects = lift(mnemonic, operands, `invalid-${mnemonic}`);
  assert.equal(effects.completeness, 'partial', `${mnemonic} immediate source must fail closed`);
  assert.equal(effects.unknownEffects?.reason, `arm64-${mnemonic}-source-register-required`);
  assert.equal(effects.metadata?.failClosed, true);
}

console.log('ARM64 multiply/divide structured encoding validation: PASS');

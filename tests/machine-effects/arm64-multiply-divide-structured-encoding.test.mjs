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
  ['mul','w0, w1, w2'],
  ['mneg','x0, x1, x2'],
  ['sdiv','x0, x1, x2'],
  ['udiv','w0, w1, w2'],
  ['madd','x0, x1, x2, x3'],
  ['msub','w0, w1, w2, w3'],
  ['smull','x0, w1, w2'],
  ['umull','x0, w1, w2'],
  ['smnegl','x0, w1, w2'],
  ['umnegl','x0, w1, w2'],
  ['smulh','x0, x1, x2'],
  ['umulh','x0, x1, x2'],
  ['smaddl','x0, w1, w2, x3'],
  ['smsubl','x0, w1, w2, x3'],
  ['umaddl','x0, w1, w2, x3'],
  ['umsubl','x0, w1, w2, x3'],
]) {
  const effects = lift(mnemonic, operands, `valid-${mnemonic}-${operands.replace(/\W+/g,'-')}`);
  assert.equal(effects.completeness, 'exact', `${mnemonic}:${effects.unknownEffects?.reason}`);
}

for (const [mnemonic, operands] of [
  ['mul','x0, x1, #2'],
  ['mul','x0, w1, x2'],
  ['sdiv','x0, x1, #2'],
  ['sdiv','x0, w1, x2'],
  ['madd','x0, x1, x2, #3'],
  ['madd','x0, x1, w2, x3'],
  ['smull','x0, w1, #2'],
  ['smull','x0, x1, w2'],
  ['smulh','x0, x1, #2'],
  ['smulh','x0, w1, x2'],
  ['umaddl','x0, w1, w2, #3'],
  ['umaddl','x0, x1, w2, x3'],
]) {
  const effects = lift(mnemonic, operands, `invalid-${mnemonic}-${operands.replace(/\W+/g,'-')}`);
  assert.equal(effects.completeness, 'partial', `${mnemonic} malformed source must fail closed`);
  assert.equal(effects.unknownEffects?.reason, `arm64-${mnemonic}-source-register-required`);
  assert.equal(effects.metadata?.failClosed, true);
}

for (const [mnemonic, operands] of [
  ['mul','x0, x1'],
  ['mneg','x0, x1, x2, x3'],
  ['sdiv','x0, x1, x2, x3'],
  ['udiv','x0, x1, x2, x3'],
  ['madd','x0, x1, x2'],
  ['msub','x0, x1, x2, x3, x4'],
  ['smull','x0, w1, w2, w3'],
  ['umull','x0, w1, w2, w3'],
  ['smnegl','x0, w1, w2, x3'],
  ['umnegl','x0, w1, w2, x3'],
  ['smulh','x0, x1, x2, x3'],
  ['umulh','x0, x1, x2, x3'],
  ['smaddl','x0, w1, w2, x3, x4'],
  ['smsubl','x0, w1, w2, x3, x4'],
  ['umaddl','x0, w1, w2, x3, x4'],
  ['umsubl','x0, w1, w2, x3, x4'],
]) {
  const effects = lift(mnemonic, operands, `shape-${mnemonic}-${operands.replace(/\W+/g,'-')}`);
  assert.equal(effects.completeness, 'partial', `${mnemonic} invalid arity must fail closed`);
  assert.equal(effects.unknownEffects?.reason, `arm64-${mnemonic}-operand-shape-unencodable`);
  assert.equal(effects.operations.length, 0, `${mnemonic} invalid arity must not emit semantic operations`);
  assert.equal(effects.metadata?.failClosed, true);
}

console.log('ARM64 multiply/divide structured encoding validation: PASS');

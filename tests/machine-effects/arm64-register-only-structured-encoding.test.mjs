import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function lift(mnemonic, operands, suffix) {
  return liftArm64MachineEffects({
    instructionId:`arm64-register-only-${suffix}`,
    mnemonic,
    mode:'a64',
    ops:parseOperands(operands),
  });
}

for (const [mnemonic, operands] of [
  ['extr','x0, x1, x2, #3'],
  ['extr','w0, w1, w2, #3'],
  ['csel','x0, x1, x2, eq'],
  ['csel','w0, w1, w2, eq'],
  ['csneg','x0, x1, x2, ne'],
  ['cinc','x0, x1, eq'],
  ['cinv','x0, x1, ne'],
]) {
  const effects = lift(mnemonic, operands, `valid-${mnemonic}-${operands.replace(/\W+/g,'-')}`);
  assert.equal(effects.completeness, 'exact', `${mnemonic}:${effects.unknownEffects?.reason}`);
}

for (const [mnemonic, operands] of [
  ['extr','x0, #1, x2, #3'],
  ['extr','x0, x1, #2, #3'],
  ['extr','x0, w1, x2, #3'],
  ['extr','w0, w1, x2, #3'],
  ['csel','x0, x1, #2, eq'],
  ['csel','x0, w1, x2, eq'],
  ['csinc','x0, #1, x2, eq'],
  ['csinc','w0, w1, x2, eq'],
  ['cinc','x0, #1, eq'],
  ['cinc','x0, w1, eq'],
  ['cneg','x0, #1, ne'],
]) {
  const effects = lift(mnemonic, operands, `invalid-${mnemonic}-${operands.replace(/\W+/g,'-')}`);
  assert.equal(effects.completeness, 'partial', `${mnemonic} malformed source must fail closed`);
  assert.equal(effects.unknownEffects?.reason, `arm64-${mnemonic}-source-register-required`);
  assert.equal(effects.metadata?.failClosed, true);
}

for (const mnemonic of ['cset','csetm']) {
  const effects = lift(mnemonic, `x0, eq`, `source-less-${mnemonic}`);
  assert.equal(effects.completeness, 'exact', `${mnemonic}:${effects.unknownEffects?.reason}`);
}

console.log('ARM64 register-only structured encoding validation: PASS');

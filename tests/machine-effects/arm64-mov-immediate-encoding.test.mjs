import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function lift(operands, suffix) {
  return liftArm64MachineEffects({
    instructionId:`arm64-mov-immediate-${suffix}`,
    mnemonic:'mov',
    mode:'a64',
    ops:parseOperands(operands),
  });
}

for (const [suffix, operands] of [
  ['movz-zero','x0, #0'],
  ['movz-lane','x0, #0x1234'],
  ['movn-all-ones','x0, #-1'],
  ['logical-mask','x0, #0xff00ff00ff00ff00'],
  ['w-movz','w0, #0xabcd'],
]) {
  const effects = lift(operands, suffix);
  assert.equal(effects.completeness, 'exact', `${operands}:${effects.unknownEffects?.reason}`);
}

for (const [suffix, operands] of [
  ['multi-wide-64','x0, #0x123456789abcdef0'],
  ['multi-wide-32','w0, #0x12345678'],
]) {
  const effects = lift(operands, suffix);
  assert.equal(effects.completeness, 'partial', `${operands} must fail closed`);
  assert.equal(effects.unknownEffects?.reason, 'arm64-mov-immediate-unencodable');
  assert.equal(effects.metadata?.failClosed, true);
}

const registerMove = lift('x0, x1', 'register');
assert.equal(registerMove.completeness, 'exact', registerMove.unknownEffects?.reason);

console.log('ARM64 MOV immediate encoding validation: PASS');

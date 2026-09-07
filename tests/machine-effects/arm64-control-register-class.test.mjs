import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function lift(mnemonic, operands, extra = {}) {
  return liftArm64MachineEffects({
    instructionId:`arm64-control-register-class:${mnemonic}:${operands || 'implicit'}`,
    mnemonic,
    mode:'a64',
    ops:parseOperands(operands),
    ...extra,
  });
}

for (const [mnemonic, operands, extra] of [
  ['br','x0',{}],
  ['br','xzr',{}],
  ['blr','x0',{ address:0x1000n }],
  ['blr','xzr',{ address:0x1000n }],
  ['ret','',{}],
  ['ret','x30',{}],
  ['ret','xzr',{}],
]) {
  const effects = lift(mnemonic, operands, extra);
  assert.equal(effects.completeness, 'exact', `${mnemonic} ${operands} must remain exact`);
}

for (const [mnemonic, operands, extra] of [
  ['br','sp',{}],
  ['blr','sp',{ address:0x1000n }],
  ['ret','sp',{}],
  ['br','w0',{}],
  ['blr','w0',{ address:0x1000n }],
  ['ret','w30',{}],
]) {
  const effects = lift(mnemonic, operands, extra);
  assert.equal(effects.completeness, 'partial', `${mnemonic} ${operands} must fail closed`);
  assert.match(effects.unknownEffects?.reason || '', new RegExp(`^arm64-${mnemonic}-operand-shape-invalid$`));
  assert.equal(effects.controlEffect?.kind, 'unknown');
  assert.equal(effects.operations.some((operation) => operation.kind === 'register-read'), false);
  assert.equal(effects.operations.some((operation) => operation.kind === 'register-write'), false);
}

console.log('ARM64 control register-class validation: PASS');

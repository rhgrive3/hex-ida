import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function lift(mnemonic, operands, extra = {}) {
  const instructionId = `arm64-control-operand-shape:${sequence++}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    mode:'a64',
    ops:parseOperands(operands),
    origin:{ instructionIds:[instructionId] },
    ...extra,
  });
}

for (const [mnemonic, operands, extra] of [
  ['br', 'x0', {}],
  ['blr', 'x0', { address:0x4000n }],
  ['ret', '', {}],
  ['ret', 'x30', {}],
]) {
  const effects = lift(mnemonic, operands, extra);
  assert.equal(effects.completeness, 'exact', `${mnemonic} ${operands}: valid operand shape regressed`);
}

for (const [mnemonic, operands, extra, reason] of [
  ['br', 'x0, x1', {}, /arm64-br-operand-shape-invalid/],
  ['blr', 'x0, x1', { address:0x4000n }, /arm64-blr-operand-shape-invalid/],
  ['ret', 'x30, x0', {}, /arm64-ret-operand-shape-invalid/],
]) {
  const effects = lift(mnemonic, operands, extra);
  assert.equal(effects.completeness, 'partial', `${mnemonic} ${operands}: encoding-impossible shape must fail closed`);
  assert.match(effects.unknownEffects.reason, reason);
  assert.equal(effects.operations.length, 0, `${mnemonic}: invalid shape must not emit register effects`);
  assert.equal(effects.controlEffect.kind, 'unknown', `${mnemonic}: invalid shape must not emit exact control`);
}

console.log('arm64 indirect control operand-shape effects: PASS');

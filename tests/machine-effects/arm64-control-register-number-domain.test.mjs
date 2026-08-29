import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function lift(mnemonic, operands, extra = {}, mutate = null) {
  const ops = parseOperands(operands);
  mutate?.(ops);
  const instructionId = `arm64-control-register-number-${++sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    operands,
    ops,
    mode:'a64',
    origin:{ instructionIds:[instructionId] },
    ...extra,
  });
}

for (const [mnemonic, operands, extra] of [
  ['br','x0',{}],
  ['br','x30',{}],
  ['br','xzr',{}],
  ['ret','x30',{}],
  ['ret','xzr',{}],
  ['cbz','w0, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
  ['cbz','xzr, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
  ['tbz','wzr, #31, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
  ['tbz','xzr, #63, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
]) {
  const effect = lift(mnemonic, operands, extra);
  assert.ok(effect);
  assert.notEqual(effect.completeness, 'partial', `${mnemonic} ${operands}: legal control register domain must remain exact`);
}

for (const [mnemonic, operands, extra, index, num] of [
  ['br','xzr',{},0,0],
  ['br','xzr',{},0,32],
  ['ret','xzr',{},0,99],
  ['cbz','xzr, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n },0,30],
  ['cbz','wzr, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n },0,99],
  ['tbz','xzr, #63, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n },0,32],
  ['tbz','wzr, #31, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n },0,-1],
  ['br','x30',{},0,31],
]) {
  const effect = lift(mnemonic, operands, extra, (ops) => { ops[index].num = num; });
  assert.ok(effect);
  assert.equal(effect.completeness, 'partial', `${mnemonic} ${operands}: invalid register number ${num} must fail closed`);
  assert.equal(effect.controlEffect.kind, 'unknown', `${mnemonic} ${operands}: invalid register number must not publish definite control flow`);
  assert.equal(
    effect.operations.filter((operation) => ['register-read','register-write'].includes(operation.kind)).length,
    0,
    `${mnemonic} ${operands}: invalid register number must not publish definite register effects`,
  );
}

console.log('arm64 control register-number domain validation: PASS');

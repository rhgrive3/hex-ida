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
  ['blr','x0',{ address:0x1000n }],
  ['blr','x30',{ address:0x1000n }],
  ['blr','xzr',{ address:0x1000n }],
  ['ret','x0',{}],
  ['ret','x30',{}],
  ['ret','xzr',{}],
  ['cbz','w0, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
  ['cbz','xzr, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
  ['cbnz','w30, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
  ['cbnz','wzr, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
  ['tbz','wzr, #31, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
  ['tbz','xzr, #63, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
  ['tbnz','w30, #31, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
  ['tbnz','xzr, #63, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n }],
]) {
  const effect = lift(mnemonic, operands, extra);
  assert.ok(effect);
  assert.notEqual(effect.completeness, 'partial', `${mnemonic} ${operands}: legal control register domain must remain exact`);
}

const invalidCases = [
  ['br','xzr',{},0,'zr-num-0',(ops, index) => { ops[index].num = 0; }],
  ['br','xzr',{},0,'zr-num-32',(ops, index) => { ops[index].num = 32; }],
  ['blr','xzr',{ address:0x1000n },0,'zr-num-99',(ops, index) => { ops[index].num = 99; }],
  ['ret','xzr',{},0,'zr-num-99',(ops, index) => { ops[index].num = 99; }],
  ['cbz','xzr, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n },0,'zr-num-30',(ops, index) => { ops[index].num = 30; }],
  ['cbnz','wzr, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n },0,'non-integer-num',(ops, index) => { ops[index].num = 1.5; }],
  ['tbz','xzr, #63, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n },0,'zr-num-32',(ops, index) => { ops[index].num = 32; }],
  ['tbnz','wzr, #31, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n },0,'missing-num',(ops, index) => { delete ops[index].num; }],
  ['tbz','wzr, #31, #0x1000',{ address:0x0ffcn, branchTarget:0x1000n },0,'negative-num',(ops, index) => { ops[index].num = -1; }],
  ['br','x30',{},0,'gp-num-31',(ops, index) => { ops[index].num = 31; }],
];

for (const [mnemonic, operands, extra, index, label, mutate] of invalidCases) {
  const effect = lift(mnemonic, operands, extra, (ops) => mutate(ops, index));
  assert.ok(effect);
  assert.equal(effect.completeness, 'partial', `${mnemonic} ${operands}: ${label} must fail closed`);
  assert.equal(effect.controlEffect.kind, 'unknown', `${mnemonic} ${operands}: ${label} must not publish definite control flow`);
  assert.equal(
    effect.operations.filter((operation) => ['register-read','register-write'].includes(operation.kind)).length,
    0,
    `${mnemonic} ${operands}: ${label} must not publish definite register effects`,
  );
}

console.log('arm64 control register-number domain validation: PASS');

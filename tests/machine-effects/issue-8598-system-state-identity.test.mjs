import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

const ctx = (instructionId) => ({ instructionId, origin:{ instructionIds:[instructionId] } });
const imm = (value, text = `#${value}`) => ({ k:'imm', value:BigInt(value), text });
const other = (text) => ({ k:'other', text });
const gp = (num, text = `x${num}`) => ({ k:'reg', cls:'gp', num, bits:64, text });
const sp = { k:'reg', cls:'sp', num:31, bits:64, text:'sp' };

function intrinsic(bundle) {
  return bundle.operations.find((operation) => operation.kind === 'intrinsic');
}

{
  for (const field of ['DAIFSet', 'DAIFClr']) {
    const effect = liftArm64MachineEffects({ mnemonic:'msr', ops:[other(field), imm(3)] }, ctx(`i-${field.toLowerCase()}`));
    const summary = intrinsic(effect).effectSummary;
    assert.ok(summary.registersRead.includes('sys:daif'));
    assert.ok(summary.registersWritten.includes('sys:daif'));
    assert.ok(!summary.registersWritten.includes(`sys:${field.toLowerCase()}`));
  }

  const read = liftArm64MachineEffects({ mnemonic:'mrs', ops:[gp(0), other('DAIF')] }, ctx('i-mrs-daif'));
  assert.ok(intrinsic(read).effectSummary.registersRead.includes('sys:daif'));

  const select = liftArm64MachineEffects({ mnemonic:'msr', ops:[other('SPSel'), imm(1)] }, ctx('i-spsel'));
  assert.ok(intrinsic(select).effectSummary.registersWritten.includes('sys:spsel'));
}

{
  const effect = liftArm64MachineEffects({
    mnemonic:'ldr',
    ops:[gp(0), { k:'mem', base:sp, disp:0n, mode:'offset' }],
  }, ctx('i-sp-load'));
  assert.ok(effect.operations.some((operation) => operation.kind === 'register-read'
    && operation.register.registerId === 'sys:spsel'));
  const semantic = lowerMachineEffectBundleToSemanticIr(effect, {
    functionId:'issue-8598-sp', blockId:'entry', addressWidthBits:64,
  });
  assert.ok(semantic.nodes.some((node) => node.kind === 'state-read'
    && node.variable?.physicalIdentity?.registerId === 'sys:spsel'));
}

for (const [mnemonic, ops] of [
  ['svc', [imm(0)]],
  ['hvc', [imm(0)]],
  ['smc', [imm(0)]],
  ['brk', [imm(0)]],
  ['hlt', [imm(0)]],
  ['eret', []],
  ['sys', [imm(0), other('c7'), other('c8'), imm(0)]],
]) {
  const effect = liftArm64MachineEffects({ mnemonic, ops }, ctx(`i-${mnemonic}`));
  const summary = intrinsic(effect).effectSummary;
  for (const state of ['sys:currentel', 'sys:daif', 'sys:spsel']) {
    assert.ok(summary.registersRead.includes(state), `${mnemonic} reads ${state}`);
    assert.ok(summary.registersWritten.includes(state), `${mnemonic} writes ${state}`);
  }
}

console.log('issue-8598-system-state-identity: PASS');

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

function hasRegisterRead(bundle, registerId) {
  return bundle.operations.some((operation) => operation.kind === 'register-read'
    && operation.register.registerId === registerId);
}

{
  const fields = [
    ['UAO', 1, 'sys:uao'],
    ['PAN', 1, 'sys:pan'],
    ['SPSel', 1, 'sys:spsel'],
    ['SSBS', 1, 'sys:ssbs'],
    ['DIT', 1, 'sys:dit'],
    ['TCO', 1, 'sys:tco'],
    ['DAIFSet', 3, 'sys:daif'],
    ['DAIFClr', 3, 'sys:daif'],
    ['ALLINT', 1, 'sys:allint'],
    ['PM', 2, 'sys:pm'],
    ['SVCRSM', 2, 'sys:svcr'],
    ['SVCRZA', 4, 'sys:svcr'],
    ['SVCRSMZA', 6, 'sys:svcr'],
  ];
  for (const [field, value, stateId] of fields) {
    const effect = liftArm64MachineEffects({ mnemonic:'msr', ops:[other(field), imm(value)] }, ctx(`i-${field.toLowerCase()}`));
    const summary = intrinsic(effect).effectSummary;
    assert.ok(summary.registersWritten.includes(stateId), `${field} writes ${stateId}`);
    if (field === 'DAIFSet' || field === 'DAIFClr') {
      assert.ok(summary.registersRead.includes('sys:daif'));
      assert.ok(!summary.registersWritten.includes(`sys:${field.toLowerCase()}`));
    }
  }

  const read = liftArm64MachineEffects({ mnemonic:'mrs', ops:[gp(0), other('DAIF')] }, ctx('i-mrs-daif'));
  assert.ok(intrinsic(read).effectSummary.registersRead.includes('sys:daif'));
}

{
  const effect = liftArm64MachineEffects({
    mnemonic:'ldr',
    ops:[gp(0), { k:'mem', base:sp, disp:0n, mode:'offset' }],
  }, ctx('i-sp-load'));
  assert.ok(hasRegisterRead(effect, 'sys:spsel'));
  const semantic = lowerMachineEffectBundleToSemanticIr(effect, {
    functionId:'issue-8598-sp', blockId:'entry', addressWidthBits:64,
  });
  assert.ok(semantic.nodes.some((node) => node.kind === 'state-read'
    && node.variable?.physicalIdentity?.registerId === 'sys:spsel'));
}

{
  const alternateShapes = [
    { operandsParsed:[other('SPSel'), imm(1)] },
    { parsed:[other('SPSel'), imm(1)] },
  ];
  for (const [index, shape] of alternateShapes.entries()) {
    const effect = liftArm64MachineEffects({
      mnemonic:'msr',
      ...shape,
    }, ctx(`i-alt-spsel-${index}`));
    assert.ok(intrinsic(effect).effectSummary.registersWritten.includes('sys:spsel'));
  }
}

{
  const nonSp = liftArm64MachineEffects({
    mnemonic:'ldr',
    ops:[gp(0), { k:'mem', base:gp(1), disp:0n, mode:'offset' }],
  }, ctx('i-gp-load'));
  assert.ok(!hasRegisterRead(nonSp, 'sys:spsel'));
}

{
  const effect = liftArm64MachineEffects({
    mnemonic:'msr',
    ops:[other('SPSel'), imm(1)],
  }, ctx('i-non-conservative'));
  const summary = intrinsic(effect).effectSummary;
  assert.ok(summary.registersWritten.includes('sys:spsel'));
  assert.ok(!summary.registersRead.includes('sys:currentel'));
  assert.ok(!summary.registersWritten.includes('sys:currentel'));
  assert.ok(!summary.registersRead.includes('sys:tpidr_el0'));
  assert.ok(!summary.registersWritten.includes('sys:tpidr_el0'));
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

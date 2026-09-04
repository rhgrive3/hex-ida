import assert from 'node:assert/strict';
import { categoryOf, explain, parseOperands } from '../js/arm64.js';
import { ARM64_ARCHITECTURE } from '../js/targets/architecture/index.js';
import { isArm64ControlEffectMnemonic, liftArm64ControlEffects } from '../js/targets/architecture/arm64/effects/control.js';
import { conditionOf } from '../js/targets/architecture/arm64/effects/common.js';
import { createCapstoneArm64Session } from './machine-effects/helpers/arm64-capstone-session.mjs';

console.log('Testing #5575: ARM64 FEAT_HBC BC.<cond> control flow and machine effects...');

const classify = ARM64_ARCHITECTURE.classifyControlFlow;
const directTarget = ARM64_ARCHITECTURE.directControlTarget;

// 1. Classification
assert.equal(classify({ mnemonic: 'bc.eq' }), 'conditional-branch');
assert.equal(classify({ mnemonic: 'bc.ne' }), 'conditional-branch');
assert.equal(classify({ mnemonic: 'bc.lt' }), 'conditional-branch');
assert.equal(classify({ mnemonic: 'bc.ge' }), 'conditional-branch');
assert.equal(classify({ mnemonic: 'bc.al' }), 'branch');
assert.equal(classify({ mnemonic: 'bc.nv' }), 'branch');

// 2. Direct control target
assert.equal(directTarget({ mnemonic: 'bc.eq', branchTarget: 0x5000n }), 0x5000n);
assert.equal(directTarget({ mnemonic: 'bc.ne', branchTarget: '20480' }), 20480n);
assert.equal(directTarget({ mnemonic: 'bc.eq', branchTarget: null }), null);

// 3. Mnemonic recognition in control effects
assert.equal(isArm64ControlEffectMnemonic('bc.eq'), true);
assert.equal(isArm64ControlEffectMnemonic('bc.ne'), true);
assert.equal(isArm64ControlEffectMnemonic('bc.hi'), true);
assert.equal(isArm64ControlEffectMnemonic('bc.invalid'), false);

// 4. BC.EQ generates conditional-branch with NZCV.Z check and conditionCode 'eq'
{
  const insn = {
    instructionId: 'i_bc_eq',
    mnemonic: 'bc.eq',
    operands: '#0x5000',
    ops: parseOperands('#0x5000'),
    address: 0x4000n,
    branchTarget: 0x5000n,
    origin: { instructionIds: ['i_bc_eq'] },
  };
  const bundle = liftArm64ControlEffects(insn);
  assert.ok(bundle);
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.controlEffect.kind, 'conditional-branch');
  assert.equal(bundle.controlEffect.target.value, String(0x5000));
  assert.equal(bundle.controlEffect.fallthrough.value, String(0x4004));
  assert.equal(bundle.metadata.conditionCode, 'eq', 'conditionCode must be eq, not .eq');
  assert.equal(bundle.metadata.operation, 'bc.eq');

  const flagReads = bundle.operations.filter((op) => op.kind === 'flag-read').map((op) => op.flag.flagId);
  assert.deepEqual(flagReads, ['NZCV.Z']);
}

// 5. All standard conditions produce exact effects with correct condition codes
const conditions = ['eq','ne','cs','hs','cc','lo','mi','pl','vs','vc','hi','ls','ge','lt','gt','le'];
for (const cond of conditions) {
  const insn = {
    instructionId: `i_bc_${cond}`,
    mnemonic: `bc.${cond}`,
    operands: '#0x6000',
    ops: parseOperands('#0x6000'),
    address: 0x4000n,
    branchTarget: 0x6000n,
    origin: { instructionIds: [`i_bc_${cond}`] },
  };
  const bundle = liftArm64ControlEffects(insn);
  assert.ok(bundle, `bc.${cond} produces bundle`);
  assert.equal(bundle.completeness, 'exact', `bc.${cond} is exact`);
  assert.equal(bundle.metadata.conditionCode, cond, `bc.${cond} extracts condition ${cond}`);
  assert.equal(conditionOf(insn), cond, `conditionOf extracts ${cond}`);
}

// 6. Fail-closed: misaligned target and out-of-range displacement
{
  const misaligned = liftArm64ControlEffects({
    instructionId: 'i_misaligned',
    mnemonic: 'bc.eq',
    operands: '#0x5001',
    ops: parseOperands('#0x5001'),
    address: 0x4000n,
    branchTarget: 0x5001n,
    origin: { instructionIds: ['i_misaligned'] },
  });
  assert.equal(misaligned.completeness, 'partial');

  // 19-bit signed displacement max is +1048572 (0xffffc)
  const outOfRange = liftArm64ControlEffects({
    instructionId: 'i_range',
    mnemonic: 'bc.eq',
    operands: '#0x2000000',
    ops: parseOperands('#0x2000000'),
    address: 0x4000n,
    branchTarget: 0x2004000n,
    origin: { instructionIds: ['i_range'] },
  });
  assert.equal(outOfRange.completeness, 'partial');
}

// 7. Existing b.eq, cbz, tbz preserved
{
  const beq = liftArm64ControlEffects({
    instructionId: 'i_beq',
    mnemonic: 'b.eq',
    operands: '#0x5000',
    ops: parseOperands('#0x5000'),
    address: 0x4000n,
    branchTarget: 0x5000n,
    origin: { instructionIds: ['i_beq'] },
  });
  assert.equal(beq.completeness, 'exact');
  assert.equal(beq.metadata.conditionCode, 'eq');
}

// 8. Presentation categoryOf and explain
assert.equal(categoryOf('bc.eq'), 'flow');
assert.equal(categoryOf('bc.ne'), 'flow');
const explanation = explain('bc.eq', '#0x10', 0x1000n);
assert.equal(explanation.category, 'flow');
assert.ok(explanation.pseudo.startsWith('if ('));

// 9. Capstone decoder end-to-end integration
const session = await createCapstoneArm64Session();
// bc.eq 10 <.text+0x10> encoded as 0x54000090 (little-endian: 90 00 00 54)
const decoded = session.decode(Uint8Array.of(0x90, 0x00, 0x00, 0x54), 0x1000n);
assert.equal(decoded.length, 1);
assert.equal(decoded[0].mnemonic, 'bc.eq');
const capstoneInsn = {
  instructionId: 'capstone-bc-eq',
  address: decoded[0].address,
  mnemonic: decoded[0].mnemonic,
  operands: decoded[0].opStr,
  ops: parseOperands(decoded[0].opStr),
  mode: 'a64',
  origin: { instructionIds: ['capstone-bc-eq'] },
};
const capstoneBundle = liftArm64ControlEffects(capstoneInsn);
assert.ok(capstoneBundle);
assert.equal(capstoneBundle.completeness, 'exact');
assert.equal(capstoneBundle.controlEffect.kind, 'conditional-branch');
assert.equal(capstoneBundle.controlEffect.target.value, String(0x1010));
assert.equal(capstoneBundle.metadata.conditionCode, 'eq');

console.log('#5575 tests passed successfully.');

import assert from 'node:assert/strict';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { isArm64ControlEffectMnemonic } from '../../js/targets/architecture/arm64/effects/control.js';

let sequence = 0;
function bcBranch({ condition = 'eq', branchTarget = 0x1008n, rawBytes = [0x40, 0x00, 0x00, 0x54], address = 0x1000n, ops } = {}) {
  const instructionId = `issue-5575-bc-${++sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    mode: 'a64',
    address,
    mnemonic: `bc.${condition}`,
    ...(rawBytes == null ? {} : { rawBytes }),
    ...(branchTarget === undefined ? {} : { branchTarget }),
    ops: ops === undefined ? [{ k: 'imm', value: branchTarget }] : ops,
    origin: { instructionIds: [instructionId] },
  });
}

// #5575: FEAT_HBC `BC.<cond>` is a PC-relative conditional branch. The
// control-flow classifier, direct-target resolver, and exact MachineEffects
// control lifter only recognized `B.<cond>`, so `bc.eq` degraded to a
// plain fallthrough: no CFG edge, no direct target, no control effect.

// Classifier: BC.<cond> is a conditional branch, same family as B.<cond>.
assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic: 'bc.eq' }), 'conditional-branch');
assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic: 'bc.ne' }), 'conditional-branch');
assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic: 'bc.lt' }), 'conditional-branch');
// B.<cond> and unrelated mnemonics keep their existing classification.
assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic: 'b.eq' }), 'conditional-branch');
assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic: 'b' }), 'branch');
assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic: 'nop' }), 'fallthrough');

// Direct control target: the decoded branchTarget must surface.
assert.equal(ARM64_ARCHITECTURE.directControlTarget({ mnemonic: 'bc.eq', branchTarget: 0x2000n }), 0x2000n);
assert.equal(ARM64_ARCHITECTURE.directControlTarget({ mnemonic: 'bc.eq' }), null);

// MachineEffects family recognition follows the same conditional-control set.
assert.equal(isArm64ControlEffectMnemonic('bc.eq'), true);
assert.equal(isArm64ControlEffectMnemonic('bc.le'), true);
assert.equal(isArm64ControlEffectMnemonic('bc.xy'), false);
assert.equal(isArm64ControlEffectMnemonic('b.eq'), true);

// Exact lift: encoding imm19, operand, and branchTarget all agree.
{
  const bundle = bcBranch({});
  assert.equal(bundle?.completeness, 'exact');
  assert.equal(bundle.controlEffect.kind, 'conditional-branch');
  assert.equal(bundle.controlEffect.target?.value, '4104');
  assert.equal(bundle.controlEffect.fallthrough?.value, '4100');
  assert.equal(bundle.metadata?.operation, 'bc.eq');
  assert.equal(bundle.metadata?.conditionCode, 'eq');
  assert.match(String(bundle.controlEffect?.condition?.temporaryId ?? ''), /read-Z/);
}

// The condition is read from the NZCV predicate named by the mnemonic:
// `bc.ne` inverts Z instead of reusing `b.`'s slice(2) text ('.ne').
{
  const bundle = bcBranch({ condition: 'ne', rawBytes: [0x41, 0x00, 0x00, 0x54] });
  assert.equal(bundle?.completeness, 'exact');
  assert.equal(bundle.metadata?.conditionCode, 'ne');
  assert.match(String(bundle.controlEffect?.condition?.temporaryId ?? ''), /not-bool/);
}

// Redundant evidence must still agree: the imm19 word says pc+8, a
// contradictory branchTarget fails closed instead of exacting either edge.
{
  const bundle = bcBranch({ branchTarget: 0x1004n });
  assert.equal(bundle?.completeness, 'partial');
  assert.match(bundle.unknownEffects?.reason ?? '', /target-evidence-mismatch/);
}

// imm19 range is enforced for BC just like B.cond (19-bit signed, x4):
// agreeing target evidence beyond the ±1MB encoding window stays partial.
{
  const far = bcBranch({ branchTarget: 0x200000n, rawBytes: null });
  assert.equal(far?.completeness, 'partial');
  assert.match(far.unknownEffects?.reason ?? '', /target-out-of-range-encoding/);
}

// Misaligned targets stay fail-closed.
{
  const misaligned = bcBranch({ branchTarget: 0x1002n, rawBytes: [0x42, 0x00, 0x00, 0x54] });
  assert.equal(misaligned?.completeness, 'partial');
  assert.match(misaligned.unknownEffects?.reason ?? '', /target-misaligned-encoding/);
}

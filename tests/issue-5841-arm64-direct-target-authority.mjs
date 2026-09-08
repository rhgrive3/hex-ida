import assert from 'node:assert/strict';
import { directTargetOf } from '../../js/targets/architecture/arm64/effects/common.js';
import { liftArm64ControlEffects } from '../../js/targets/architecture/arm64/effects/control.js';

function branchInstruction(explicitTarget, id = 'issue-5841-b') {
  return {
    instructionId: id,
    mnemonic: 'b',
    mode: 'a64',
    address: 0n,
    branchTarget: explicitTarget,
    ops: [{ k: 'other', text: 'symbolic-target' }],
    origin: { instructionIds: [id] },
  };
}

function callInstruction(explicitTarget, id = 'issue-5841-bl') {
  return {
    instructionId: id,
    mnemonic: 'bl',
    mode: 'a64',
    address: 0n,
    callTarget: explicitTarget,
    ops: [{ k: 'other', text: 'symbolic-target' }],
    origin: { instructionIds: [id] },
  };
}

{
  const branch = liftArm64ControlEffects(branchInstruction(4096n));
  assert.equal(branch.completeness, 'exact');
  assert.equal(branch.controlEffect.kind, 'branch');
  assert.equal(branch.controlEffect.target.value, '4096');

  const call = liftArm64ControlEffects(callInstruction(4096n));
  assert.equal(call.completeness, 'exact');
  assert.equal(call.controlEffect.kind, 'call');
  assert.equal(call.controlEffect.target.value, '4096');
}

{
  let coercions = 0;
  const coercible = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      return 4096;
    },
  };
  const malformed = [
    [4096],
    ['4096'],
    4096,
    true,
    coercible,
  ];

  for (const [index, explicitTarget] of malformed.entries()) {
    assert.equal(directTargetOf({ branchTarget: explicitTarget }, 'branch'), null);
    assert.equal(directTargetOf({ callTarget: explicitTarget }, 'call'), null);

    const branch = liftArm64ControlEffects(branchInstruction(explicitTarget, `issue-5841-b-malformed-${index}`));
    assert.equal(branch.completeness, 'partial');
    assert.equal(branch.controlEffect.kind, 'unknown');
    assert.equal(branch.unknownEffects.reason, 'arm64-b-target-unavailable');

    const call = liftArm64ControlEffects(callInstruction(explicitTarget, `issue-5841-bl-malformed-${index}`));
    assert.equal(call.completeness, 'partial');
    assert.equal(call.controlEffect.kind, 'unknown');
    assert.equal(call.unknownEffects.reason, 'arm64-bl-target-unavailable');
  }

  assert.equal(coercions, 0, 'explicit direct-target authority must not invoke structured coercion hooks');
}

{
  const conditionalFamilies = [
    ['b.eq', [{ k: 'other', text: 'symbolic-target' }]],
    ['bc.eq', [{ k: 'other', text: 'symbolic-target' }]],
    ['cbz', [{ k: 'reg', cls: 'gp', num: 0, bits: 64 }, { k: 'other', text: 'symbolic-target' }]],
    ['tbz', [{ k: 'reg', cls: 'gp', num: 0, bits: 64 }, { k: 'imm', value: 0n, text: '#0' }, { k: 'other', text: 'symbolic-target' }]],
  ];
  for (const [mnemonic, ops] of conditionalFamilies) {
    const result = liftArm64ControlEffects({
      instructionId: `issue-5841-${mnemonic}-malformed`,
      mnemonic,
      mode: 'a64',
      address: 0n,
      branchTarget: [4096],
      ops,
      origin: { instructionIds: [`issue-5841-${mnemonic}-malformed`] },
    });
    assert.equal(result.completeness, 'partial');
    assert.equal(result.controlEffect.kind, 'unknown');
    assert.match(result.unknownEffects.reason, /target-unavailable|targets-unavailable/);
  }

  const misaligned = liftArm64ControlEffects({
    instructionId: 'issue-5841-misaligned', mnemonic: 'b', mode: 'a64', address: 0n,
    branchTarget: 2n, ops: [{ k: 'other', text: '#2' }],
    origin: { instructionIds: ['issue-5841-misaligned'] },
  });
  assert.equal(misaligned.completeness, 'partial');
  assert.equal(misaligned.unknownEffects.reason, 'arm64-b-target-misaligned-encoding');

  const outOfRange = liftArm64ControlEffects({
    instructionId: 'issue-5841-out-of-range', mnemonic: 'b', mode: 'a64', address: 0n,
    branchTarget: 1n << 29n, ops: [{ k: 'other', text: '#536870912' }],
    origin: { instructionIds: ['issue-5841-out-of-range'] },
  });
  assert.equal(outOfRange.completeness, 'partial');
  assert.equal(outOfRange.unknownEffects.reason, 'arm64-b-target-out-of-range-encoding');
}

{
  const textOnly = liftArm64ControlEffects({
    instructionId: 'issue-5841-text-target',
    mnemonic: 'b',
    mode: 'a64',
    address: 0n,
    ops: [{ k: 'other', text: '#4096' }],
    origin: { instructionIds: ['issue-5841-text-target'] },
  });
  assert.equal(textOnly.completeness, 'exact');
  assert.equal(textOnly.controlEffect.target.value, '4096');

  const immediate = liftArm64ControlEffects({
    instructionId: 'issue-5841-imm-target',
    mnemonic: 'b',
    mode: 'a64',
    address: 0n,
    ops: [{ k: 'imm', value: 4096n, text: '#4096' }],
    origin: { instructionIds: ['issue-5841-imm-target'] },
  });
  assert.equal(immediate.completeness, 'exact');
  assert.equal(immediate.controlEffect.target.value, '4096');
}

console.log('issue 5841 arm64 explicit direct target authority: PASS');

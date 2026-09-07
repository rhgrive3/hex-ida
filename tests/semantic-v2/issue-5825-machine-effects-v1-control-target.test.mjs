import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import { OP } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createRegisterValue,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectsToLegacyV1 } from '../../js/semantics/compat/index.js';

const instructionId = createInstructionId({
  binaryId: 'bin_compat_target', sliceId: 'slice_compat_target', virtualAddress: 0x1000n,
  decodeMode: 'a64', decoderSemanticVersion: '1',
});
const origin = {
  instructionIds: [instructionId],
  byteRanges: [{ binaryId: 'bin_compat_target', start: 0x20n, end: 0x24n }],
  virtualRanges: [{ imageId: 'image_compat_target', sliceId: 'slice_compat_target', start: 0x1000n, end: 0x1004n }],
};

function lower(controlEffect) {
  const bundle = createMachineEffectBundle({
    instructionId,
    architectureId: 'arm64',
    mode: 'a64',
    operations: [],
    controlEffect,
    possibleFaults: [],
    origin,
    completeness: 'exact',
    statePreservation: { proven: true, reason: 'target-validation regression' },
  });
  return lowerMachineEffectsToLegacyV1(bundle);
}

const invalidTargets = [
  '', '   ', 'not-an-integer', '0x', '1.5',
  { address: true }, { address: [] }, { value: [] }, { value: true },
  Number.MAX_SAFE_INTEGER + 1,
];
for (const target of invalidTargets) {
  for (const kind of ['call', 'branch']) {
    const [lowered] = lower({ kind, target });
    assert.equal(lowered.op, kind === 'call' ? OP.CALL : OP.BR);
    assert.equal(lowered.target, null, kind + ' invalid target must fail closed');
    assert.equal(lowered.indirect, true, kind + ' invalid target must not be direct');
    assert.deepEqual(lowered.srcs, [], kind + ' invalid primitive target has no source');
  }

  const [conditional] = lower({
    kind: 'conditional-branch',
    target,
    fallthrough: createBitVectorValue(64, 0x1004n),
    condition: createRegisterValue('x5', 64),
  });
  assert.equal(conditional.op, OP.CBR);
  assert.equal(conditional.target, null, 'conditional invalid target must not be exact');
  assert.deepEqual(conditional.srcs, [{ t: 'reg', reg: 'x5', bits: 64 }]);
}

const validTargets = [
  [0n, 0n],
  [0, 0n],
  ['0', 0n],
  ['4096', 4096n],
  ['0x1000', 4096n],
];
for (const [target, expected] of validTargets) {
  const [call] = lower({ kind: 'call', target });
  assert.equal(call.op, OP.CALL);
  assert.equal(call.target, expected, 'valid target ' + String(target) + ' is preserved');
  assert.equal(call.indirect, false);

  const [branch] = lower({ kind: 'branch', target });
  assert.equal(branch.op, OP.BR);
  assert.equal(branch.target, expected);
  assert.equal(branch.indirect, false);
}

for (const [target, expectedRegister] of [
  [createRegisterValue('x1', 64), 'x1'],
  [createTemporaryValue('target-tmp', createBitVectorValue(64)), '$me:target-tmp'],
]) {
  const [call] = lower({ kind: 'call', target });
  assert.equal(call.target, null, 'register/temporary targets are indirect');
  assert.equal(call.indirect, true);
  assert.deepEqual(call.srcs, [{ t: 'reg', reg: expectedRegister, bits: 64 }]);
}

console.log('issue-5825 machine-effects v1 control-target validation: PASS');

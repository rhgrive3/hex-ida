import assert from 'node:assert/strict';

import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createIntrinsicEffectSummary,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

const instructionId = createInstructionId({
  binaryId: 'bin-4478',
  sliceId: 'slice-4478',
  virtualAddress: 0x1000n,
  decodeMode: 'a64',
  decoderSemanticVersion: '1',
});
const origin = { instructionIds: [instructionId], byteRanges: [{ binaryId: 'bin-4478', start: 0x1000n, end: 0x1004n }] };
const target = (value) => createBitVectorValue(64, value);
const base = {
  instructionId,
  architectureId: 'arm64',
  mode: 'a64',
  operations: [],
  possibleFaults: [],
  origin,
};
const exact = (controlEffect) => createMachineEffectBundle({ ...base, controlEffect, completeness: 'exact' });
const condition = { kind: 'bitvector', widthBits: 1, value: '1' };

assert.throws(() => exact({ kind: 'branch' }), /machine-effects-exact-has-unresolved-effects/);
assert.throws(() => exact({ kind: 'conditional-branch', target: target(0x2000n), fallthrough: target(0x1004n) }), /machine-effects-exact-has-unresolved-effects/);
assert.throws(() => exact({
  kind: 'conditional-branch',
  condition,
  target: target(0x2000n),
}), /machine-effects-exact-has-unresolved-effects/);
assert.throws(() => exact({ kind: 'conditional-branch', condition, fallthrough: target(0x1004n) }), /machine-effects-exact-has-unresolved-effects/);

assert.doesNotThrow(() => exact({ kind: 'branch', targets: [target(0x2000n)] }));
assert.doesNotThrow(() => exact({
  kind: 'conditional-branch',
  condition,
  targets: [target(0x2000n), target(0x1004n)],
}));
assert.doesNotThrow(() => exact({ kind: 'indirect', target: target(0x2000n), reason: 'computed control transfer' }));
assert.throws(() => exact({ kind: 'fallthrough', target: target(0x2000n) }), /machine-effects-control-field-not-allowed/);
assert.throws(() => exact({ kind: 'branch', target: target(0x2000n), condition }), /machine-effects-control-field-not-allowed/);
assert.throws(() => exact({ kind: 'conditional-branch', condition, target: target(0x2000n), reason: 'ignored' }), /machine-effects-control-field-not-allowed/);
assert.throws(() => exact({ kind: 'trap', target: target(0x2000n) }), /machine-effects-control-field-not-allowed/);

const incompleteIntrinsic = createIntrinsicEffectSummary({
  inputs: [],
  outputs: [],
  registersRead: [],
  registersWritten: [],
  memoryRead: { scope: 'none' },
  memoryWrite: { scope: 'none' },
  controlEffects: [{ kind: 'branch' }],
  determinism: 'deterministic',
  symbolicDetail: 'summary-only',
});
assert.throws(() => createMachineEffectBundle({
  ...base,
  operations: [createMachineOperation({ kind: 'intrinsic', intrinsicId: 'incomplete-control-shape', effectSummary: incompleteIntrinsic })],
  controlEffect: { kind: 'fallthrough' },
  completeness: 'exact-with-intrinsic',
}), /machine-effects-intrinsic-completeness-invalid/);

const validConditional = exact({
  kind: 'conditional-branch',
  condition,
  target: target(0x2000n),
  fallthrough: target(0x1004n),
});
const lowered = lowerMachineEffectBundleToSemanticIr(validConditional, {
  functionId: 'function-4478',
  blockId: 'block-4478',
  addressWidthBits: 64,
});
assert.equal(lowered.completeness, 'complete');
assert.ok(lowered.nodes.some((node) => node.kind === 'conditional-branch'));

const partialBranch = createMachineEffectBundle({
  ...base,
  controlEffect: { kind: 'branch' },
  completeness: 'partial',
  unknownEffects: { categories: ['control'], reason: 'branch target unavailable' },
});
assert.equal(partialBranch.completeness, 'partial');
assert.equal(lowerMachineEffectBundleToSemanticIr(partialBranch, {
  functionId: 'function-4478-partial',
  blockId: 'block-4478-partial',
  addressWidthBits: 64,
}).completeness, 'partial');

const unknownControl = createMachineEffectBundle({
  ...base,
  controlEffect: { kind: 'unknown', reason: 'unsupported control shape' },
  completeness: 'unknown',
  unknownEffects: { categories: ['control'], reason: 'unsupported control shape' },
});
assert.equal(unknownControl.completeness, 'unknown');

console.log('issue-4478 machine-effects control shape: ok');

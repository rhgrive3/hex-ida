import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

const instructionId = createInstructionId({
  binaryId: 'bin_issue_3609',
  sliceId: 'slice_issue_3609',
  virtualAddress: 0x4010n,
  decodeMode: 'synthetic-mode',
  decoderSemanticVersion: '1',
});
const origin = {
  instructionIds: [instructionId],
  byteRanges: [{ binaryId: 'bin_issue_3609', start: 0n, end: 4n }],
};
const result = createTemporaryValue('value', createBitVectorValue(32));
const bundle = createMachineEffectBundle({
  instructionId,
  architectureId: 'synthetic-neutral-isa',
  mode: 'synthetic-mode',
  operations: [createMachineOperation({
    kind: 'register-read',
    id: 'effect.read',
    register: createRegisterValue('bank.a', 32, { view: 'view:bank.a' }),
    value: result,
  })],
  controlEffect: { kind: 'fallthrough' },
  possibleFaults: [],
  origin,
  completeness: 'exact',
});

function lower(context) {
  return lowerMachineEffectBundleToSemanticIr(bundle, { addressWidthBits: 64, ...context });
}
function reject(context, code) {
  assert.throws(
    () => lower(context),
    (error) => error instanceof TypeError && error.message === code,
  );
}

const canonical = lower({ functionId: ' function ', blockId: ' block ' });
assert.equal(canonical.functionId, 'function');
assert.equal(canonical.entryBlockId, 'block');
assert.equal(lower({ functionId: 'function', blockId: 'block', entryBlockId: null }).entryBlockId, 'block');
assert.equal(lower({ functionId: 'function', blockId: 'block', entryBlockId: 'block' }).entryBlockId, 'block');

for (const value of [['function'], 1, true, new String('function')]) {
  reject({ functionId: value, blockId: 'block' }, 'semantic-ir-lowering-function-id-required');
}
for (const value of [['block'], 1, true, new String('block')]) {
  reject({ functionId: 'function', blockId: value }, 'semantic-ir-lowering-block-id-required');
}
for (const value of [['block'], 1, true, new String('block')]) {
  reject({ functionId: 'function', blockId: 'block', entryBlockId: value }, 'semantic-ir-lowering-entry-block-id-required');
}

let functionCoercions = 0;
reject({
  functionId: { toString() { functionCoercions += 1; return 'function'; } },
  blockId: 'block',
}, 'semantic-ir-lowering-function-id-required');
assert.equal(functionCoercions, 0, 'function identity must not invoke coercion hooks');

let blockCoercions = 0;
reject({
  functionId: 'function',
  blockId: { valueOf() { blockCoercions += 1; return 'block'; }, toString() { blockCoercions += 1; return 'block'; } },
}, 'semantic-ir-lowering-block-id-required');
assert.equal(blockCoercions, 0, 'block identity must not invoke coercion hooks');

let entryCoercions = 0;
reject({
  functionId: 'function',
  blockId: 'block',
  entryBlockId: { toString() { entryCoercions += 1; return 'block'; } },
}, 'semantic-ir-lowering-entry-block-id-required');
assert.equal(entryCoercions, 0, 'entry identity must not invoke coercion hooks');

let entryReads = 0;
const hostileEntryContext = Object.create(null, {
  functionId: { value: 'function', enumerable: true },
  blockId: { value: 'block', enumerable: true },
  addressWidthBits: { value: 64, enumerable: true },
  entryBlockId: {
    enumerable: true,
    get() {
      entryReads += 1;
      return entryReads === 1 ? ['block'] : 'block';
    },
  },
});
assert.throws(
  () => lowerMachineEffectBundleToSemanticIr(bundle, hostileEntryContext),
  (error) => error instanceof TypeError && error.message === 'semantic-ir-lowering-entry-block-id-required',
);
assert.equal(entryReads, 1, 'entryBlockId must be snapshotted exactly once');

console.log('semantic-v2 issue #3609 lowering identity type boundary: PASS');

import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

const instructionId = createInstructionId({
  binaryId: 'bin_issue_3614',
  sliceId: 'slice_issue_3614',
  virtualAddress: 0x4020n,
  decodeMode: 'synthetic-mode',
  decoderSemanticVersion: '1',
});
const origin = {
  instructionIds: [instructionId],
  byteRanges: [{ binaryId: 'bin_issue_3614', start: 0n, end: 4n }],
};

function makeBundle(value) {
  return createMachineEffectBundle({
    instructionId,
    architectureId: 'synthetic-neutral-isa',
    mode: 'synthetic-mode',
    operations: [createMachineOperation({
      kind: 'memory-read',
      id: 'effect.read',
      access: {
        space: 'memory',
        addressExpr: { kind: 'bitvector', widthBits: 64, value },
        widthBits: 8,
        endian: 'little',
      },
      value: createBitVectorValue(8),
    })],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin,
    completeness: 'exact',
  });
}

function lower(value) {
  return lowerMachineEffectBundleToSemanticIr(makeBundle(value), {
    functionId: 'function',
    blockId: 'block',
    addressWidthBits: 64,
  });
}

function loads(ir) {
  return ir.nodes.filter((node) => node.kind === 'load');
}
function unknownMemoryEffects(ir) {
  return ir.nodes.filter((node) => node.kind === 'unknown-memory-effect');
}
function addressConstants(ir) {
  return ir.values.filter((value) => value.machineType?.kind === 'address' && value.metadata?.constant != null);
}

for (const value of ['7', 7]) {
  const ir = lower(value);
  assert.equal(loads(ir).length, 1, `canonical primitive integer ${String(value)} must remain lowerable`);
  assert.equal(unknownMemoryEffects(ir).length, 0);
  assert.equal(addressConstants(ir).length, 1);
  assert.equal(addressConstants(ir)[0].metadata.constant.value, '7');
  assert.equal(ir.completeness, 'complete');
}

for (const value of [['7'], true, ['0x7'], Number.MAX_SAFE_INTEGER + 1, '01', ' 7 ', '+7', '0x7']) {
  const ir = lower(value);
  assert.equal(loads(ir).length, 0, `non-canonical raw constant must not become exact address authority: ${String(value)}`);
  assert.equal(unknownMemoryEffects(ir).length, 1);
  assert.equal(unknownMemoryEffects(ir)[0].unknown.reason, 'bitvector-expression-not-concrete');
  assert.equal(addressConstants(ir).length, 0);
  assert.equal(ir.completeness, 'partial', 'rejecting malformed exact address input must not become complete-empty');
}

const zero = lower('0');
assert.equal(loads(zero).length, 1, 'canonical zero must remain lowerable');
assert.equal(addressConstants(zero)[0].metadata.constant.value, '0');

const outOfRange = lower('18446744073709551616');
assert.equal(loads(outOfRange).length, 0, 'existing width range check must remain fail-closed');
assert.equal(outOfRange.completeness, 'partial');

console.log('semantic-v2 issue #3614 raw address constant type boundary: PASS');

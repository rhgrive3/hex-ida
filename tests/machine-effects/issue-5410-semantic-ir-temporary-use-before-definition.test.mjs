import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/index.js';

/* MachineEffects does not validate temporary def-use order at its own schema
 * boundary, so a bundle may consume a temporary in an operation that precedes
 * the operation defining it. The Semantic IR lowering resolved every
 * temporary against an up-front definition prepass, which connected such a
 * use directly to a *future* definition in the same block and published the
 * result as a complete function (#5410). A temporary input may only resolve
 * to a definition from a strictly earlier operation; anything else must
 * degrade to the fail-closed unknown projection, and the canonical function
 * boundary must reject same-block use-before-definition outright. */

const INST = createInstructionId({
  binaryId: 'bin_5410', sliceId: 'slice_5410', virtualAddress: 0x2000n,
  decodeMode: 'a64', decoderSemanticVersion: '1',
});
const ORIGIN = {
  instructionIds: [INST],
  byteRanges: [{ binaryId: 'bin_5410', start: 0x40n, end: 0x44n }],
  virtualRanges: [{ imageId: 'image_5410', sliceId: 'slice_5410', start: 0x2000n, end: 0x2004n }],
};

const TEMP_T = () => createTemporaryValue('t_5410', createBitVectorValue(64));
const TEMP_U = () => createTemporaryValue('u_5410', createBitVectorValue(64));

function buildBundle(operations) {
  return createMachineEffectBundle({
    instructionId: INST,
    architectureId: 'arm64',
    mode: 'a64',
    operations,
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: ORIGIN,
    completeness: 'exact',
  });
}

const OP_ADD_USES_T = () => createMachineOperation({
  id: 'op_add',
  kind: 'value',
  opcode: 'add',
  inputs: [TEMP_T(), createBitVectorValue(64, '1')],
  outputs: [TEMP_U()],
});
const OP_COPY_DEFINES_T = () => createMachineOperation({
  id: 'op_copy',
  kind: 'value',
  opcode: 'copy',
  inputs: [createBitVectorValue(64, '2')],
  outputs: [TEMP_T()],
});

function blockNodeOrder(fn) {
  const entry = fn.blocks.find((block) => block.id === fn.entryBlockId) ?? fn.blocks[0];
  return entry.nodeIds.map((nodeId) => fn.nodes.find((node) => node.id === nodeId));
}

test('#5410: temporary use before its defining operation must not connect to the future definition', () => {
  const fn = lowerMachineEffectBundleToSemanticIr(
    buildBundle([OP_ADD_USES_T(), OP_COPY_DEFINES_T()]),
    { functionId: 'fn:5410:fwd', blockId: 'blk:0' },
  );
  assert.equal(fn.completeness, 'partial');
  assert.ok(fn.unknowns.some((unknown) => unknown.reason === 'temporary-value-has-no-defining-machine-effect'));

  const addNode = blockNodeOrder(fn).find((node) => node.kind === 'binary');
  assert.ok(addNode, 'add must lower to a binary node');
  const copyNode = blockNodeOrder(fn).find((node) => node.kind === 'copy');
  assert.ok(copyNode, 'copy must lower to a copy node');
  // The binary node's inputs must not include the copy node's output value.
  for (const inputId of addNode.inputs) {
    assert.notEqual(copyNode.outputs[0], inputId);
  }
  // The unresolved temporary must project as an unknown-value node placed
  // before the binary node, not as a forward reference to the copy.
  for (const inputId of addNode.inputs) {
    const value = fn.values.find((candidate) => candidate.id === inputId);
    assert.ok(value, 'input value must exist');
    const definitionNode = fn.nodes.find((node) => node.id === value.definitionNodeId);
    assert.ok(definitionNode, 'input value must have a definition node');
    const order = blockNodeOrder(fn).map((node) => node.id);
    assert.ok(order.indexOf(definitionNode.id) < order.indexOf(addNode.id));
  }
});

test('#5410: canonical boundary rejects directly constructed same-block use-before-definition', () => {
  const ordered = lowerMachineEffectBundleToSemanticIr(
    buildBundle([OP_COPY_DEFINES_T(), OP_ADD_USES_T()]),
    { functionId: 'fn:5410:pos', blockId: 'blk:0' },
  );
  assert.equal(ordered.completeness, 'complete');
  const entry = ordered.blocks.find((block) => block.id === ordered.entryBlockId);
  // Same canonical entities; only the block order is flipped so the binary
  // node consumes a value defined later in the same block.
  assert.throws(() => createSemanticIrFunction({
    functionId: 'fn:5410:bnd',
    entryBlockId: ordered.entryBlockId,
    blocks: [{ id: entry.id, nodeIds: [...entry.nodeIds].reverse(), origin: entry.origin }],
    values: ordered.values,
    nodes: ordered.nodes,
    completeness: ordered.completeness,
    unknowns: ordered.unknowns,
    origin: ordered.origin,
  }), /semantic-ir-value-use-before-definition-in-block/);
});

test('#5410: correctly ordered temporary def-use stays exact and connects to the real definition', () => {
  const fn = lowerMachineEffectBundleToSemanticIr(
    buildBundle([OP_COPY_DEFINES_T(), OP_ADD_USES_T()]),
    { functionId: 'fn:5410:ok', blockId: 'blk:0' },
  );
  assert.equal(fn.completeness, 'complete');
  assert.deepEqual(fn.unknowns, []);
  const addNode = blockNodeOrder(fn).find((node) => node.kind === 'binary');
  const copyNode = blockNodeOrder(fn).find((node) => node.kind === 'copy');
  assert.ok(addNode.inputs.includes(copyNode.outputs[0]));
});

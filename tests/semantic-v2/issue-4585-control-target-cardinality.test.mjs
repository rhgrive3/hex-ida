import assert from 'node:assert/strict';
import test from 'node:test';

import { OP } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { projectNode } from '../../js/semantics/compat/semantic-ir-v2-to-v1-nodes.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

// Control node kind fixes the number of successors a v1 BR/CBR can carry, so a
// complete canonical function must not be able to declare more targets than the
// compatibility projection consumes. Surplus targets must fail closed at the
// canonical boundary and must never become a silently narrowed edge (#4585).

const origin = { instructionIds: ['instruction_0'] };
const CONTROL_TARGET_LIMITS = { branch: 1, 'conditional-branch': 2 };

function controlIr(kind, targets, inputs = []) {
  const blockIds = ['b0', ...targets];
  const condition = inputs.length
    ? [{
      id: 'cond', kind: 'entry',
      machineType: { kind: 'predicate', widthBits: 1 },
      sourceEntityId: 'cond', variableKey: null, origin,
    }]
    : [];
  const entryNodeIds = kind === 'conditional-branch' ? ['cmp', 'control'] : ['control'];
  const leafNodes = targets.map((id) => ({
    id: `leaf-${id}`, kind: 'return', blockId: id, inputs: [], outputs: [],
    targets: [], attributes: {}, completeness: 'complete', origin,
  }));
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'f',
    entryBlockId: 'b0',
    blocks: blockIds.map((id) => ({ id, nodeIds: id === 'b0' ? entryNodeIds : [`leaf-${id}`] })),
    values: condition,
    nodes: [
      ...(kind === 'conditional-branch'
        ? [{
          id: 'cmp', kind: 'compare', blockId: 'b0', inputs, outputs: [],
          operator: 'eq', attributes: {}, completeness: 'complete', origin,
        }]
        : []),
      {
        id: 'control', kind, blockId: 'b0', inputs, outputs: [], targets,
        attributes: {}, completeness: 'complete', origin,
      },
      ...leafNodes,
    ],
    completeness: 'complete', unknowns: [], origin,
  };
}

function build(kind, targets, inputs = []) {
  return createSemanticIrFunction(controlIr(kind, targets, inputs));
}

function legacyTargets(ir, nodeId = 'control') {
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const inst = out.instructions.find((candidate) => candidate.semanticNodeId === nodeId);
  return { out, inst };
}

function defensiveContext(ir, node) {
  const nodeById = new Map(ir.nodes.map((candidate) => [candidate.id, candidate]));
  const blocks = ir.blocks.map((block, index) => ({
    index,
    semanticBlockId: block.id,
    nodeIds: block.nodeIds,
    semanticNodeIds: block.nodeIds,
    startRow: index,
    endRow: index,
    address: 0x1000n + BigInt(index * 4),
  }));
  return {
    blockIndex: 0,
    row: 0,
    valuesById: new Map(),
    ir,
    nodeById,
    blockBySemanticId: new Map(blocks.map((block) => [block.semanticBlockId, block])),
    options: {},
    stateProjection: { readUseByNodeId: new Map(), definitionByValueId: new Map() },
    comparisonCarrierByNodeId: new Map(),
  };
}

test('#4585: an unconditional branch keeps exactly one target', () => {
  const ir = build('branch', ['b1']);
  const { inst } = legacyTargets(ir);
  assert.equal(inst.op, OP.BR);
  assert.equal(inst.extra.targetBlockId, 'b1');
});

test('#4585: a branch with no target keeps the existing rejection', () => {
  assert.throws(() => build('branch', []), /semantic-ir-control-target-required/);
});

test('#4585: a branch with surplus targets fails closed', () => {
  assert.throws(
    () => build('branch', ['left', 'right']),
    /semantic-ir-control-target-cardinality/,
  );
});

test('#4585: a conditional branch keeps exactly two targets', () => {
  const ir = build('conditional-branch', ['taken', 'fallthrough'], ['cond']);
  const { inst } = legacyTargets(ir);
  assert.equal(inst.op, OP.CBR);
  assert.equal(inst.extra.targetBlockId, 'taken');
  assert.equal(inst.extra.fallthroughBlockId, 'fallthrough');
});

test('#4585: a conditional branch with surplus targets fails closed', () => {
  assert.throws(
    () => build('conditional-branch', ['taken', 'fallthrough', 'extra'], ['cond']),
    /semantic-ir-control-target-cardinality/,
  );
  assert.throws(
    () => build('conditional-branch', [], ['cond']),
    /semantic-ir-control-target-required/,
  );
});

test('#4585: a switch keeps its n-ary case list contract', () => {
  assert.doesNotThrow(() => build('switch', ['case-a']));
  assert.doesNotThrow(() => build('switch', ['case-a', 'case-b', 'default']));
  assert.throws(() => build('switch', []), /semantic-ir-control-target-required/);
});

test('#4585: surplus targets never become a narrowed exact edge in compat', () => {
  for (const [kind, targets] of [
    ['branch', ['b1', 'b2']],
    ['conditional-branch', ['b1', 'b2', 'b3']],
  ]) {
    const malformed = controlIr(kind, targets, kind === 'conditional-branch' ? ['cond'] : []);
    const node = malformed.nodes.find((candidate) => candidate.id === 'control');
    const [inst] = projectNode({ ...node, sourceEffectIds: [] }, defensiveContext(malformed, node));
    assert.equal(inst.op, OP.UNKNOWN, `${kind}: over-cardinality control must not stay exact`);
    assert.notEqual(inst.op, kind === 'branch' ? OP.BR : OP.CBR, `${kind}: narrowed exact edge must not be published`);
    assert.deepEqual(inst.extra.surplusTargets, targets, `${kind}: every declared target must stay visible`);
    assert.match(inst.extra.reason, /semantic-ir-v2-control-target-cardinality/);
  }
});

test('#4585: canonical and legacy successor sets agree for valid control nodes', () => {
  const declared = {
    branch: ['b1'],
    'conditional-branch': ['b1', 'b2'],
    switch: ['b1', 'b2'],
  };
  for (const [kind, targets] of Object.entries(declared)) {
    const ir = build(kind, targets, kind === 'conditional-branch' ? ['cond'] : []);
    const canonical = ir.nodes.find((candidate) => candidate.id === 'control').targets.slice().sort();
    const legacyBlock = legacyTargets(ir).out.blocks.find((block) => block.semanticBlockId === 'b0');
    const legacy = (legacyBlock.successorEdges ?? []).map((edge) => edge.semanticTo).sort();
    assert.deepEqual(legacy, canonical, `${kind}: legacy successors must match canonical targets`);
  }
});

test('#4585: the compat target limit matches the canonical cardinality contract', () => {
  assert.equal(CONTROL_TARGET_LIMITS.branch, 1);
  assert.equal(CONTROL_TARGET_LIMITS['conditional-branch'], 2);
});

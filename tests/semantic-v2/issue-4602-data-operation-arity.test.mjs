import assert from 'node:assert/strict';
import test from 'node:test';

import { OP } from '../../js/ir-core.js';
import { createSemanticNode, SEMANTIC_NODE_DATA_ARITY, SEMANTIC_INTRINSIC_OPERATOR_ARITY } from '../../js/semantics/ir/nodes.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { projectNode } from '../../js/semantics/compat/semantic-ir-v2-to-v1-nodes.js';

// Canonical data-operation nodes must carry exactly the operand count their
// kind/operator contract fixes. A malformed `complete` node (e.g. a 4-input
// select) used to pass canonical validation and the v2→v1 projection then
// silently dropped the surplus operand evidence via slice(1,3) (#4602).

const bit1 = { kind: 'predicate', widthBits: 1 };
const bit32 = { kind: 'bitvector', widthBits: 32 };

function origin(id) {
  return { instructionIds: [id] };
}
function entryValue(id, machineType = bit32) {
  return { id, kind: 'entry', machineType, sourceEntityId: 'fn', variableKey: null, origin: origin(`ins_${id}`) };
}
function defValue(id, definitionNodeId, machineType = bit32) {
  return { id, kind: 'definition', machineType, definitionNodeId, sourceEntityId: definitionNodeId, variableKey: null, origin: origin(`ins_${id}`) };
}
function semanticFunction(nodes, values) {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'fn',
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map((node) => node.id), origin: origin('block_b0') }],
    values,
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('function_fn'),
  };
}
function selectNode(inputs, outputs) {
  return {
    id: 'sel', kind: 'select', blockId: 'b0', inputs, outputs,
    operator: 'sel', completeness: 'complete', origin: origin('ins_sel'),
  };
}
function selectFunction({ inputs = ['cond', 'a', 'b', 'extra'], outputs = ['out'], completeness = 'complete', unknown = undefined } = {}) {
  const node = { ...selectNode(inputs, outputs), completeness };
  if (unknown !== undefined) node.unknown = unknown;
  return semanticFunction([node], [
    entryValue('cond', bit1), entryValue('a'), entryValue('b'), entryValue('extra'),
    ...(outputs.length ? [defValue(outputs[0], 'sel')] : []),
  ]);
}

test('#4602: a valid complete 3-input select stays accepted end to end', () => {
  const node = createSemanticNode(selectNode(['cond', 'a', 'b'], ['out']));
  assert.equal(node.kind, 'select');
  const ir = createSemanticIrFunction(selectFunction({
    inputs: ['cond', 'a', 'b'],
    outputs: ['out'],
  }));
  assert.equal(ir.completeness, 'complete');
});

test('#4602: a complete 4-input select is rejected at the canonical boundary', () => {
  assert.throws(
    () => createSemanticNode(selectNode(['cond', 'a', 'b', 'extra'], ['out'])),
    /semantic-ir-node-input-arity/,
  );
  assert.throws(
    () => createSemanticIrFunction(selectFunction()),
    /semantic-ir-node-input-arity/,
  );
});

test('#4602: a complete select with fewer than 3 inputs is rejected', () => {
  for (const inputs of [[], ['cond'], ['cond', 'a']]) {
    assert.throws(
      () => createSemanticNode({ ...selectNode(inputs, ['out']), completeness: 'complete' }),
      /semantic-ir-node-input-arity/,
    );
  }
});

test('#4602: an under-input select may stay observable only as an explicit partial', () => {
  const node = createSemanticNode({
    ...selectNode(['cond', 'a'], ['out']),
    completeness: 'partial',
    unknown: { reason: 'select-false-arm-unresolved', categories: ['value'] },
  });
  assert.equal(node.completeness, 'partial');
  // Surplus is not a weakening direction: even partial nodes must not hide it.
  assert.throws(
    () => createSemanticNode({
      ...selectNode(['cond', 'a', 'b', 'extra'], ['out']),
      completeness: 'partial',
      unknown: { reason: 'select-false-arm-unresolved', categories: ['value'] },
    }),
    /semantic-ir-node-input-arity/,
  );
});

test('#4602: unary 0/2, binary 1/3 and compare 3 inputs are rejected as complete', () => {
  assert.throws(() => createSemanticNode({
    id: 'u0', kind: 'unary', blockId: 'b0', inputs: [], outputs: ['y'], operator: 'not',
    completeness: 'complete', origin: origin('i'),
  }), /semantic-ir-node-input-arity/);
  assert.throws(() => createSemanticNode({
    id: 'u2', kind: 'unary', blockId: 'b0', inputs: ['x', 'x2'], outputs: ['y'], operator: 'not',
    completeness: 'complete', origin: origin('i'),
  }), /semantic-ir-node-input-arity/);
  assert.throws(() => createSemanticNode({
    id: 'b1', kind: 'binary', blockId: 'b0', inputs: ['x'], outputs: ['y'], operator: 'add',
    completeness: 'complete', origin: origin('i'),
  }), /semantic-ir-node-input-arity/);
  assert.throws(() => createSemanticNode({
    id: 'b3', kind: 'binary', blockId: 'b0', inputs: ['x', 'x2', 'x3'], outputs: ['y'], operator: 'add',
    completeness: 'complete', origin: origin('i'),
  }), /semantic-ir-node-input-arity/);
  assert.throws(() => createSemanticNode({
    id: 'c3', kind: 'compare', blockId: 'b0', inputs: ['x', 'x2', 'x3'], outputs: ['y'], operator: 'ult',
    completeness: 'complete', origin: origin('i'),
  }), /semantic-ir-node-input-arity/);
});

test('#4602: copy/bitcast with 2 inputs are rejected, exactly-1 input stays valid', () => {
  assert.throws(() => createSemanticNode({
    id: 'cp', kind: 'copy', blockId: 'b0', inputs: ['x', 'x2'], outputs: ['y'],
    completeness: 'complete', origin: origin('i'),
  }), /semantic-ir-node-input-arity/);
  assert.throws(() => createSemanticNode({
    id: 'bc', kind: 'bitcast', blockId: 'b0', inputs: ['x', 'x2'], outputs: ['y'],
    completeness: 'complete', origin: origin('i'),
  }), /semantic-ir-node-input-arity/);
  const ok = createSemanticNode({
    id: 'cp', kind: 'copy', blockId: 'b0', inputs: ['x'], outputs: ['y'],
    completeness: 'complete', origin: origin('i'),
  });
  assert.equal(ok.kind, 'copy');
});

test('#4602: kind-specific output cardinality is enforced by the same contract', () => {
  assert.throws(() => createSemanticNode({
    id: 'sel2', kind: 'select', blockId: 'b0', inputs: ['cond', 'a', 'b'], outputs: ['o1', 'o2'],
    completeness: 'complete', origin: origin('i'),
  }), /semantic-ir-node-output-arity/);
  assert.throws(() => createSemanticNode({
    id: 'ct', kind: 'const', blockId: 'b0', inputs: [], outputs: [],
    attributes: { value: 1 }, completeness: 'complete', origin: origin('i'),
  }), /semantic-ir-node-output-arity/);
  assert.throws(() => createSemanticNode({
    id: 'cp0', kind: 'copy', blockId: 'b0', inputs: ['x'], outputs: [],
    completeness: 'complete', origin: origin('i'),
  }), /semantic-ir-node-output-arity/);
});

test('#4602: fixed-arity intrinsics fail closed, real add-with-carry output shapes stay valid', () => {
  const awcBase = {
    id: 'awc', kind: 'intrinsic', blockId: 'b0', operator: 'add-with-carry',
    completeness: 'complete', origin: origin('i'),
  };
  assert.throws(() => createSemanticNode({
    ...awcBase,
    inputs: ['x', 'y', 'c', 'extra'], outputs: ['r'],
    intrinsic: {
      inputs: ['x', 'y', 'c', 'extra'], outputs: ['r'], stateReads: [], stateWrites: [],
      memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' },
      controlEffects: [], determinism: 'deterministic', symbolicDetail: 'summary-only',
    },
  }), /semantic-ir-node-input-arity/);
  // The repair-region production shape carries result + carry-out + overflow.
  const valid = createSemanticNode({
    ...awcBase,
    inputs: ['x', 'y', 'c'], outputs: ['r', 'c2', 'v'],
    intrinsic: {
      inputs: ['x', 'y', 'c'], outputs: ['r', 'c2', 'v'], stateReads: [], stateWrites: [],
      memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' },
      controlEffects: [], determinism: 'deterministic', symbolicDetail: 'summary-only',
    },
  });
  assert.equal(valid.kind, 'intrinsic');
});

test('#4602: the schema table pins input and output cardinality per kind', () => {
  const expected = {
    const: { inputs: [0, 0], outputs: [1, 1] },
    copy: { inputs: [1, 1], outputs: [1, 1] },
    unary: { inputs: [1, 1], outputs: [1, 1] },
    binary: { inputs: [2, 2], outputs: [1, 1] },
    compare: { inputs: [2, 2], outputs: [1, 1] },
    select: { inputs: [3, 3], outputs: [1, 1] },
    zext: { inputs: [1, 1], outputs: [1, 1] },
    sext: { inputs: [1, 1], outputs: [1, 1] },
    trunc: { inputs: [1, 1], outputs: [1, 1] },
    bitcast: { inputs: [1, 1], outputs: [1, 1] },
    extract: { inputs: [1, 1], outputs: [1, 1] },
    insert: { inputs: [2, 2], outputs: [1, 1] },
    concat: { inputs: [2, null], outputs: [1, 1] },
  };
  const actual = Object.fromEntries(Object.entries(SEMANTIC_NODE_DATA_ARITY)
    .map(([kind, entry]) => [kind, {
      inputs: [entry.inputs[0], Number.isFinite(entry.inputs[1]) ? entry.inputs[1] : null],
      outputs: [entry.outputs[0], Number.isFinite(entry.outputs[1]) ? entry.outputs[1] : null],
    }]));
  assert.deepEqual(actual, expected);
  assert.deepEqual(
    [...Object.keys(SEMANTIC_INTRINSIC_OPERATOR_ARITY)],
    ['add-with-carry'],
  );
});

test('#4602: the canonical path also refuses to build the full 4-input select function end to end', () => {
  assert.throws(
    () => projectSemanticIrV2ToLegacyV1(selectFunction()),
    /semantic-ir-node-input-arity/,
  );
});

test('#4602: a surplus-input select that reaches compat directly never becomes a silent exact SEL', () => {
  const legacyValue = (id, bits) => ({
    id, semanticValueId: id, bits, uses: [], def: null,
    machineType: { kind: id === 'cond' ? 'predicate' : 'bitvector', widthBits: bits },
  });
  const valuesById = new Map([
    ['cond', legacyValue('cond', 1)],
    ['a', legacyValue('a', 32)],
    ['b', legacyValue('b', 32)],
    ['extra', legacyValue('extra', 32)],
    ['out', legacyValue('out', 32)],
  ]);
  const node = { ...selectNode(['cond', 'a', 'b', 'extra'], ['out']), sourceEffectIds: [] };
  const context = {
    blockIndex: 0,
    row: 0,
    valuesById,
    ir: { nodes: [node] },
    nodeById: new Map([['sel', node]]),
    producerByValueId: new Map(),
    blockBySemanticId: new Map([['b0', { index: 0 }]]),
    options: {},
    stateProjection: {
      readUseByNodeId: new Map(),
      writeDefinitionByNodeId: new Map(),
      definitionByValueId: new Map(),
    },
    comparisonCarrierByNodeId: new Map(),
  };
  const projected = projectNode(node, context);
  const inst = projected.find((candidate) => candidate.semanticNodeId === 'sel');
  assert.notEqual(inst.op, OP.SEL, 'a 4-input select must not project as an exact SEL that drops the extra operand');
  assert.equal(inst.op, OP.UNKNOWN);
  assert.equal(inst.extra.reason, 'semantic-ir-v2-input-arity-not-representable-in-v1');
  assert.equal(inst.args.length, 4, 'all four input operands must remain visible in the legacy evidence');
});

test('#4602: a surplus-input add-with-carry intrinsic cannot project as the exact v1 add', () => {
  const legacyValue = (id, bits) => ({
    id, semanticValueId: id, bits, uses: [], def: null,
    machineType: { kind: 'bitvector', widthBits: bits },
  });
  const carryConst = {
    id: 'carry_node', kind: 'const', blockId: 'b0', inputs: [], outputs: ['c'],
    attributes: { value: 0 }, origin: origin('i'),
  };
  const valuesById = new Map([
    ['x', legacyValue('x', 64)],
    ['y', legacyValue('y', 64)],
    ['c', legacyValue('c', 1)],
    ['extra', legacyValue('extra', 64)],
    ['r', legacyValue('r', 64)],
  ]);
  const node = {
    id: 'awc', kind: 'intrinsic', blockId: 'b0', operator: 'add-with-carry',
    inputs: ['x', 'y', 'c', 'extra'], outputs: ['r'],
    intrinsic: {
      inputs: ['x', 'y', 'c', 'extra'], outputs: ['r'], stateReads: [], stateWrites: [],
      memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' },
      controlEffects: [], determinism: 'deterministic', symbolicDetail: 'summary-only',
    },
    attributes: {}, completeness: 'complete', origin: origin('i'), sourceEffectIds: [],
  };
  const context = {
    blockIndex: 0,
    row: 0,
    valuesById,
    ir: { nodes: [node] },
    nodeById: new Map([['awc', node]]),
    producerByValueId: new Map([['c', carryConst]]),
    blockBySemanticId: new Map([['b0', { index: 0 }]]),
    options: {},
    stateProjection: {
      readUseByNodeId: new Map(),
      writeDefinitionByNodeId: new Map(),
      definitionByValueId: new Map(),
    },
    comparisonCarrierByNodeId: new Map(),
  };
  const projected = projectNode(node, context);
  const inst = projected.find((candidate) => candidate.semanticNodeId === 'awc');
  assert.notEqual(inst.extra?.compatSource, 'exact-add-with-carry-intrinsic',
    'a 4-input add-with-carry must not project as the exact canonical add');
  assert.equal(inst.op, OP.UNKNOWN);
  assert.equal(inst.extra.reason, 'semantic-ir-v2-input-arity-not-representable-in-v1');
  assert.equal(inst.args.length, 4);
});

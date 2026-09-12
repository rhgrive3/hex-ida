import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticNode } from '../js/semantics/ir/nodes.js';
import { createSemanticIrFunction } from '../js/semantics/ir/function.js';
import { projectSemanticIrV2ToLegacyV1 } from '../js/semantics/compat/index.js';
import { finalizeLegacyProjection } from '../js/semantics/compat/semantic-ir-v2-to-v1-finalize.js';
import { V1_OP } from '../js/semantics/compat/semantic-ir-v2-to-v1-core.js';

// #4658: createSemanticNode()/validateNormalizedFunction() accepted binary
// nodes with 3+ inputs, while compat foldInstruction() collapsed BIN folding
// to the first two args (args.length >= 2) and published an exact constant
// that silently ignored the extra operands.

const origin = { instructionIds: ['i0'] };

function nodeInput(kind, inputs) {
  const node = { id: 'n1', kind, blockId: 'b0', inputs, completeness: 'complete', origin };
  if (kind === 'state-read' || kind === 'state-write') {
    node.variable = { key: 'state:x0', kind: 'physical-state', scope: 'function' };
  }
  return node;
}

const ARITY_CASES = [
  ['binary', ['a', 'b'], [['a'], ['a', 'b', 'c']]],
  ['unary', ['a'], [[], ['a', 'b']]],
  ['compare', ['a', 'b'], [['a'], ['a', 'b', 'c']]],
  ['copy', ['a'], [[], ['a', 'b']]],
  ['select', ['a', 'b', 'c'], [['a', 'b'], ['a', 'b', 'c', 'd']]],
  ['const', [], [['a']]],
  ['zext', ['a'], [[], ['a', 'b']]],
  ['sext', ['a'], [[], ['a', 'b']]],
  ['trunc', ['a'], [[], ['a', 'b']]],
  ['bitcast', ['a'], [[], ['a', 'b']]],
  ['state-read', [], [['a']]],
  ['state-write', ['a'], [[], ['a', 'b']]],
];

test('#4658 canonical constructor accepts the contracted input arity for every pinned kind', () => {
  for (const [kind, validInputs] of ARITY_CASES) {
    assert.doesNotThrow(
      () => createSemanticNode(nodeInput(kind, validInputs)),
      `${kind} with ${validInputs.length} inputs must stay valid`,
    );
  }
});

test('#4658 canonical constructor rejects wrong input arity for every pinned kind', () => {
  for (const [kind, validInputs, invalidInputsList] of ARITY_CASES) {
    for (const invalidInputs of invalidInputsList) {
      assert.throws(
        () => createSemanticNode(nodeInput(kind, invalidInputs)),
        /semantic-ir-node-arity-invalid/,
        `${kind} with ${invalidInputs.length} inputs must be rejected`,
      );
    }
  }
});

function functionWith(nodes) {
  const values = [];
  for (const node of nodes) {
    for (const id of node.inputs ?? []) {
      if (!values.some((value) => value.id === id)) {
        values.push({ id, kind: 'entry', machineType: { kind: 'bitvector', widthBits: 64 }, origin });
      }
    }
    for (const id of node.outputs ?? []) {
      values.push({ id, kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: node.id, origin });
    }
  }
  return {
    functionId: 'f', entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map((node) => node.id), origin }],
    values, nodes,
    completeness: 'complete', unknowns: [], origin,
  };
}

function addNodes(inputs) {
  return [{ id: 'n_add', kind: 'binary', operator: 'add', blockId: 'b0', inputs, outputs: ['r'], completeness: 'complete', origin }];
}

test('#4658 function validation rejects a 3-input binary node', () => {
  assert.throws(
    () => createSemanticIrFunction(functionWith(addNodes(['a', 'b', 'c']))),
    /semantic-ir-node-arity-invalid/,
  );
});

test('#4658 function validation rejects a 1-input binary node', () => {
  assert.throws(
    () => createSemanticIrFunction(functionWith(addNodes(['a']))),
    /semantic-ir-node-arity-invalid/,
  );
});

test('#4658 function validation keeps a 2-input binary node valid', () => {
  assert.doesNotThrow(() => createSemanticIrFunction(functionWith(addNodes(['a', 'b']))));
});

function constValue(id, value) {
  return { id, kind: 'const', reg: null, const: value, bits: 64, uses: [] };
}

function defValue(id) {
  return { id, kind: 'def', reg: null, const: null, bits: 64, uses: [], def: null };
}

function binInstruction(id, args, dst) {
  return {
    id, block: 0, row: id, op: V1_OP.BIN, sub: 'add', bits: 64, dst,
    args: args.map((value) => ({ value, bits: 64 })),
  };
}

test('#4658 compat BIN folding publishes no exact constant for arity-mismatched args', () => {
  const a = constValue(1, 1n);
  const b = constValue(2, 2n);
  const c = constValue(3, 100n);
  const dst = defValue(4);
  const projected = { instructions: [binInstruction(0, [a, b, c], dst)], values: [a, b, c, dst] };
  finalizeLegacyProjection(projected);
  assert.equal(dst.const, null, '3-arg BIN must not fold to an exact constant that ignores the third operand');
});

test('#4658 compat BIN folding still folds exactly 2 args', () => {
  const a = constValue(1, 1n);
  const b = constValue(2, 2n);
  const dst = defValue(3);
  const projected = { instructions: [binInstruction(0, [a, b], dst)], values: [a, b, dst] };
  finalizeLegacyProjection(projected);
  assert.equal(dst.const, 3n);
});

test('#4658 canonical 3-input binary never reaches compat folding', () => {
  assert.throws(
    () => projectSemanticIrV2ToLegacyV1(functionWith(addNodes(['a', 'b', 'c']))),
    /semantic-ir-node-arity-invalid/,
  );
});

test('#4658 valid MachineEffects-shaped IR still projects and folds end to end', () => {
  const nodes = [
    { id: 'n_a', kind: 'const', blockId: 'b0', inputs: [], outputs: ['a'], attributes: { value: '1' }, completeness: 'complete', origin },
    { id: 'n_b', kind: 'const', blockId: 'b0', inputs: [], outputs: ['b'], attributes: { value: '2' }, completeness: 'complete', origin },
    { id: 'n_add', kind: 'binary', operator: 'add', blockId: 'b0', inputs: ['a', 'b'], outputs: ['r'], completeness: 'complete', origin },
  ];
  const values = [
    { id: 'a', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: 'n_a', origin },
    { id: 'b', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: 'n_b', origin },
    { id: 'r', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: 'n_add', origin },
  ];
  const projected = projectSemanticIrV2ToLegacyV1({
    functionId: 'f', entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map((node) => node.id), origin }],
    values, nodes,
    completeness: 'complete', unknowns: [], origin,
  });
  const fn = projected.functions?.[0] ?? projected;
  const add = (fn.instructions ?? []).find((instruction) => instruction.op === V1_OP.BIN && instruction.sub === 'add');
  assert.ok(add, 'binary add instruction must survive the projection');
  assert.equal(add.dst?.const, 3n);
});

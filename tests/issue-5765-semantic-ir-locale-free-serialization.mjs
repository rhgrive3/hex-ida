import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticIrFunction, canonicalSerializeSemanticIr } from '../js/semantics/ir/function.js';

const origin = { instructionIds: ['i0'] };
const mk = (id, blockId) => ({
  id, kind: 'const', blockId, inputs: [], outputs: [`out_${id}`],
  attributes: { value: '1' }, completeness: 'complete', origin,
});
const val = (id, nodeId) => ({
  id, kind: 'definition', machineType: { kind: 'bitvector', widthBits: 8 }, definitionNodeId: nodeId, origin,
});

function irFixture() {
  return {
    functionId: 'f',
    entryBlockId: 'b_entry',
    blocks: [
      { id: 'b_entry', nodeIds: ['n_e'], origin },
      { id: 'ä', nodeIds: ['n_ä'], origin },
      { id: 'z', nodeIds: ['n_z'], origin },
    ],
    values: [val('out_n_e', 'n_e'), val('out_n_ä', 'n_ä'), val('out_n_z', 'n_z')],
    nodes: [mk('n_e', 'b_entry'), mk('n_ä', 'ä'), mk('n_z', 'z')],
    completeness: 'complete',
    unknowns: [],
    origin,
  };
}

test('#5765 canonical ordering is UTF-16 code-unit order, not host ICU order', () => {
  // 'ä' (U+00E4) sorts after 'z' (U+007A) in code-unit order regardless of
  // locale (de_DE ICU collation ranks 'ä' before 'z').
  const f = createSemanticIrFunction(irFixture());
  assert.deepEqual(f.blocks.map((b) => b.id), ['b_entry', 'z', 'ä']);
  assert.deepEqual(f.nodes.map((n) => n.id), ['n_e', 'n_z', 'n_ä']);
});

test('#5765 the serialized canonical form is insertion/locale independent', () => {
  const f1 = createSemanticIrFunction(irFixture());
  const swapped = irFixture();
  swapped.blocks = [swapped.blocks[2], swapped.blocks[1], swapped.blocks[0]];
  swapped.nodes = [swapped.nodes[2], swapped.nodes[1], swapped.nodes[0]];
  const f2 = createSemanticIrFunction(swapped);
  assert.equal(canonicalSerializeSemanticIr(f1), canonicalSerializeSemanticIr(f2));
});

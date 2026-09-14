// Regression for #4580: the v2→v1 compat boundary must not String-coerce a
// structured compare predicate into a concrete comparison token / select cond.
import assert from 'node:assert/strict';
import { projectSemanticIrV2ToLegacyV1 } from '../js/semantics/compat/semantic-ir-v2-to-v1.js';

const bit1 = { kind: 'predicate', widthBits: 1 };
const bit32 = { kind: 'bitvector', widthBits: 32 };

function origin(id, address) {
  return { instructionIds: [id], virtualRanges: [{ start: address, end: address + 4n }] };
}
function entryValue(id, machineType, at) {
  return { id, kind: 'entry', machineType, sourceEntityId: 'fn', variableKey: null, origin: origin(`ins_${id}`, at) };
}
function defValue(id, definitionNodeId, machineType, at) {
  return { id, kind: 'definition', machineType, definitionNodeId, sourceEntityId: definitionNodeId, variableKey: null, origin: origin(`ins_${id}`, at) };
}

function project(compareAttributes) {
  const a = entryValue('a', bit32, 0x1000n);
  const b = entryValue('b', bit32, 0x1004n);
  const cmp = defValue('cmp', 'n_cmp', bit1, 0x1100n);
  const out = defValue('out', 'n_sel', bit32, 0x1200n);
  const nodes = [
    {
      id: 'n_cmp', kind: 'compare', blockId: 'b0', inputs: ['a', 'b'], outputs: ['cmp'],
      operator: '>', attributes: compareAttributes, origin: origin('ins_cmp', 0x1100n),
    },
    {
      id: 'n_sel', kind: 'select', blockId: 'b0', inputs: ['cmp', 'a', 'b'], outputs: ['out'],
      operator: 'sel', origin: origin('ins_sel', 0x1200n),
    },
    {
      id: 'n_ret', kind: 'return', blockId: 'b0', inputs: ['out'], outputs: [],
      origin: origin('ins_ret', 0x1204n),
    },
  ];
  const ir = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'fn',
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map((node) => node.id), origin: origin('block_b0', 0x1000n) }],
    values: [a, b, cmp, out],
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('function_fn', 0x1000n),
  };
  const projected = projectSemanticIrV2ToLegacyV1(ir);
  return {
    comparison: projected.instructions.find((inst) => inst.semanticNodeId === 'n_cmp')?.extra?.comparison,
    cond: projected.instructions.find((inst) => inst.semanticNodeId === 'n_sel')?.cond ?? null,
  };
}

// 1. Primitive string predicate keeps its concrete projection.
assert.deepEqual(project({ predicate: 'ult' }), { comparison: 'ult', cond: 'lo' });

// 2. A structured (array) predicate must not be coerced into a concrete token.
{
  const { comparison, cond } = project({ predicate: ['ult'] });
  assert.notEqual(comparison, 'ult', 'array predicate must not promote to a concrete comparison token');
  assert.notEqual(cond, 'lo', 'array predicate must not promote to select cond "lo"');
  assert.equal(cond, null, 'malformed predicate must fail closed to no condition');
}

// 3. A plain object predicate must not mint predicate semantics either.
{
  const { comparison, cond } = project({ predicate: { value: 'ult' } });
  assert.notEqual(comparison, 'ult');
  assert.equal(cond, null);
}

// 4. Primitive signed predicates keep their existing mappings.
assert.deepEqual(project({ predicate: 'slt' }), { comparison: 'slt', cond: 'lt' });
assert.deepEqual(project({ predicate: 'uge' }), { comparison: 'uge', cond: 'hs' });

console.log('issue #4580 semantic v2->v1 compare predicate coercion regressions PASS');

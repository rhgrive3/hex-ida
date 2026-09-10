// Issue #5633 regression: A2 local points-to must read compile-time constants
// exactly like the canonical address derivation — only from `const` nodes.
// canonical-address-v2-core derives constants exclusively under
// node.kind === 'const', so adopting integer-looking metadata on a non-const
// operand let A2 mint an exact displacement the canonical authority rejects.
import assert from 'node:assert/strict';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../js/semantics/ssa/build.js';
import { analyzeLocalPointsTo } from '../../js/analysis/pointsto/local.js';

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

function buildIr(dispValueExtras, { addInputs } = {}) {
  const ir = createSemanticIrFunction({
    functionId: 'f',
    entryBlockId: 'b',
    origin: origin('f'),
    blocks: [{ id: 'b', nodeIds: ['dyn', 'dyn2', 'cst', 'add'], origin: origin('b') }],
    values: [
      { id: 'base', kind: 'definition', definitionNodeId: 'dyn', machineType: { kind: 'bitvector', widthBits: 64 }, variableKey: 'base', origin: origin('base') },
      { id: 'disp', kind: 'definition', definitionNodeId: 'dyn2', machineType: { kind: 'bitvector', widthBits: 64 }, variableKey: 'disp', origin: origin('disp'), ...dispValueExtras },
      { id: 'const', kind: 'definition', definitionNodeId: 'cst', machineType: { kind: 'bitvector', widthBits: 64 }, variableKey: 'cst', origin: origin('cst') },
      { id: 'ptr', kind: 'definition', definitionNodeId: 'add', machineType: { kind: 'bitvector', widthBits: 64 }, origin: origin('ptr') },
    ],
    nodes: [
      { id: 'dyn', kind: 'state-read', blockId: 'b', inputs: [], outputs: ['base'], variable: { key: 'state:x0', kind: 'physical-state', scope: 'function' }, origin: origin('dyn') },
      { id: 'dyn2', kind: 'state-read', blockId: 'b', inputs: [], outputs: ['disp'], variable: { key: 'state:x1', kind: 'physical-state', scope: 'function' }, origin: origin('dyn2') },
      { id: 'add', kind: 'binary', operator: 'add', blockId: 'b', inputs: addInputs ?? ['base', 'disp'], outputs: ['ptr'], origin: origin('add') },
      { id: 'cst', kind: 'const', blockId: 'b', inputs: [], outputs: ['const'], attributes: { constant: 16 }, origin: origin('cst') },
    ],
  });
  const cfg = createSemanticCfg({ functionId: 'f', entryBlockId: 'b', blocks: [{ id: 'b', successors: [] }] });
  const ssa = buildSemanticSsa(ir, cfg);
  return { ir, cfg, ssa };
}

function pointerOffsets(ir, cfg, ssa) {
  const res = analyzeLocalPointsTo(ir, cfg, ssa, { snapshotId: 's' });
  return res.pointsTo.get('ptr')?.targets?.[0]?.offsetRange ?? null;
}

// The defect: a non-const (state-read) operand whose value metadata carries an
// integer-looking constant must NOT mint an exact displacement.
{
  const { ir, cfg, ssa } = buildIr({ metadata: { constant: { kind: 'bitvector', widthBits: 64, value: '16' } } });
  const range = pointerOffsets(ir, cfg, ssa);
  assert.ok(range, 'the pointer must still resolve to its root');
  assert.equal(range.exact, false, 'a non-const operand constant must not mint an exact offset');
  assert.equal(range.min, null, 'the displacement is unbounded without a proven constant');
  assert.equal(range.max, null);
}

// Control: a genuine const-node operand keeps the exact-displacement path.
{
  const { ir, cfg, ssa } = buildIr({}, { addInputs: ['base', 'const'] });
  const range = pointerOffsets(ir, cfg, ssa);
  assert.ok(range, 'the const-pointer must resolve');
  assert.equal(range.exact, true, 'a const-node operand keeps the exact displacement');
  assert.equal(String(range.min), '16');
  assert.equal(String(range.max), '16');
}

console.log('Issue #5633 A2 const-node constant gate regressions PASS');

import assert from 'node:assert/strict';
import {
  analyzeSemanticDominance,
  createSemanticCfg,
  deterministicTraversal,
  reachableBlocks,
} from '../../js/semantics/cfg/index.js';
import { buildSemanticSsa } from '../../js/semantics/ssa/build.js';

// #4551: analyzeSemanticDominance built an independent workCounter for each
// internal pass (its own loop, reachableBlocks(), reversePostOrder()), so a
// top-level `budget.maxWorkItems:N` acted as a per-subpass ceiling instead of
// the total work bound of one dominance analysis. The shared counter must
// aggregate every internal tick; standalone helpers keep their own budgets.

const edge = (to, kind = 'branch') => ({ to, kind });
const graph = (blocks, entryBlockId = blocks[0].id) => createSemanticCfg({
  functionId: 'issue_4551_cfg',
  entryBlockId,
  blocks,
});

{
  const cfg = graph([{ id: 'b0', successors: [] }]);
  assert.throws(
    () => analyzeSemanticDominance(cfg, { budget: { maxWorkItems: 2 } }),
    /^TypeError: semantic-cfg-budget-exceeded-maxWorkItems$/,
    'aggregate work of the 1-block analysis must not fit inside maxWorkItems=2',
  );
  assert.throws(
    () => analyzeSemanticDominance(cfg, { budget: { maxWorkItems: 3 } }),
    /semantic-cfg-budget-exceeded-maxWorkItems/,
    'the minimal tick count is 4; a budget of 3 must also fail',
  );
  const bounded = analyzeSemanticDominance(cfg, { budget: { maxWorkItems: 4 } });
  const unbounded = analyzeSemanticDominance(cfg);
  assert.deepEqual(bounded, unbounded, 'a sufficient aggregate budget must reproduce the exact dominance result');
  assert.deepEqual(unbounded.dominators.b0, ['b0']);
}

{
  const cfg = graph([
    { id: 'entry', successors: [edge('a')] },
    { id: 'a', successors: [edge('exit')] },
    { id: 'exit', successors: [] },
  ]);
  assert.throws(
    () => analyzeSemanticDominance(cfg, { budget: { maxWorkItems: 5 } }),
    /semantic-cfg-budget-exceeded-maxWorkItems/,
    'a 3-block chain needs more aggregate work than 5 items',
  );
  const full = analyzeSemanticDominance(cfg);
  assert.deepEqual(
    analyzeSemanticDominance(cfg, { budget: { maxWorkItems: 4194304 } }),
    full,
    'aggregate accounting must not change results once the ceiling is sufficient',
  );
}

{
  const cfg = graph([{ id: 'b0', successors: [] }]);
  assert.deepEqual(reachableBlocks(cfg, 'b0', { budget: { maxWorkItems: 1 } }), ['b0'],
    'standalone reachableBlocks keeps its own single-pass budget semantics');
  assert.deepEqual(reachableBlocks(cfg, 'b0', { budget: { maxWorkItems: 1 } }),
    reachableBlocks(cfg), 'standalone budget must not change results');
  const chain = graph([
    { id: 'a', successors: [edge('b')] },
    { id: 'b', successors: [] },
  ]);
  assert.throws(() => reachableBlocks(chain, 'a', { budget: { maxWorkItems: 1 } }),
    /semantic-cfg-budget-exceeded-maxWorkItems/,
    'standalone reachableBlocks still bounds its own traversal');
  assert.deepEqual(deterministicTraversal(chain, { budget: { maxWorkItems: 3 } }), ['a', 'b'],
    'standalone deterministicTraversal keeps its own single-pass budget semantics');
  assert.throws(() => deterministicTraversal(chain, { budget: { maxWorkItems: 2 } }),
    /semantic-cfg-budget-exceeded-maxWorkItems/,
    'standalone deterministicTraversal still bounds its own traversal');
}

{
  // Semantic SSA build forwards the caller-declared work ceiling to the
  // dominance pass; that ceiling must bind the aggregate dominance work, not
  // one subpass at a time. Fixture shape follows compat-v1-ssa-integration.
  const origin = (id, address) => ({
    instructionIds: [`instruction_${id}`],
    virtualRanges: [{ imageId: 'image_issue_4551', start: address, end: address + 4n }],
  });
  const bit1 = { kind: 'predicate', widthBits: 1 };
  const bit32 = { kind: 'bitvector', widthBits: 32 };
  const functionId = 'issue_4551_ssa';
  const stateX = { key: 'state:x', kind: 'logical-state', scope: 'function' };
  const values = [
    { id: 'cond', kind: 'entry', machineType: bit1, sourceEntityId: functionId, origin: origin('cond', 0x1000n) },
    { id: 'left_value', kind: 'entry', machineType: bit32, sourceEntityId: functionId, origin: origin('left_value', 0x1004n) },
    { id: 'right_value', kind: 'entry', machineType: bit32, sourceEntityId: functionId, origin: origin('right_value', 0x1008n) },
    { id: 'merged_read', kind: 'definition', machineType: bit32, definitionNodeId: 'merge_read', sourceEntityId: 'merge_read', origin: origin('merged_read', 0x1030n) },
  ];
  const blocks = [
    { id: 'entry', nodeIds: ['entry_branch'], origin: origin('entry', 0x1000n) },
    { id: 'left', nodeIds: ['left_write', 'left_branch'], origin: origin('left', 0x1010n) },
    { id: 'right', nodeIds: ['right_write', 'right_branch'], origin: origin('right', 0x1020n) },
    { id: 'merge', nodeIds: ['merge_read', 'merge_return'], origin: origin('merge', 0x1030n) },
  ];
  const nodes = [
    { id: 'entry_branch', kind: 'conditional-branch', blockId: 'entry', inputs: ['cond'], outputs: [], targets: ['left', 'right'], origin: origin('entry_branch', 0x1000n) },
    { id: 'left_write', kind: 'state-write', blockId: 'left', inputs: ['left_value'], outputs: [], variable: stateX, origin: origin('left_write', 0x1010n) },
    { id: 'left_branch', kind: 'branch', blockId: 'left', inputs: [], outputs: [], targets: ['merge'], origin: origin('left_branch', 0x1014n) },
    { id: 'right_write', kind: 'state-write', blockId: 'right', inputs: ['right_value'], outputs: [], variable: stateX, origin: origin('right_write', 0x1020n) },
    { id: 'right_branch', kind: 'branch', blockId: 'right', inputs: [], outputs: [], targets: ['merge'], origin: origin('right_branch', 0x1024n) },
    { id: 'merge_read', kind: 'state-read', blockId: 'merge', inputs: [], outputs: ['merged_read'], variable: stateX, origin: origin('merge_read', 0x1030n) },
    { id: 'merge_return', kind: 'return', blockId: 'merge', inputs: ['merged_read'], outputs: [], origin: origin('merge_return', 0x1034n) },
  ];
  const ir = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId,
    entryBlockId: 'entry',
    blocks,
    values,
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('function', 0x1000n),
  };
  const ssaCfg = createSemanticCfg({
    functionId,
    entryBlockId: 'entry',
    blocks: [
      { id: 'entry', successors: [{ to: 'left', kind: 'conditional-true' }, { to: 'right', kind: 'conditional-false' }] },
      { id: 'left', successors: [{ to: 'merge', kind: 'branch' }] },
      { id: 'right', successors: [{ to: 'merge', kind: 'branch' }] },
      { id: 'merge', successors: [] },
    ],
  });
  buildSemanticSsa(ir, ssaCfg, { budget: { maxWorkItems: 4096 } });
  assert.throws(
    () => buildSemanticSsa(ir, ssaCfg, { budget: { maxWorkItems: 20 } }),
    /semantic-cfg-budget-exceeded-maxWorkItems/,
    'the SSA-forwarded top-level ceiling must bind aggregate dominance work',
  );
}

console.log('semantic-v2 issue-4551 CFG shared aggregate work budget: PASS');

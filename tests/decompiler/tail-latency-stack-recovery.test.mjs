import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { expr } from '../../js/decompiler/ast/nodes.js';
import { recoverExactStackReturn } from '../../js/decompiler/passes/stack-return-recovery.js';
import { recoverExactStackPhiExpressions } from '../../js/decompiler/passes/stack-phi-recovery.js';

/**
 * Builds a synthetic ARM64 diamond-chain IR with `diamonds` sequential
 * two-arm diamonds (total blocks = 3 * diamonds + 2):
 *   block 0 (entry) -> [left_0, right_0] -> merge_0 -> ... -> merge_{d-1} -> ret (last block)
 *
 * `storeAtBlock` controls which block writes `valA` into `stack:-8:s8`.
 * When `splitFinalDiamond` is true, the last diamond writes `valA` on its
 * true arm and `valB` on its false arm to exercise `controller()` / `controllerForMerge()`.
 */
function buildDiamondChainFixture({
  diamonds = 40,
  storeAtBlock = 0,
  splitFinalDiamond = false,
  withBackEdgeAtMerge = -1,
} = {}) {
  const totalBlocks = 3 * diamonds + 2; // 40 diamonds -> 122 blocks
  const retBlockIndex = totalBlocks - 1;
  const stackKey = 'stack:-8:s8';
  const stackLoc = { kind: 'stack', key: stackKey, disp: -8, size: 8 };

  const valA = { id: 1, reg: 'x0', bits: 64, kind: 'arg' };
  const valB = { id: 2, reg: 'x1', bits: 64, kind: 'arg' };
  const valCond = { id: 3, reg: 'x2', bits: 64, kind: 'arg' };

  const blocks = [];
  const instructions = [];
  const rowToAddress = new Map();
  const addressToRow = new Map();
  let nextId = 10;
  let nextRow = 0;

  const allocInst = (blockIndex, fields) => {
    const row = nextRow++;
    const address = 0x10000n + BigInt(row * 4);
    rowToAddress.set(row, address);
    addressToRow.set(address, row);
    const inst = { id: nextId++, block: blockIndex, row, address, ...fields };
    instructions.push(inst);
    return inst;
  };

  for (let i = 0; i < totalBlocks; i++) {
    blocks.push({ index: i, pred: [], succ: [], insts: [], startRow: 0, endRow: 0, idom: i === 0 ? -1 : 0 });
  }

  const idom = new Array(totalBlocks).fill(-1);
  const dominators = Array.from({ length: totalBlocks }, () => new Set());
  dominators[0].add(0);

  // Wire edges and dominators:
  // entry = 0
  // diamond d (0..diamonds-1):
  //   split = d === 0 ? 0 : 3 * d
  //   left  = 3 * d + 1
  //   right = 3 * d + 2
  //   merge = 3 * d + 3
  // ret = 3 * diamonds + 1 = totalBlocks - 1
  for (let d = 0; d < diamonds; d++) {
    const split = d === 0 ? 0 : 3 * d;
    const left = 3 * d + 1;
    const right = 3 * d + 2;
    const merge = 3 * d + 3;

    blocks[split].succ.push(left, right);
    blocks[left].pred.push(split);
    blocks[left].succ.push(merge);
    blocks[right].pred.push(split);
    blocks[right].succ.push(merge);
    blocks[merge].pred.push(left, right);

    idom[left] = split;
    idom[right] = split;
    idom[merge] = split;
    blocks[left].idom = split;
    blocks[right].idom = split;
    blocks[merge].idom = split;

    for (const dom of dominators[split]) {
      dominators[left].add(dom);
      dominators[right].add(dom);
      dominators[merge].add(dom);
    }
    dominators[left].add(left);
    dominators[right].add(right);
    dominators[merge].add(merge);

    if (d === withBackEdgeAtMerge) {
      // Add a self/back-edge from merge to split to exercise cycleTainted handling
      blocks[merge].succ.push(split);
      blocks[split].pred.push(merge);
    }
  }

  const lastMerge = 3 * diamonds;
  blocks[lastMerge].succ.push(retBlockIndex);
  blocks[retBlockIndex].pred.push(lastMerge);
  idom[retBlockIndex] = lastMerge;
  blocks[retBlockIndex].idom = lastMerge;
  for (const dom of dominators[lastMerge]) dominators[retBlockIndex].add(dom);
  dominators[retBlockIndex].add(retBlockIndex);

  // Populate instructions in block order so startRow/endRow are sorted & disjoint.
  // First allocate placeholder cbr instructions and patch targets once target rows exist.
  const pendingTargets = [];
  for (let b = 0; b < totalBlocks; b++) {
    const block = blocks[b];
    const startRow = nextRow;

    if (!splitFinalDiamond && b === storeAtBlock) {
      block.insts.push(allocInst(b, {
        op: 'store',
        size: 8,
        loc: stackLoc,
        args: [{ value: valA }],
      }));
    }

    if (splitFinalDiamond && b === 3 * (diamonds - 1) + 1) {
      block.insts.push(allocInst(b, {
        op: 'store',
        size: 8,
        loc: stackLoc,
        args: [{ value: valA }],
      }));
    } else if (splitFinalDiamond && b === 3 * (diamonds - 1) + 2) {
      block.insts.push(allocInst(b, {
        op: 'store',
        size: 8,
        loc: stackLoc,
        args: [{ value: valB }],
      }));
    }

    if (b === retBlockIndex) {
      const loadVal = { id: 9999, reg: 'x0', bits: 64, kind: 'tmp' };
      const loadInst = allocInst(b, {
        op: 'load',
        size: 8,
        loc: stackLoc,
        dst: loadVal,
        args: [],
      });
      loadVal.def = loadInst;
      const retInst = allocInst(b, {
        op: 'ret',
        args: [{ value: loadVal }],
      });
      block.insts.push(loadInst, retInst);
    } else if (b === 0 || (b % 3 === 0 && b < lastMerge)) {
      const d = b === 0 ? 0 : b / 3;
      const left = 3 * d + 1;
      const cbr = allocInst(b, {
        op: 'cbr',
        sub: 'cbnz',
        extra: { kind: 'cbnz', target: null },
        args: [{ value: valCond }],
        source: { row: nextRow - 1 },
      });
      block.insts.push(cbr);
      pendingTargets.push({ inst: cbr, targetBlock: left });
    } else {
      const nop = allocInst(b, { op: 'nop', args: [] });
      block.insts.push(nop);
    }

    block.startRow = startRow;
    block.endRow = nextRow - 1;
  }

  for (const item of pendingTargets) {
    const targetRow = blocks[item.targetBlock].startRow;
    item.inst.extra.target = rowToAddress.get(targetRow);
  }

  const retBlock = blocks[retBlockIndex];
  const loadInst = retBlock.insts[0];
  const retInst = retBlock.insts[1];

  const loadExpr = expr.load(stackLoc, 64, {
    ir: loadInst.id,
    row: loadInst.row,
    address: loadInst.address,
  });
  const varA = expr.variable('a', 64, true, { ir: 1, row: 0, address: 0x10000n });
  const varB = expr.variable('b', 64, true, { ir: 2, row: 0, address: 0x10000n });
  const varCond = expr.variable('cond', 64, true, { ir: 3, row: 0, address: 0x10000n });

  const retNode = {
    kind: 'stmt',
    indent: 1,
    text: 'return local_8;',
    row: retInst.row,
    addr: retInst.address,
    source: { ir: [retInst.id], rows: [retInst.row], addresses: [retInst.address] },
    semantic: { op: 'return', ir: retInst.id, expression: loadExpr },
  };

  const ir = {
    entry: 0,
    blocks,
    instructions,
    values: [valA, valB, valCond, loadInst.dst],
    idom,
    dominators,
  };

  const result = {
    semantic: true,
    ir,
    semanticAst: {
      values: [
        { valueId: valA.id, expression: varA },
        { valueId: valB.id, expression: varB },
        { valueId: valCond.id, expression: varCond },
        { valueId: loadInst.dst.id, expression: loadExpr },
      ],
      outputs: [{ name: 'return', expression: loadExpr }],
      conditions: pendingTargets.map(({ inst }) => ({
        ir: inst.id,
        expression: expr.compare('ne', varCond, expr.constant(0, 64), null, inst.source),
      })),
      stores: [],
    },
    cAst: {
      kind: 'program',
      body: [retNode],
    },
    lines: [],
    pseudocode: '    return local_8;',
    warnings: [],
  };

  const opts = {
    deterministicTransforms: true,
    rowOfAddress: (addr) => addressToRow.get(addr) ?? null,
  };

  return { result, opts, retNode, totalBlocks };
}

test('Hotspot 1: 40-diamond chain (122 blocks) completes in <100ms for recoverExactStackReturn and recoverExactStackPhiExpressions', () => {
  // Store at diamond 15 (block 45): 25 diamonds (51 hops <= 64) before ret.
  // Without memoization, 2^25 (~33M) paths hang for tens of seconds.
  const f1 = buildDiamondChainFixture({ diamonds: 40, storeAtBlock: 45 });
  assert.equal(f1.totalBlocks, 122);
  const t0 = performance.now();
  recoverExactStackReturn(f1.result, f1.opts);
  const dt1 = performance.now() - t0;
  assert.ok(dt1 < 100, `recoverExactStackReturn took ${dt1.toFixed(1)}ms (expected <100ms)`);
  assert.equal(f1.retNode.text, 'return a;');

  const f2 = buildDiamondChainFixture({ diamonds: 40, storeAtBlock: 45 });
  assert.equal(f2.totalBlocks, 122);
  const t1 = performance.now();
  recoverExactStackPhiExpressions(f2.result, f2.opts);
  const dt2 = performance.now() - t1;
  assert.ok(dt2 < 100, `recoverExactStackPhiExpressions took ${dt2.toFixed(1)}ms (expected <100ms)`);
  assert.equal(f2.retNode.text, 'return a;');
  assert.ok((f2.result.rewriteProof || []).length >= 1, 'rewriteProof should be populated');

  // Store at block 0 (depth 81 > 64): must still finish in <100ms and fail closed.
  const f3 = buildDiamondChainFixture({ diamonds: 40, storeAtBlock: 0 });
  const t2 = performance.now();
  recoverExactStackReturn(f3.result, f3.opts);
  const dt3 = performance.now() - t2;
  assert.ok(dt3 < 100, `deep recoverExactStackReturn took ${dt3.toFixed(1)}ms (expected <100ms)`);
  assert.equal(f3.retNode.text, 'return local_8;');

  const f4 = buildDiamondChainFixture({ diamonds: 40, storeAtBlock: 0 });
  const t3 = performance.now();
  recoverExactStackPhiExpressions(f4.result, f4.opts);
  const dt4 = performance.now() - t3;
  assert.ok(dt4 < 100, `deep recoverExactStackPhiExpressions took ${dt4.toFixed(1)}ms (expected <100ms)`);
  assert.equal(f4.retNode.text, 'return local_8;');
});

test('Hotspot 1: 40-diamond chain with branch-dependent final join recovers exact select via idom controller', () => {
  const f1 = buildDiamondChainFixture({ diamonds: 40, splitFinalDiamond: true });
  const t0 = performance.now();
  recoverExactStackReturn(f1.result, f1.opts);
  const dt1 = performance.now() - t0;
  assert.ok(dt1 < 100, `recoverExactStackReturn select took ${dt1.toFixed(1)}ms`);
  assert.match(f1.retNode.text, /^return .*\? a : b;$/);

  const f2 = buildDiamondChainFixture({ diamonds: 40, splitFinalDiamond: true });
  const t1 = performance.now();
  recoverExactStackPhiExpressions(f2.result, f2.opts);
  const dt2 = performance.now() - t1;
  assert.ok(dt2 < 100, `recoverExactStackPhiExpressions select took ${dt2.toFixed(1)}ms`);
  assert.match(f2.retNode.text, /^return .*\? a : b;$/);
});

test('Hotspot 1: shouldAbort fails closed immediately on multi-block CFG traversal', () => {
  let polls1 = 0;
  const f1 = buildDiamondChainFixture({ diamonds: 40, storeAtBlock: 45 });
  const t0 = performance.now();
  recoverExactStackReturn(f1.result, {
    ...f1.opts,
    shouldAbort: () => { polls1++; return true; },
  });
  const dt1 = performance.now() - t0;
  assert.ok(dt1 < 50, `aborted recoverExactStackReturn took ${dt1.toFixed(1)}ms`);
  assert.ok(polls1 >= 1, 'shouldAbort must be polled during CFG traversal');
  assert.equal(f1.retNode.text, 'return local_8;');

  let polls2 = 0;
  const f2 = buildDiamondChainFixture({ diamonds: 40, storeAtBlock: 45 });
  const t1 = performance.now();
  recoverExactStackPhiExpressions(f2.result, {
    ...f2.opts,
    shouldAbort: () => { polls2++; return true; },
  });
  const dt2 = performance.now() - t1;
  assert.ok(dt2 < 50, `aborted recoverExactStackPhiExpressions took ${dt2.toFixed(1)}ms`);
  assert.ok(polls2 >= 1, 'shouldAbort must be polled during CFG traversal');
  assert.equal(f2.retNode.text, 'return local_8;');
});

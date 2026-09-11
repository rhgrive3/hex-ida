import assert from 'node:assert/strict';

import { expr } from '../../../js/decompiler/ast/nodes.js';
import { uniqueReachableMergePredecessorIndex } from '../../../js/decompiler/passes/stack-join-arm-proof.js';
import { recoverExactStackPhiExpressions } from '../../../js/decompiler/passes/stack-phi-recovery.js';
import { recoverExactStackReturn } from '../../../js/decompiler/passes/stack-return-recovery.js';

const BASE = 0x1000n;
const KEY = 'stack:sp:e0:-16:s4';

function returnNode(ret) {
  const expression = expr.load({ kind: 'stack', key: KEY, size: 4 }, 32, {
    rows: [ret.row], addresses: [ret.address], ir: [ret.id],
  });
  return {
    kind: 'stmt', indent: 0, text: 'return local_0;',
    semantic: { op: 'return', expression },
    source: { rows: [ret.row], addresses: [ret.address], ir: [ret.id] },
  };
}

function mirroredNoArmFixture() {
  const outer = { id: 100 };
  const a = { id: 101 };
  const b = { id: 102 };
  // yes -> P1 directly. no -> Y, and Y can reach both P1/P2.
  const controller = {
    id: 1, op: 'cbr', block: 0, row: 0, address: BASE,
    extra: { target: BASE + 0x10n, kind: 'cbnz' },
    args: [{ value: outer }],
  };
  const inner = {
    id: 11, op: 'cbr', block: 1, row: 2, address: BASE + 0x8n,
    extra: { target: BASE + 0x10n }, args: [],
  };
  const storeA = {
    id: 21, op: 'store', block: 2, row: 4, address: BASE + 0x10n,
    loc: { kind: 'stack', key: KEY, size: 4 }, size: 4, args: [{ value: a }],
  };
  const storeB = {
    id: 31, op: 'store', block: 3, row: 6, address: BASE + 0x18n,
    loc: { kind: 'stack', key: KEY, size: 4 }, size: 4, args: [{ value: b }],
  };
  const ret = { id: 41, op: 'ret', block: 4, row: 8, address: BASE + 0x20n, args: [] };
  const blocks = [
    { index: 0, startRow: 0, endRow: 0, pred: [], succ: [2, 1], insts: [controller] },
    { index: 1, startRow: 2, endRow: 2, pred: [0], succ: [2, 3], insts: [inner] },
    { index: 2, startRow: 4, endRow: 4, pred: [0, 1], succ: [4], insts: [storeA] },
    { index: 3, startRow: 6, endRow: 6, pred: [1], succ: [4], insts: [storeB] },
    { index: 4, startRow: 8, endRow: 8, pred: [2, 3], succ: [], insts: [ret] },
  ];
  const node = returnNode(ret);
  return {
    semantic: true,
    ir: { instructions: [controller, inner, storeA, storeB, ret], blocks, idom: [-1, 0, 0, 1, 0] },
    semanticAst: {
      values: [
        { valueId: 100, expression: expr.variable('outer', 32, false) },
        { valueId: 101, expression: expr.constant(11n, 32, true) },
        { valueId: 102, expression: expr.constant(22n, 32, true) },
      ],
      conditions: [{ ir: 1, expression: expr.variable('outer', 1, false) }],
      outputs: [{ name: 'return', expression: node.semantic.expression }],
    },
    cAst: { body: [node] }, rewriteProof: [], metrics: { rewrittenExpressions: 0 },
  };
}

const rowOfAddress = (address) => {
  if (address === BASE + 0x8n) return 2;
  if (address === BASE + 0x10n) return 4;
  return null;
};
const opts = { rowOfAddress, decompilerTimeBudgetMs: 50, decompilerNodeBudget: 12000 };

// Mirrored negative: the no-arm is ambiguous, so neither exact recovery path
// may publish a select or exact proof.
{
  const result = mirroredNoArmFixture();
  recoverExactStackReturn(result, opts);
  assert.equal(result.cAst.body[0].text, 'return local_0;');
  assert.equal(result.semanticAst.outputs[0].expression.kind, 'load');
  assert.equal((result.rewriteProof || []).some((x) => x.rule === 'exact-stack-return-recovery'), false);
}
{
  const result = mirroredNoArmFixture();
  recoverExactStackPhiExpressions(result, opts);
  assert.equal(result.cAst.body[0].text, 'return local_0;');
  assert.equal(result.semanticAst.outputs[0].expression.kind, 'load');
  assert.equal((result.rewriteProof || []).some((x) => x.rule === 'exact-stack-phi-recovery'), false);
}

// Concrete #3999 semantic witness for the original yes-arm counterexample.
// Legacy findIndex(canReach) maps the ambiguous true arm to P1 solely because
// P1 is first in the merge predecessor list, flattening the nested condition.
function legacyCanReach(ir, start, target, blocked, cap = 256) {
  if (start == null || target == null) return false;
  const queue = [start];
  const seen = new Set();
  while (queue.length && cap-- > 0) {
    const current = queue.shift();
    if (current === target) return true;
    if (current === blocked || seen.has(current)) continue;
    seen.add(current);
    for (const next of ir.blocks?.[current]?.succ || []) if (!seen.has(next)) queue.push(next);
  }
  return false;
}
function legacyArmIndex(ir, controller, successor, merge, predecessors) {
  if (successor === merge) return predecessors.indexOf(controller);
  return predecessors.findIndex((pred) => legacyCanReach(ir, successor, pred, merge));
}
{
  const blocks = [
    { index: 0, succ: [1, 3] },
    { index: 1, succ: [2, 3] },
    { index: 2, succ: [4] },
    { index: 3, succ: [4] },
    { index: 4, succ: [] },
  ];
  const ir = { blocks };
  const predecessors = [2, 3];
  const legacyYes = legacyArmIndex(ir, 0, 1, 4, predecessors);
  const legacyNo = legacyArmIndex(ir, 0, 3, 4, predecessors);
  assert.deepEqual([legacyYes, legacyNo], [0, 1]);
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 1, 4, predecessors), -1);

  const outer = true;
  const inner = false;
  const incoming = [11, 22];
  const actualCfgValue = outer ? (inner ? incoming[0] : incoming[1]) : incoming[1];
  const legacyFlattenedValue = outer ? incoming[legacyYes] : incoming[legacyNo];
  assert.equal(actualCfgValue, 22);
  assert.equal(legacyFlattenedValue, 11);
  assert.notEqual(legacyFlattenedValue, actualCfgValue);
}

console.log('issue #3999 mirrored ambiguity + concrete semantic witness: PASS');

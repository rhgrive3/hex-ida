import assert from 'node:assert/strict';

import { expr } from '../../../js/decompiler/ast/nodes.js';
import { uniqueReachableMergePredecessorIndex } from '../../../js/decompiler/passes/stack-join-arm-proof.js';
import { recoverExactStackPhiExpressions } from '../../../js/decompiler/passes/stack-phi-recovery.js';
import { recoverExactStackReturn } from '../../../js/decompiler/passes/stack-return-recovery.js';

const BASE = 0x1000n;
const KEY = 'stack:sp:e0:-16:s4';

function graph(edges, size = null) {
  const max = size ?? Math.max(
    0,
    ...Object.keys(edges).map(Number),
    ...Object.values(edges).flat().map(Number),
  );
  const blocks = Array.from({ length: max + 1 }, (_, index) => ({ index, succ: [] }));
  for (const [from, succ] of Object.entries(edges)) {
    blocks[Number(from)] = { index: Number(from), succ: [...succ] };
  }
  return { blocks };
}

// Proof-level acceptance/rejection boundary.
{
  const ir = graph({ 0: [1, 3], 1: [2, 3], 2: [4], 3: [4], 4: [] });
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 1, 4, [2, 3]), -1);
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 3, 4, [2, 3]), 1);
}
{
  const ir = graph({ 0: [1, 2], 1: [3], 2: [3], 3: [] });
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 1, 3, [1, 2]), 0);
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 2, 3, [1, 2]), 1);
}
{
  const ir = graph({ 0: [1, 3], 1: [2], 2: [3], 3: [] });
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 3, 3, [0, 2]), 0);
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 1, 3, [0, 2]), 1);
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 3, 3, [0, 0]), -1);
}
{
  const ir = graph({ 0: [1, 4], 1: [2, 3], 4: [2, 3], 2: [5], 3: [5], 5: [] });
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 1, 5, [2, 3]), -1);
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 4, 5, [2, 3]), -1);
}
{
  const ir = graph({ 0: [1], 1: [2], 2: [], 3: [] });
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 1, 3, [2, 0]), -1);
}
// CFG block identities are proof identities, not coercible array keys.
{
  const ir = graph({ 0: [1, 2], 1: [3], 2: [3], 3: [] });
  assert.equal(uniqueReachableMergePredecessorIndex(ir, '0', 1, 3, [1, 2]), -1);
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, '1', 3, [1, 2]), -1);
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 1, '3', [1, 2]), -1);
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 1, 3, ['1', 2]), -1);
}

function chain(uniqueNodes) {
  const merge = uniqueNodes + 1;
  const blocks = Array.from({ length: uniqueNodes + 2 }, (_, index) => ({ index, succ: [] }));
  blocks[0].succ = [1, merge];
  for (let index = 1; index < uniqueNodes; index++) blocks[index].succ = [index + 1];
  blocks[uniqueNodes].succ = [merge];
  return { blocks };
}
{
  const ir = chain(256);
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 1, 257, [256, 0], 256), 0);
}
{
  const ir = chain(257);
  assert.equal(uniqueReachableMergePredecessorIndex(ir, 0, 1, 258, [257, 0], 256), -1);
}

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

function stackPhiFixture({ ambiguous = false } = {}) {
  const a = { id: 101 };
  const b = { id: 102 };
  const controller = {
    id: 1, op: 'cbr', block: 0, row: 0, address: BASE,
    extra: { target: ambiguous ? BASE + 0x8n : BASE + 0x10n }, args: [],
  };
  const inner = {
    id: 11, op: 'cbr', block: 1, row: 2, address: BASE + 0x8n,
    extra: { target: BASE + 0x10n }, args: [],
  };
  const storeA = {
    id: 21, op: 'store', block: 2, row: 4, address: BASE + 0x10n,
    loc: { kind: 'stack', key: KEY, size: 4 }, args: [{ value: a }],
  };
  const storeB = {
    id: 31, op: 'store', block: 3, row: 6, address: BASE + 0x18n,
    loc: { kind: 'stack', key: KEY, size: 4 }, args: [{ value: b }],
  };
  const ret = { id: 41, op: 'ret', block: 4, row: 8, address: BASE + 0x20n, args: [] };
  const blocks = [
    { index: 0, startRow: 0, endRow: 0, pred: [], succ: ambiguous ? [1, 3] : [2, 3], insts: [controller] },
    { index: 1, startRow: 2, endRow: 2, pred: [0], succ: ambiguous ? [2, 3] : [], insts: [inner] },
    { index: 2, startRow: 4, endRow: 4, pred: ambiguous ? [1] : [0], succ: [4], insts: [storeA] },
    { index: 3, startRow: 6, endRow: 6, pred: ambiguous ? [0, 1] : [0], succ: [4], insts: [storeB] },
    { index: 4, startRow: 8, endRow: 8, pred: [2, 3], succ: [], insts: [ret] },
  ];
  const node = returnNode(ret);
  return {
    semantic: true,
    ir: { instructions: [controller, inner, storeA, storeB, ret], blocks, idom: [-1, 0, 0, 0, 0] },
    semanticAst: {
      values: [
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

// Sibling exact-stack-phi path must not emit exact evidence for #3999's ambiguous arm.
{
  const result = stackPhiFixture({ ambiguous: true });
  recoverExactStackPhiExpressions(result, opts);
  assert.equal(result.cAst.body[0].text, 'return local_0;');
  assert.equal(result.semanticAst.outputs[0].expression.kind, 'load');
  assert.equal((result.rewriteProof || []).some((item) => item.rule === 'exact-stack-phi-recovery'), false);
}
// Canonical diamond remains recoverable.
{
  const result = stackPhiFixture();
  recoverExactStackPhiExpressions(result, opts);
  assert.equal(result.semanticAst.outputs[0].expression.kind, 'select');
  assert.equal((result.rewriteProof || []).some((item) => item.rule === 'exact-stack-phi-recovery'), true);
}

function stackReturnFixture({ ambiguous = false } = {}) {
  const outer = { id: 100 };
  const a = { id: 101 };
  const b = { id: 102 };
  const controller = {
    id: 1, op: 'cbr', block: 0, row: 0, address: BASE,
    extra: { target: ambiguous ? BASE + 0x8n : BASE + 0x10n, kind: 'cbnz' },
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
    { index: 0, startRow: 0, endRow: 0, pred: [], succ: ambiguous ? [1, 3] : [2, 3], insts: [controller] },
    { index: 1, startRow: 2, endRow: 2, pred: [0], succ: ambiguous ? [2, 3] : [], insts: [inner] },
    { index: 2, startRow: 4, endRow: 4, pred: ambiguous ? [1] : [0], succ: [4], insts: [storeA] },
    { index: 3, startRow: 6, endRow: 6, pred: ambiguous ? [0, 1] : [0], succ: [4], insts: [storeB] },
    { index: 4, startRow: 8, endRow: 8, pred: [2, 3], succ: [], insts: [ret] },
  ];
  const node = returnNode(ret);
  return {
    semantic: true,
    ir: { instructions: [controller, inner, storeA, storeB, ret], blocks, idom: [-1, 0, 0, 0, 0] },
    semanticAst: {
      values: [
        { valueId: 100, expression: expr.variable('outer', 32, false) },
        { valueId: 101, expression: expr.constant(11n, 32, true) },
        { valueId: 102, expression: expr.constant(22n, 32, true) },
      ],
      outputs: [{ name: 'return', expression: node.semantic.expression }],
    },
    cAst: { body: [node] }, rewriteProof: [], metrics: { rewrittenExpressions: 0 },
  };
}

// Primary stack-return path must also fail closed on the ambiguous arm.
{
  const result = stackReturnFixture({ ambiguous: true });
  recoverExactStackReturn(result, opts);
  assert.equal(result.cAst.body[0].text, 'return local_0;');
  assert.equal(result.semanticAst.outputs[0].expression.kind, 'load');
  assert.equal((result.rewriteProof || []).some((item) => item.rule === 'exact-stack-return-recovery'), false);
}
// And its canonical diamond remains exact.
{
  const result = stackReturnFixture();
  recoverExactStackReturn(result, opts);
  assert.equal(result.semanticAst.outputs[0].expression.kind, 'select');
  assert.equal((result.rewriteProof || []).some((item) => item.rule === 'exact-stack-return-recovery'), true);
}

console.log('issue #3999 stack join controller uniqueness: PASS');

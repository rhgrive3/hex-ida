import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNZCVConditionExpression,
  evaluateNZCVCondition,
  renderNZCVCondition,
} from '../../js/decompiler/flag-semantics.js';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { renderBitvectorCast } from '../../js/decompiler/phase8/proof-expression.js';
import { printExpression } from '../../js/decompiler/pretty/c.js';
import { applyStructuredControlProjection } from '../../js/decompiler/phase8/structured-control-projection.js';
import { buildExpressionForTesting } from '../../js/decompiler/pipeline-core.js';

test('Pass 10: fsub hi/pl/hs/cs render as exact negated floating comparisons', () => {
  assert.equal(renderNZCVCondition('fsub', 'hi', 'a', 'b', 32), '!(a <= b)');
  assert.equal(renderNZCVCondition('fsub', 'hi', 'a', 'b', 64), '!(a <= b)');
  assert.equal(renderNZCVCondition('fsub', 'pl', 'a', 'b', 32), '!(a < b)');
  assert.equal(renderNZCVCondition('fsub', 'hs', 'a', 'b', 64), '!(a < b)');
  assert.equal(renderNZCVCondition('fsub', 'cs', 'a', 'b', 64), '!(a < b)');

  const left = expr.variable('a', 64, true);
  const right = expr.variable('b', 64, true);
  for (const [cond, innerOp] of [['hi', 'le'], ['pl', 'lt'], ['hs', 'lt'], ['cs', 'lt']]) {
    const ast = buildNZCVConditionExpression('fsub', cond, left, right, 64);
    assert.equal(ast.kind, 'unary');
    assert.equal(ast.op, 'lnot');
    assert.equal(ast.arg.kind, 'compare');
    assert.equal(ast.arg.op, innerOp);
    assert.equal(ast.arg.comparisonDomain, 'floating');
  }

  // Verify IEEE-754 equivalence (including NaN) against evaluateNZCVCondition
  const pairs = [
    [1.0, 2.0],
    [2.0, 2.0],
    [3.0, 2.0],
    [Number.NaN, 1.0],
    [1.0, Number.NaN],
    [Number.NaN, Number.NaN],
  ];
  for (const [a, b] of pairs) {
    assert.equal(evaluateNZCVCondition('fsub', 'hi', a, b, 64), !(a <= b), `hi mismatch for (${a}, ${b})`);
    assert.equal(evaluateNZCVCondition('fsub', 'pl', a, b, 64), !(a < b), `pl mismatch for (${a}, ${b})`);
    assert.equal(evaluateNZCVCondition('fsub', 'hs', a, b, 64), !(a < b), `hs mismatch for (${a}, ${b})`);
    assert.equal(evaluateNZCVCondition('fsub', 'cs', a, b, 64), !(a < b), `cs mismatch for (${a}, ${b})`);
  }

  // lt, le, vs, vc remain on exact intrinsics
  assert.equal(renderNZCVCondition('fsub', 'lt', 'a', 'b', 32), '__arm64_nzcv_fsub_lt_32((uint32_t)a, (uint32_t)b)');
  assert.equal(renderNZCVCondition('fsub', 'le', 'a', 'b', 64), '__arm64_nzcv_fsub_le_64((uint64_t)a, (uint64_t)b)');
  assert.equal(renderNZCVCondition('fsub', 'vs', 'a', 'b', 32), '__arm64_nzcv_fsub_vs_32((uint32_t)a, (uint32_t)b)');
  assert.equal(renderNZCVCondition('fsub', 'vc', 'a', 'b', 32), '__arm64_nzcv_fsub_vc_32((uint32_t)a, (uint32_t)b)');
});

test('Pass 10: renderBitvectorCast suppresses integer casts on floating-typed nodes', () => {
  const floatConst = expr.floatConstant(1.5, 64);
  const floatVarFlag = expr.variable('d0', 64, null, null, { float: true });
  const floatingVarFlag = expr.variable('d1', 64, null, null, { floating: true });
  const floatTypeVar = expr.variable('s0', 32, null, null, { type: 'float' });
  const doubleTypeVar = expr.variable('d2', 64, null, null, { type: 'double' });
  const floatKindNode = { kind: 'float', name: 'f0', bits: 32, effect: 'pure' };

  for (const node of [floatConst, floatVarFlag, floatingVarFlag, doubleTypeVar]) {
    assert.equal(renderBitvectorCast(node, 'trunc', 32), null);
  }
  for (const node of [floatTypeVar, floatKindNode]) {
    assert.equal(renderBitvectorCast(node, 'zext', 64), null);
    assert.equal(renderBitvectorCast(node, 'sext', 64), null);
  }

  // Ordinary integer nodes still render bitvector casts
  const intVar64 = expr.variable('x0', 64, false);
  const intTrunc = renderBitvectorCast(intVar64, 'trunc', 32);
  assert.ok(intTrunc, 'integer trunc cast should still render');
  assert.equal(printExpression(intTrunc), '(uint32_t)x0');

  const intVar32 = expr.variable('w0', 32, false);
  const intZext = renderBitvectorCast(intVar32, 'zext', 64);
  assert.ok(intZext, 'integer zext cast should still render');
  assert.equal(printExpression(intZext), '(uint64_t)(uint32_t)w0');
});

test('Pass 10: pretty/c omits integer trunc/zext/sext casts on floating-typed arguments', () => {
  const floatNodes = [
    expr.floatConstant(2.5, 64),
    expr.variable('d0', 64, null, null, { float: true }),
    expr.variable('d1', 64, null, null, { floating: true }),
    expr.variable('s0', 32, null, null, { type: 'float' }),
    expr.variable('d2', 64, null, null, { type: 'double' }),
  ];

  for (const node of floatNodes) {
    const expected = printExpression(node);
    for (const op of ['trunc', 'zext', 'sext']) {
      const castNode = expr.unary(op, node, op === 'trunc' ? 32 : 64, op === 'sext');
      assert.equal(printExpression(castNode), expected, `${op} on floating node must not emit integer cast`);
    }
  }

  // Integer nodes still emit integer casts
  const intVar = expr.variable('x0', 64, false);
  assert.equal(printExpression(expr.unary('trunc', intVar, 32, false)), '(uint32_t)x0');
  assert.equal(printExpression(expr.unary('zext', intVar, 64, false)), '(uint64_t)x0');
  assert.equal(printExpression(expr.unary('sext', intVar, 64, true)), '(int64_t)x0');
});

test('Pass 10: pipeline-core buildValue renders float consts and suppresses FP mov trunc/zext casts', () => {
  const ir = {
    compat: { projection: 'semantic-ir-v2-to-v1', architectureId: 'arm64' },
    instructions: [],
    blocks: [],
  };

  const state = {
    ir,
    proofOnlyRewrites: true,
    types: {
      values: new Map([
        [0, { kind: 'float', name: 'double', bits: 64 }],
        [1, { kind: 'float', name: 'float', bits: 32 }],
        [2, { kind: 'float', name: 'float', bits: 32 }],
        [3, { kind: 'integer', name: 'uint64_t', bits: 64, signed: false }],
        [4, { kind: 'integer', name: 'uint32_t', bits: 32, signed: false }],
      ]),
    },
  };

  // Floating mov trunc (64 -> 32) must NOT emit (uint32_t)
  const v0 = { id: 0, kind: 'arg', reg: 'd0', bits: 64 };
  const v1 = { id: 1, kind: 'temp', reg: 's0', bits: 32 };
  v1.def = { id: 10, op: 'mov', sub: 'trunc', row: 0, address: 0x1000n, dst: v1, args: [{ t: 'val', value: v0 }], extra: { float: true } };
  const fpMovExpr = buildExpressionForTesting(v1, state);
  const fpMovText = printExpression(fpMovExpr);
  assert.ok(!fpMovText.includes('(uint32_t)'), `FP mov trunc must not emit (uint32_t), got: ${fpMovText}`);
  assert.ok(!fpMovText.includes('(uint64_t)'), `FP mov trunc must not emit (uint64_t), got: ${fpMovText}`);

  // Floating mov zext (32 -> 64) must NOT emit (uint64_t)
  const v2 = { id: 2, kind: 'arg', reg: 's1', bits: 32 };
  const v2Wide = { id: 5, kind: 'temp', reg: 'd1', bits: 64 };
  v2Wide.def = { id: 11, op: 'mov', sub: 'zext', row: 1, address: 0x1004n, dst: v2Wide, args: [{ t: 'val', value: v2 }], extra: {} };
  const fpZextExpr = buildExpressionForTesting(v2Wide, state);
  const fpZextText = printExpression(fpZextExpr);
  assert.ok(!fpZextText.includes('(uint64_t)'), `FP mov zext must not emit (uint64_t), got: ${fpZextText}`);

  // OP.CONST with extra.constKind === 'float' / extra.float renders as float literal (not hex integer)
  const vConst = { id: 6, kind: 'temp', bits: 64 };
  vConst.def = { id: 12, op: 'const', sub: null, row: 2, address: 0x1008n, dst: vConst, args: [], extra: { float: 1.5, constKind: 'float' } };
  const floatConstExpr = buildExpressionForTesting(vConst, state);
  assert.equal(floatConstExpr.kind, 'float-const');
  assert.equal(printExpression(floatConstExpr), '1.5');

  // Integer mov trunc (64 -> 32) under proofOnlyRewrites still emits (uint32_t)
  const v3 = { id: 3, kind: 'arg', reg: 'x0', bits: 64 };
  const v4 = { id: 4, kind: 'temp', reg: 'w0', bits: 32 };
  v4.def = { id: 13, op: 'mov', sub: 'trunc', row: 3, address: 0x100cn, dst: v4, args: [{ t: 'val', value: v3 }], extra: {} };
  const intMovExpr = buildExpressionForTesting(v4, state);
  assert.ok(printExpression(intMovExpr).includes('(uint32_t)'), `integer mov trunc should keep (uint32_t), got: ${printExpression(intMovExpr)}`);
});

test('Pass 10: structured-control-projection fails closed on single-line inline braced PHI-copy branches', () => {
  const cbr = { id: 0, op: 'cbr', row: 0, address: 0x5000n, args: [], extra: { trueTarget: 1, falseTarget: 2 } };
  const br1 = { id: 1, op: 'br', row: 1, address: 0x5004n, args: [], extra: { target: 2 } };
  const ret = { id: 2, op: 'ret', row: 2, address: 0x5008n, args: [], extra: {} };

  const blocks = [
    { index: 0, startRow: 0, endRow: 0, address: 0x5000n, succ: [1, 2], pred: [], insts: [cbr] },
    { index: 1, startRow: 1, endRow: 1, address: 0x5004n, succ: [2], pred: [0], insts: [br1] },
    { index: 2, startRow: 2, endRow: 2, address: 0x5008n, succ: [], pred: [0, 1], insts: [ret] },
  ];
  const ir = {
    entry: 0,
    blocks,
    instructions: [cbr, br1, ret],
    idom: [0, 0, 0],
    ipdom: [2, 2, null],
  };

  // Single-line faithfulCfg PHI-copy branch: `if (a1 == 0) { phi_1 = 1; goto loc_5004; }`
  const body = [
    { kind: 'sig', indent: 0, text: 'uint64_t inline_phi_fn(uint64_t a1)', row: 0, addr: 0x5000n },
    { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x5000n },
    { kind: 'ctrl', indent: 1, text: 'if (a1 == 0) { phi_1 = 1; goto loc_5004; }', block: 0, row: 0, addr: 0x5000n },
    { kind: 'stmt', indent: 1, text: 'phi_1 = 2;', block: 0, row: 0, addr: 0x5000n },
    { kind: 'stmt', indent: 1, text: 'goto loc_5008;', block: 0, row: 0, addr: 0x5000n },
    { kind: 'label', indent: 0, text: 'loc_5004:', block: 1, row: 1, addr: 0x5004n },
    { kind: 'stmt', indent: 1, text: 'phi_1 = phi_1 + 10;', block: 1, row: 1, addr: 0x5004n },
    { kind: 'stmt', indent: 1, text: 'goto loc_5008;', block: 1, row: 1, addr: 0x5004n },
    { kind: 'label', indent: 0, text: 'loc_5008:', block: 2, row: 2, addr: 0x5008n },
    { kind: 'ctrl', indent: 1, text: 'return phi_1;', block: 2, row: 2, addr: 0x5008n },
    { kind: 'ctrl', indent: 0, text: '}', row: 2, addr: 0x5008n },
  ];

  const result = {
    ir,
    cAst: { kind: 'program', body },
    lines: body,
    pseudocode: body.map((n) => `${'    '.repeat(n.indent)}${n.text}`).join('\n'),
  };

  const facts = {
    completeness: 'complete',
    regions: [{ kind: 'conditional', entry: 0, exits: [2], members: [1], constraints: [], residualGotos: [] }],
    edges: [
      { from: 0, to: 1, construct: 'conditional-true' },
      { from: 0, to: 2, construct: 'conditional-false' },
      { from: 1, to: 2, construct: 'conditional-join' },
    ],
  };
  const dominators = {
    idom: [0, 0, 0],
    ipdom: [2, 2, null],
    dominators: [new Set([0]), new Set([0, 1]), new Set([0, 2])],
    postDominators: [new Set([0, 2]), new Set([1, 2]), new Set([2])],
  };
  const analysis = new Map([
    ['structuredRegions', facts],
    ['cfg', { blocks }],
    ['dominators', dominators],
  ]);

  const projected = applyStructuredControlProjection(result, analysis, {});
  assert.equal(projected, result, 'must fail closed on single-line braced PHI-copy branch');
  assert.ok(
    projected.pseudocode.includes('if (a1 == 0) { phi_1 = 1; goto loc_5004; }'),
    'inline PHI-copy branch must be preserved verbatim',
  );
});

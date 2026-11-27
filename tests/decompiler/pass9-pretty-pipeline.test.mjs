import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { printExpression } from '../../js/decompiler/pretty/c.js';
import { buildExpressionForTesting } from '../../js/decompiler/pipeline-core.js';

function val(id, reg, bits = 64, extra = {}) {
  return { id, reg, bits, kind: 'def', uses: [], def: null, const: null, ...extra };
}

function makeState(values = []) {
  return {
    ir: { values, blocks: [], instructions: [] },
    model: { addressRefs: [], calls: [], instructions: [] },
    opts: {},
    types: { values: new Map(), locations: new Map() },
  };
}

test('pretty/c: renders fadd, fsub, fmul, fdiv with correct precedence and right-associativity', () => {
  const a = expr.variable('a', 64);
  const b = expr.variable('b', 64);
  const c = expr.variable('c', 64);

  assert.equal(printExpression(expr.binary('fadd', a, b, 64)), 'a + b');
  assert.equal(printExpression(expr.binary('fsub', a, b, 64)), 'a - b');
  assert.equal(printExpression(expr.binary('fmul', a, b, 64)), 'a * b');
  assert.equal(printExpression(expr.binary('fdiv', a, b, 64)), 'a / b');

  assert.equal(
    printExpression(expr.binary('fsub', a, expr.binary('fsub', b, c, 64), 64)),
    'a - (b - c)',
  );
  assert.equal(
    printExpression(expr.binary('fdiv', a, expr.binary('fdiv', b, c, 64), 64)),
    'a / (b / c)',
  );
  assert.equal(
    printExpression(expr.binary('fmul', a, expr.binary('fadd', b, c, 64), 64)),
    'a * (b + c)',
  );
});

test('pretty/c: renders fcvt*, frint*, fsqrt/sqrt, fabs/abs, and fneg for float and double', () => {
  const d0 = expr.variable('d0', 64);
  const s0 = expr.variable('s0', 32);
  const x0 = expr.variable('x0', 64);

  const cases = [
    [expr.unary('fcvtps', d0, 32, true), '((int32_t)ceil(d0))'],
    [expr.unary('fcvtps', s0, 32, true), '((int32_t)ceilf(s0))'],
    [expr.unary('fcvtms', d0, 32, true), '((int32_t)floor(d0))'],
    [expr.unary('fcvtms', s0, 64, true), '((int64_t)floorf(s0))'],
    [expr.unary('fcvtas', d0, 32, true), '((int32_t)round(d0))'],
    [expr.unary('fcvtns', s0, 32, true), '((int32_t)roundf(s0))'],
    [expr.unary('fcvtpu', d0, 32, false), '((uint32_t)ceil(d0))'],
    [expr.unary('fcvtmu', s0, 64, false), '((uint64_t)floorf(s0))'],
    [expr.unary('fcvtau', d0, 64, false), '((uint64_t)round(d0))'],
    [expr.unary('fcvtnu', s0, 32, false), '((uint32_t)roundf(s0))'],
    [expr.unary('frinta', d0, 64), 'round(d0)'],
    [expr.unary('frintn', s0, 32), 'roundf(s0)'],
    [expr.unary('frintm', d0, 64), 'floor(d0)'],
    [expr.unary('frintm', s0, 32), 'floorf(s0)'],
    [expr.unary('frintp', d0, 64), 'ceil(d0)'],
    [expr.unary('frintp', s0, 32), 'ceilf(s0)'],
    [expr.unary('frintz', d0, 64), 'trunc(d0)'],
    [expr.unary('frintz', s0, 32), 'truncf(s0)'],
    [expr.unary('fsqrt', d0, 64), 'sqrt(d0)'],
    [expr.unary('fsqrt', s0, 32), 'sqrtf(s0)'],
    [expr.unary('sqrt', d0, 64), 'sqrt(d0)'],
    [expr.unary('fabs', d0, 64), 'fabs(d0)'],
    [expr.unary('fabs', s0, 32), 'fabsf(s0)'],
    [expr.unary('abs', x0, 32, true), 'abs(x0)'],
    [expr.unary('fneg', d0, 64), '-d0'],
    [expr.unary('fneg', expr.binary('fadd', d0, expr.variable('d1', 64), 64), 64), '-(d0 + d1)'],
  ];

  for (const [node, expected] of cases) {
    assert.equal(printExpression(node), expected);
  }
});

test('pipeline-core: folds single-address PHI operands in adrp+add to &global_*', () => {
  const addr0 = val(1, 'x25', 64);
  addr0.def = { id: 'i1', op: 'addr', dst: addr0, extra: { value: 0x20000n }, args: [] };

  const phi = val(2, 'x25', 64);
  phi.def = { id: 'i2', op: 'phi', dst: phi, incoming: [{ block: 0, value: addr0 }], args: [] };

  const off = val(3, 'imm', 64, { const: 0x50n });
  off.def = { id: 'i3', op: 'const', dst: off, extra: { value: 0x50n }, args: [] };

  const sum = val(4, 'x0', 64);
  sum.def = { id: 'i4', op: 'bin', sub: 'add', dst: sum, args: [{ value: phi }, { value: off }] };

  const built = buildExpressionForTesting(sum, makeState([addr0, phi, off, sum]));
  assert.equal(printExpression(built), '&global_20050');

  // Diamond PHI with two identical addresses through mov
  const addr1 = val(10, 'x25', 64);
  addr1.def = { id: 'i10', op: 'addr', dst: addr1, extra: { value: 0x20000n }, args: [] };
  const mov1 = val(11, 'x25', 64);
  mov1.def = { id: 'i11', op: 'mov', dst: mov1, args: [{ value: addr1 }] };
  const phi2 = val(12, 'x25', 64);
  phi2.def = {
    id: 'i12',
    op: 'phi',
    dst: phi2,
    incoming: [{ block: 1, value: addr0 }, { block: 2, value: mov1 }],
    args: [],
  };
  const sum2 = val(13, 'x0', 64);
  sum2.def = { id: 'i13', op: 'bin', sub: 'add', dst: sum2, args: [{ value: phi2 }, { value: off }] };

  const built2 = buildExpressionForTesting(sum2, makeState([addr0, addr1, mov1, phi2, off, sum2]));
  assert.equal(printExpression(built2), '&global_20050');
});

test('pipeline-core: wraps non-foldable &global_* add/sub with (uintptr_t) and avoids scaling', () => {
  const addr0 = val(1, 'x25', 64);
  addr0.def = { id: 'i1', op: 'addr', dst: addr0, extra: { value: 0x20000n }, args: [] };

  const dynOff = { id: 2, reg: 'x1', bits: 64, kind: 'arg', uses: [], def: null, const: null };

  const addNode = val(3, 'x0', 64);
  addNode.def = { id: 'i3', op: 'bin', sub: 'add', dst: addNode, args: [{ value: addr0 }, { value: dynOff }] };

  const subNode = val(4, 'x0', 64);
  subNode.def = { id: 'i4', op: 'bin', sub: 'sub', dst: subNode, args: [{ value: addr0 }, { value: dynOff }] };

  const state = makeState([addr0, dynOff, addNode, subNode]);
  const addText = printExpression(buildExpressionForTesting(addNode, state));
  const subText = printExpression(buildExpressionForTesting(subNode, state));

  assert.equal(addText, '(uintptr_t)(&global_20000) + x1');
  assert.equal(subText, '(uintptr_t)(&global_20000) - x1');

  // Multi-address PHI must not falsely fold to a single constant address
  const addrB = val(5, 'x25', 64);
  addrB.def = { id: 'i5', op: 'addr', dst: addrB, extra: { value: 0x30000n }, args: [] };
  const multiPhi = val(6, 'x25', 64);
  multiPhi.def = {
    id: 'i6',
    op: 'phi',
    dst: multiPhi,
    incoming: [{ block: 0, value: addr0 }, { block: 1, value: addrB }],
    args: [],
  };
  const off = val(7, 'imm', 64, { const: 80n });
  off.def = { id: 'i7', op: 'const', dst: off, extra: { value: 80n }, args: [] };
  const multiAdd = val(8, 'x0', 64);
  multiAdd.def = { id: 'i8', op: 'bin', sub: 'add', dst: multiAdd, args: [{ value: multiPhi }, { value: off }] };

  const multiText = printExpression(buildExpressionForTesting(multiAdd, makeState([addr0, addrB, multiPhi, off, multiAdd])));
  assert.doesNotMatch(multiText, /&global_20050/);
});

test('gcc -fsyntax-only accepts emitted float ops and (uintptr_t)(&global_*) arithmetic', () => {
  const d0 = expr.variable('d0', 64);
  const d1 = expr.variable('d1', 64);
  const s0 = expr.variable('s0', 32);
  const s1 = expr.variable('s1', 32);

  const addr0 = val(1, 'x25', 64);
  addr0.def = { id: 'i1', op: 'addr', dst: addr0, extra: { value: 0x20000n }, args: [] };
  const dynOff = { id: 2, reg: 'x1', bits: 64, kind: 'arg', uses: [], def: null, const: null };
  const addNode = val(3, 'x0', 64);
  addNode.def = { id: 'i3', op: 'bin', sub: 'add', dst: addNode, args: [{ value: addr0 }, { value: dynOff }] };

  const ptrExpr = printExpression(buildExpressionForTesting(addNode, makeState([addr0, dynOff, addNode])));

  const cSource = `
#include <math.h>
#include <stdint.h>
#include <stdlib.h>

static uint64_t global_20000 = 0;

void test_fn(double d0, double d1, float s0, float s1, uint64_t x1, int x0) {
  double r1 = ${printExpression(expr.binary('fdiv', d0, expr.binary('fsub', d1, d0, 64), 64))};
  double r2 = ${printExpression(expr.unary('fsqrt', expr.unary('fabs', expr.unary('fneg', d0, 64), 64), 64))};
  double r3 = ${printExpression(expr.unary('frinta', d0, 64))};
  float r4 = ${printExpression(expr.binary('fmul', s0, expr.binary('fadd', s0, s1, 32), 32))};
  float r5 = ${printExpression(expr.unary('frintz', expr.unary('fsqrt', s0, 32), 32))};
  int32_t i1 = ${printExpression(expr.unary('fcvtps', d0, 32, true))};
  uint64_t i2 = ${printExpression(expr.unary('fcvtau', s0, 64, false))};
  int i3 = ${printExpression(expr.unary('abs', expr.variable('x0', 32, true), 32, true))};
  uintptr_t p = ${ptrExpr};
  (void)r1; (void)r2; (void)r3; (void)r4; (void)r5; (void)i1; (void)i2; (void)i3; (void)p;
}
`;

  execFileSync('gcc', ['-x', 'c', '-fsyntax-only', '-Wall', '-Wextra', '-'], {
    input: cSource,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
});

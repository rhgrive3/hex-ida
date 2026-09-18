// Issue #8921 regression: the ARM64/Clang bit_extract idiom must preserve
// the original expression result width. Narrowing to the extracted field
// width flips sext/signed-compare semantics on ordinary values like 0x80.
import assert from 'node:assert/strict';
import test from 'node:test';

import { expr, mapChildren } from '../js/decompiler/ast/nodes.js';
import { recoverArm64ClangIdiom } from '../js/decompiler/idioms/arm64-clang.js';
import { evaluateExpression } from '../js/decompiler/verify/equivalence.js';

function walkIdiom(node) {
  if (!node) return node;
  return recoverArm64ClangIdiom(mapChildren(node, (child) => walkIdiom(child))) ?? node;
}

function maskedShift() {
  const x = expr.variable('x', 32, false);
  return expr.binary(
    'and',
    expr.binary('lshr', x, expr.constant(0, 32, false), 32, false),
    expr.constant(0xff, 32, false),
    32,
    false,
  );
}

test('#8921 bit_extract recovery preserves the 32-bit result width', () => {
  const after = walkIdiom(maskedShift());
  assert.equal(after.kind, 'intrinsic');
  assert.equal(after.name, 'bit_extract');
  assert.equal(after.bits, 32);
});

test('#8921 sext of a recovered extract matches the original on 0x80/0xff', () => {
  const before = expr.unary('sext', maskedShift(), 64, true);
  const after = walkIdiom(before);
  for (const value of [0x80n, 0xffn, 0x180n]) {
    assert.equal(
      evaluateExpression(after, { x: value }),
      evaluateExpression(before, { x: value }),
      `x=0x${value.toString(16)}`,
    );
  }
});

test('#8921 signed compare of a recovered extract keeps control flow', () => {
  const before = expr.compare('lt', maskedShift(), expr.constant(0, 32, true), true);
  const after = walkIdiom(before);
  assert.equal(evaluateExpression(after, { x: 0x80n }), evaluateExpression(before, { x: 0x80n }));
  assert.equal(evaluateExpression(before, { x: 0x80n }), 0n);
});

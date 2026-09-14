import assert from 'node:assert/strict';
import test from 'node:test';

import { expr, structuralKey } from '../../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../../js/decompiler/rewrite/rules.js';
import { verifyRewrite } from '../../js/decompiler/verify/equivalence.js';

const engine = new RewriteEngine(DEFAULT_RULES, {
  maxIterations: 16,
  nodeBudget: 4096,
  maxApplications: 2048,
  timeBudgetMs: 1000,
});

const samples64 = [
  0n,
  1n,
  2n,
  -1n,
  0x8000000000000000n,
  0xffffffffffffffffn,
];

function rewrite(node) {
  return engine.rewrite(node, { deterministicTransforms: true }).root;
}

function assertEquivalent(original, rewritten, samples = samples64) {
  const result = verifyRewrite(original, rewritten, { widths: [64], samples });
  assert.equal(result.equivalent, true, JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value));
  assert.ok(result.checked > 0);
}

test('wide !!x is not collapsed to x and remains verifier-equivalent', () => {
  const wide = expr.variable('x', 64, false);
  const original = expr.unary('lnot', expr.unary('lnot', wide, 1, false), 1, false);
  const rewritten = rewrite(original);

  assert.notEqual(structuralKey(rewritten), structuralKey(wide));
  assertEquivalent(original, rewritten);
});

test('wide x ? 1 : 0 is not collapsed to x and remains verifier-equivalent', () => {
  const wide = expr.variable('x', 64, false);
  const original = expr.select(
    wide,
    expr.constant(1, 1, false),
    expr.constant(0, 1, false),
    1,
    false,
  );
  const rewritten = rewrite(original);

  assert.notEqual(structuralKey(rewritten), structuralKey(wide));
  assertEquivalent(original, rewritten);
});

test('one-bit !!b and b ? 1 : 0 keep the readability rewrites', () => {
  const boolean = expr.variable('b', 1, false);
  const doubleNot = expr.unary('lnot', expr.unary('lnot', boolean, 1, false), 1, false);
  const materialized = expr.select(
    boolean,
    expr.constant(1, 1, false),
    expr.constant(0, 1, false),
    1,
    false,
  );

  const rewrittenDoubleNot = rewrite(doubleNot);
  const rewrittenMaterialized = rewrite(materialized);
  assert.equal(structuralKey(rewrittenDoubleNot), structuralKey(boolean));
  assert.equal(structuralKey(rewrittenMaterialized), structuralKey(boolean));
  assertEquivalent(doubleNot, rewrittenDoubleNot, [0n, 1n]);
  assertEquivalent(materialized, rewrittenMaterialized, [0n, 1n]);
});

test('compare condition still materializes directly with verifier proof', () => {
  const wide = expr.variable('x', 64, false);
  const condition = expr.compare('ne', wide, expr.constant(0, 64, false), false);
  const original = expr.select(
    condition,
    expr.constant(1, 1, false),
    expr.constant(0, 1, false),
    1,
    false,
  );
  const rewritten = rewrite(original);

  assert.equal(structuralKey(rewritten), structuralKey(condition));
  assertEquivalent(original, rewritten);
});

test('x ? 0 : 1 -> !x remains valid for general integer truthiness', () => {
  const wide = expr.variable('x', 64, false);
  const original = expr.select(
    wide,
    expr.constant(0, 1, false),
    expr.constant(1, 1, false),
    1,
    false,
  );
  const rewritten = rewrite(original);

  assert.equal(rewritten.kind, 'unary');
  assert.equal(rewritten.op, 'lnot');
  assert.equal(structuralKey(rewritten.arg), structuralKey(wide));
  assert.equal(rewritten.bits, 1);
  assertEquivalent(original, rewritten);
});

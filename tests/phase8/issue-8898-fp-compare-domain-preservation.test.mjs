/**
 * #8898 — Floating-domain compare preservation.
 *
 * `compare-constant-right` swaps operands of a compare node and records a
 * `comparison-symmetry` proof. Because the swap rebuilds the node via
 * `expr.compare(...)` without threading the original `comparisonDomain`, an
 * NZCV-derived floating-domain compare (whose operands are integer-typed
 * flag materializations) silently collapses to `integer`. The C printer then
 * emits it as an integer compare; downstream consumers see a `comparisonDomain`
 * the rewrite never proved. Floating ordered predicates (lt/le/gt/ge) are not
 * total orders — a NaN operand makes both a<b and its supposed integer inverse
 * a>=b false — so any consumer that trusts the laundered domain reasons
 * incorrectly about reversed FCMP control flow. The exact-stack PHI/return
 * recovery passes have the same inversion contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { expr, structuralKey } from '../../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../../js/decompiler/rewrite/rules.js';
import { invertBooleanCondition } from '../../js/decompiler/flag-semantics.js';

const engine = new RewriteEngine(DEFAULT_RULES, {
  maxIterations: 16, nodeBudget: 4096, maxApplications: 2048, timeBudgetMs: 1000,
});
const rewrite = (node) => engine.rewrite(node, { deterministicTransforms: true }).root;

// Integer-typed variable operands with an explicit `comparisonDomain`
// (`floating`) is the shape an NZCV FP compare reaches the rewriter in:
// `flag-semantics.js::directCompare(...)` sets the domain without marking the
// operands `.floating`, and the operands themselves remain integer SSA values.
function floatCompare(op, left, right) {
  return expr.compare(op, left, right, true, null, { comparisonDomain: 'floating' });
}

// A NaN-aware IEEE differential oracle the integer bitvector evaluator cannot
// reproduce. Both `x` operands are treated as f64 with sign / NaN handled
// explicitly so we can observe a swap's semantic preservation across unordered
// inputs (which the previous total-order inverse would have silently inverted).
function ieeeCompare(op, a, b) {
  const nan = Number.isNaN(a) || Number.isNaN(b);
  if (op === 'eq') return a === b;
  if (op === 'ne') return a !== b;
  if (nan) return false;
  if (op === 'lt') return a < b;
  if (op === 'le') return a <= b;
  if (op === 'gt') return a > b;
  if (op === 'ge') return a >= b;
  throw new Error(`unknown compare op ${op}`);
}
function evalCompare(node, vars) {
  const left = node.left.kind === 'const' ? Number(node.left.value) : vars[node.left.name];
  const right = node.right.kind === 'const' ? Number(node.right.value) : vars[node.right.name];
  return ieeeCompare(node.op, left, right);
}

// #8898 primary fix: `compare-constant-right` must carry the original domain.
test('#8898 compare-constant-right preserves floating comparisonDomain across the swap', () => {
  const x = expr.variable('x', 64, false);
  const zero = expr.constant(0n, 64, false);
  const original = floatCompare('lt', zero, x);
  assert.equal(original.comparisonDomain, 'floating');
  const rewritten = rewrite(original);
  assert.equal(rewritten.kind, 'compare');
  assert.equal(rewritten.op, 'gt', 'operand swap must invert the ordering direction');
  assert.equal(rewritten.comparisonDomain, 'floating', '#8898: rewrite must preserve floating domain');
});

// FP differential across a NaN (the class the integer evaluator misses).
test('#8898 rewritten floating compare remains IEEE-equivalent including unordered/NaN', () => {
  const x = expr.variable('x', 64, false);
  const zero = expr.constant(0n, 64, false);
  const original = floatCompare('lt', zero, x);
  const rewritten = rewrite(original);
  assert.notEqual(structuralKey(rewritten), structuralKey(original));
  for (const v of [0, -1, 1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(
      evalCompare(original, { x: v }),
      evalCompare(rewritten, { x: v }),
      `domain-preserving swap must agree on x=${v}`,
    );
  }
});

// The exact-stack PHI / return recovery passes share this negation contract via
// `invertBooleanCondition` (they previously duplicated an integer total-order
// table and both dropped `comparisonDomain`).
test('#8898 integer relational inversion stays an exact complement and keeps domain', () => {
  const x = expr.variable('x', 64, true);
  const c = expr.constant(0n, 64, true);
  const lt = expr.compare('lt', x, c, true);
  const inverted = invertBooleanCondition(lt);
  assert.equal(inverted.kind, 'compare');
  assert.equal(inverted.op, 'ge', 'integer lt <-> ge is an exact complement in a total order');
  assert.equal(inverted.comparisonDomain, 'integer');
});

test('#8898 floating relational inversion fails closed to lnot and keeps floating domain', () => {
  const x = expr.variable('x', 64, false);
  const c = expr.constant(0n, 64, false);
  for (const op of ['lt', 'le', 'gt', 'ge']) {
    const floating = expr.compare(op, x, c, true, null, { comparisonDomain: 'floating' });
    const inverted = invertBooleanCondition(floating);
    // A relational floating predicate has no exact relational complement (NaN):
    // the negation must stay an explicit logical-not of the original, never the
    // integer total-order inverse that would launder unordered control flow.
    assert.equal(inverted.kind, 'unary', `floating ${op} must not invert to a relational compare`);
    assert.equal(inverted.op, 'lnot');
    assert.equal(inverted.arg.kind, 'compare');
    assert.equal(inverted.arg.op, op, `the negated operand keeps the original ${op} predicate`);
    assert.equal(inverted.arg.comparisonDomain, 'floating', 'domain survives the negation');
  }
});

test('#8898 floating eq/ne inversion remains an exact complement with domain preserved', () => {
  const x = expr.variable('x', 64, false);
  const c = expr.constant(0n, 64, false);
  const eq = expr.compare('eq', x, c, true, null, { comparisonDomain: 'floating' });
  const inverted = invertBooleanCondition(eq);
  assert.equal(inverted.kind, 'compare');
  assert.equal(inverted.op, 'ne', 'eq/ne are exact complements even over NaN (IEEE)');
  assert.equal(inverted.comparisonDomain, 'floating');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { expr } from '../../js/decompiler/ast/nodes.js';
import { DEFAULT_RULES } from '../../js/decompiler/rewrite/rules.js';

function rule(name) {
  const found = DEFAULT_RULES.find((candidate) => candidate.name === name);
  assert.ok(found, `missing rewrite rule: ${name}`);
  return found;
}

const doubleLogicalNot = rule('double-logical-not');
const selectBoolMaterialize = rule('select-bool-materialize');
const selectBoolInvert = rule('select-bool-invert');

test('double logical not is only eliminated for an already-boolean operand', () => {
  const wide = expr.variable('x', 64, false);
  const wideDoubleNot = expr.unary('lnot', expr.unary('lnot', wide, 1, false), 1, false);

  assert.notEqual(doubleLogicalNot.match(wideDoubleNot), null);
  assert.equal(doubleLogicalNot.precondition(wideDoubleNot), false);

  const boolean = expr.variable('b', 1, false);
  const booleanDoubleNot = expr.unary('lnot', expr.unary('lnot', boolean, 1, false), 1, false);
  assert.equal(doubleLogicalNot.precondition(booleanDoubleNot), true);
  assert.strictEqual(doubleLogicalNot.rewrite(booleanDoubleNot), boolean);
});

test('select boolean materialization only returns a one-bit condition directly', () => {
  const one = expr.constant(1, 1, false);
  const zero = expr.constant(0, 1, false);
  const wide = expr.variable('x', 64, false);
  const wideSelect = expr.select(wide, one, zero, 1, false);

  assert.equal(selectBoolMaterialize.match(wideSelect), null);

  const boolean = expr.variable('b', 1, false);
  const booleanSelect = expr.select(boolean, one, zero, 1, false);
  assert.notEqual(selectBoolMaterialize.match(booleanSelect), null);
  assert.strictEqual(selectBoolMaterialize.rewrite(booleanSelect), boolean);

  const compare = expr.compare('ne', wide, expr.constant(0, 64, false), false);
  const compareSelect = expr.select(compare, one, zero, 1, false);
  assert.notEqual(selectBoolMaterialize.match(compareSelect), null);
});

test('select boolean inversion remains valid for general integer truthiness', () => {
  const wide = expr.variable('x', 64, false);
  const inverted = expr.select(
    wide,
    expr.constant(0, 1, false),
    expr.constant(1, 1, false),
    1,
    false,
  );

  assert.notEqual(selectBoolInvert.match(inverted), null);
  const rewritten = selectBoolInvert.rewrite(inverted);
  assert.equal(rewritten.kind, 'unary');
  assert.equal(rewritten.op, 'lnot');
  assert.strictEqual(rewritten.arg, wide);
  assert.equal(rewritten.bits, 1);
});

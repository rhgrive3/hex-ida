import assert from 'node:assert/strict';
import test from 'node:test';

import { OP } from '../js/ir-base.js';
import { EXPR_KIND } from '../js/symbolic/expr/kinds.js';
import { evaluateExpr, EVAL_STATUS } from '../js/symbolic/expr/evaluate.js';
import { translateSemanticIR } from '../js/symbolic/translate/semantic-ir.js';

const malformedValues = [
  ['array-single-element', ['5']],
  ['array-width-one', ['255']],
  ['boolean-true', true],
  ['boolean-false', false],
  ['object', {}],
  ['numeric-decimal-string', '5'],
  ['numeric-hex-string', '0x1f'],
  ['fractional-number', 2.5],
  ['nan', NaN],
  ['infinity', Infinity],
  ['unsafe-integer', Number.MAX_SAFE_INTEGER + 1],
];

for (const [name, bad] of malformedValues) {
  test(`#4692 value-level malformed const (${name}) fails closed instead of minting an exact constant`, () => {
    const out = translateSemanticIR({ id: `v_${name}`, const: bad }, { bitWidth: 8 });
    assert.notEqual(out.status, 'exact');
    assert.equal(out.status, 'unsupported');
    assert.equal(out.expression.kind, EXPR_KIND.UNKNOWN_SEMANTIC);
    assert.equal(out.semanticUnknowns, 1);
    assert.ok(out.unsupportedEntities.some((entity) => entity.reason === 'non-canonical-constant-value'));
    assert.equal(out.completeness.translation, 'unsupported');
    assert.equal(evaluateExpr(out.expression).status, EVAL_STATUS.UNKNOWN);
  });

  test(`#4692 instruction-level OP.CONST malformed value (${name}) fails closed instead of minting an exact constant`, () => {
    const out = translateSemanticIR({ id: `i_${name}`, op: OP.CONST, value: bad }, { bitWidth: 8 });
    assert.notEqual(out.status, 'exact');
    assert.equal(out.status, 'unsupported');
    assert.equal(out.expression.kind, EXPR_KIND.UNKNOWN_SEMANTIC);
    assert.equal(out.semanticUnknowns, 1);
    assert.ok(out.unsupportedEntities.some((entity) => entity.reason === 'non-canonical-constant-value'));
    assert.equal(out.completeness.translation, 'unsupported');
    assert.equal(evaluateExpr(out.expression).status, EVAL_STATUS.UNKNOWN);
  });
}

test('#4692 canonical bigint constants keep exact translation and normal wrapping', () => {
  const cases = [[5n, 5n], [-1n, 255n], [256n, 0n], [300n, 44n]];
  for (const [input, expected] of cases) {
    const viaValue = translateSemanticIR({ id: `vc_${String(input)}`, const: input }, { bitWidth: 8 });
    assert.equal(viaValue.status, 'exact');
    assert.equal(viaValue.expression.kind, EXPR_KIND.CONST);
    assert.equal(viaValue.expression.value, expected);
    assert.equal(viaValue.semanticUnknowns, 0);
    assert.deepEqual(viaValue.unsupportedEntities, []);

    const viaInst = translateSemanticIR({ id: `ic_${String(input)}`, op: OP.CONST, value: input }, { bitWidth: 8 });
    assert.equal(viaInst.status, 'exact');
    assert.equal(viaInst.expression.value, expected);
    assert.equal(viaInst.semanticUnknowns, 0);
    assert.deepEqual(viaInst.unsupportedEntities, []);
  }
});

test('#4692 canonical safe-integer number constants keep exact translation', () => {
  for (const [input, expected] of [[0, 0n], [7, 7n], [256, 0n]]) {
    const out = translateSemanticIR({ id: `nc_${input}`, op: OP.CONST, value: input }, { bitWidth: 8 });
    assert.equal(out.status, 'exact');
    assert.equal(out.expression.value, expected);
    assert.equal(out.semanticUnknowns, 0);
  }
});

test('#4692 malformed constant inside a comparison does not become exact', () => {
  const left = { id: 'laundered', const: ['5'] };
  const right = { id: 'zero', const: 0n };
  const out = translateSemanticIR(
    { id: 'cmp', op: OP.CMP, cond: 'eq', args: [{ value: left }, { value: right }] },
    { bitWidth: 8 }
  );
  assert.equal(out.status, 'unsupported');
  assert.equal(out.expression.kind, EXPR_KIND.COMPARE);
  assert.ok(out.unsupportedEntities.some((entity) => entity.reason === 'non-canonical-constant-value'));
  assert.ok(out.semanticUnknowns >= 1);
  assert.equal(evaluateExpr(out.expression).status, EVAL_STATUS.UNKNOWN);
});

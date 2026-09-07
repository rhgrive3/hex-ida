import test from 'node:test';
import assert from 'node:assert/strict';

import { translateSemanticIR } from '../js/symbolic/translate/semantic-ir.js';
import { EXPR_KIND, BV_UNARY_OP } from '../js/symbolic/expr/kinds.js';
assert.ok(EXPR_KIND.FRESH_SYMBOL, 'EXPR_KIND.FRESH_SYMBOL must exist');
import { evaluateExpr, EVAL_STATUS } from '../js/symbolic/expr/evaluate.js';
import { TRANSLATION_STATUS, COMPLETENESS_STATUS } from '../js/symbolic/translate/support-matrix.js';

function argValue() {
  return { id: 'arg0', kind: 'arg', reg: 'x0', index: 0, origin: '0x1000' };
}

function negatedArg() {
  const arg = argValue();
  const inst = {
    id: 'i1',
    op: 'un',
    subOp: 'not',
    origin: '0x1004',
    args: [{ value: arg }],
  };
  return { id: 'v1', def: inst, origin: '0x1004' };
}

test('#6090 zero and safe-integer number bindings stay exact concrete BVs', () => {
  const zero = translateSemanticIR(argValue(), { bitWidth: 64, symbolicArgs: { 0: 0 } });
  assert.equal(zero.status, TRANSLATION_STATUS.EXACT);
  assert.equal(zero.semanticUnknowns, 0);
  assert.equal(zero.unsupportedEntities.length, 0);
  const ev0 = evaluateExpr(zero.expression, new Map());
  assert.equal(ev0.status, EVAL_STATUS.VALUE);
  assert.equal(ev0.value, 0n);

  const fortyTwo = translateSemanticIR(argValue(), { bitWidth: 64, symbolicArgs: { 0: 42 } });
  assert.equal(fortyTwo.status, TRANSLATION_STATUS.EXACT);
  const ev42 = evaluateExpr(fortyTwo.expression, new Map());
  assert.equal(ev42.value, 42n);

  const maxSafe = translateSemanticIR(argValue(), {
    bitWidth: 64,
    symbolicArgs: { 0: Number.MAX_SAFE_INTEGER },
  });
  assert.equal(maxSafe.status, TRANSLATION_STATUS.EXACT);
  assert.equal(evaluateExpr(maxSafe.expression, new Map()).value, 9007199254740991n);
});

test('#6090 bigint bindings remain exact concrete BVs', () => {
  const res = translateSemanticIR(argValue(), { bitWidth: 64, symbolicArgs: { 0: 7n } });
  assert.equal(res.status, TRANSLATION_STATUS.EXACT);
  assert.equal(evaluateExpr(res.expression, new Map()).value, 7n);
});

test('#6090 fractional number binding does not leak raw BigInt RangeError', () => {
  for (const bad of [1.5, -0.25, NaN, Infinity, -Infinity]) {
    let threw = null;
    let res = null;
    try {
      res = translateSemanticIR(argValue(), { bitWidth: 64, symbolicArgs: { 0: bad } });
    } catch (e) {
      threw = e;
    }
    assert.equal(threw, null, `binding ${String(bad)} must not throw`);
    assert.ok(res, `binding ${String(bad)} must return a result`);
    assert.equal(res.status, TRANSLATION_STATUS.UNSUPPORTED, String(bad));
    assert.ok(res.semanticUnknowns > 0, String(bad));
    assert.ok(res.unsupportedEntities.length > 0, String(bad));
    assert.ok(res.unsupportedEntities[0].reason.startsWith('invalid-numeric-concrete-binding:'), String(bad));
    assert.equal(res.unsupportedEntities[0].op, 'arg:x0');
    assert.equal(res.expression.kind, EXPR_KIND.UNKNOWN_SEMANTIC);
    assert.equal(res.completeness.translation, COMPLETENESS_STATUS.UNSUPPORTED);
  }
});

test('#6090 unsafe integer numbers are not accepted as exact concrete witnesses', () => {
  const res = translateSemanticIR(argValue(), {
    bitWidth: 64,
    symbolicArgs: { 0: Number.MAX_SAFE_INTEGER + 1 },
  });
  assert.equal(res.status, TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(res.expression.kind, EXPR_KIND.UNKNOWN_SEMANTIC);
  assert.ok(res.unsupportedEntities.length > 0);
});

test('#6090 string bindings remain fresh-symbol names', () => {
  const res = translateSemanticIR(argValue(), { bitWidth: 64, symbolicArgs: { 0: 'user_arg' } });
  assert.equal(res.status, TRANSLATION_STATUS.EXACT);
  assert.equal(res.expression.kind, EXPR_KIND.FRESH_SYMBOL);
  assert.equal(res.expression.name, 'user_arg');
});

test('#6090 translation containing an invalid binding cannot become PROVED evidence', () => {
  const res = translateSemanticIR(negatedArg(), { bitWidth: 64, symbolicArgs: { 0: 1.5 } });
  assert.equal(res.status, TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(res.expression.kind, EXPR_KIND.UNARY);
  assert.equal(res.expression.op, BV_UNARY_OP.NOT);
  assert.equal(res.expression.arg.kind, EXPR_KIND.UNKNOWN_SEMANTIC);
  assert.equal(res.expression.arg.reason, 'invalid-numeric-concrete-binding');
  assert.ok(res.semanticUnknowns > 0);
  assert.equal(res.completeness.translation, COMPLETENESS_STATUS.UNSUPPORTED);
  assert.equal(res.completeness.controlFlow, COMPLETENESS_STATUS.PARTIAL);
  assert.equal(res.completeness.memoryEffects, COMPLETENESS_STATUS.PARTIAL);
});

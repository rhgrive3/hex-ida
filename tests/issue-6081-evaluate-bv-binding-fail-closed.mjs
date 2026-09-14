import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, boolSort } from '../js/symbolic/expr/kinds.js';
import { createFreshSymbol, createBv } from '../js/symbolic/expr/factory.js';
import { evaluateExpr, EVAL_STATUS } from '../js/symbolic/expr/evaluate.js';

test('#6081 malformed BV symbol binding returns structured unknown instead of throwing', () => {
  const x = createFreshSymbol(bvSort(64), 'x');
  for (const malformed of ['not-an-integer', {}, [], true, 1.5, NaN]) {
    let result = null;
    assert.doesNotThrow(
      () => {
        result = evaluateExpr(x, { [x.symbolId]: malformed });
      },
      `BV binding ${JSON.stringify(malformed)} must not throw`,
    );
    assert.equal(result.status, EVAL_STATUS.UNKNOWN, `BV binding ${JSON.stringify(malformed)} must not evaluate to a value`);
    assert.equal(result.reason, 'malformed-bitvector-binding');
    assert.equal(result.sort, x.sort);
  }
});

test('#6081 wrapped binding object with malformed inner value is also fail-closed', () => {
  const x = createFreshSymbol(bvSort(32), 'x');
  let result = null;
  assert.doesNotThrow(() => {
    result = evaluateExpr(x, { [x.symbolId]: { value: 'garbage' } });
  });
  assert.equal(result.status, EVAL_STATUS.UNKNOWN);
  assert.equal(result.reason, 'malformed-bitvector-binding');
});

test('#6081 canonical BV bindings keep evaluating', () => {
  const x = createFreshSymbol(bvSort(8), 'x');
  assert.equal(evaluateExpr(x, { [x.symbolId]: 255 }).value, 255n);
  assert.equal(evaluateExpr(x, { [x.symbolId]: '0xff' }).value, 255n);
  assert.equal(evaluateExpr(x, { [x.symbolId]: 255n }).value, 255n);
  assert.equal(evaluateExpr(x, { [x.symbolId]: '-0x10' }).value, 240n, 'signed hexadecimal strings remain supported without raw BigInt errors');
  assert.equal(evaluateExpr(x, { [x.symbolId]: '+0x10' }).value, 16n, 'plus-signed hexadecimal strings remain supported without raw BigInt errors');
  assert.equal(evaluateExpr(x, { [x.symbolId]: { value: 300 } }).value, 44n, 'wrap still normalizes into the sort width');
  const boolSymbol = createFreshSymbol(boolSort(), 'b');
  assert.equal(evaluateExpr(boolSymbol, { [boolSymbol.symbolId]: true }).value, true);
  assert.equal(evaluateExpr(createBv(8, 5), {}).status, EVAL_STATUS.VALUE);
});

test('#6081 boolean malformed binding behavior is preserved', () => {
  const b = createFreshSymbol(boolSort(), 'b');
  const result = evaluateExpr(b, { [b.symbolId]: 'yes' });
  assert.equal(result.status, EVAL_STATUS.UNKNOWN);
  assert.equal(result.reason, 'malformed-boolean-binding');
});

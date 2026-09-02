import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExpr, EVAL_STATUS } from '../js/symbolic/expr/evaluate.js';
import { validateSatModel } from '../js/symbolic/verify/validate-model.js';
import { createFreshSymbol, createBv } from '../js/symbolic/expr/factory.js';
import { boolSort, bvSort } from '../js/symbolic/expr/kinds.js';

const flag = createFreshSymbol(boolSort(), 'flag');

test('#3245 BOOL bindings accept only primitive booleans', () => {
  assert.deepEqual(evaluateExpr(flag, { flag: true }), { status: EVAL_STATUS.VALUE, sort: flag.sort, value: true });
  assert.deepEqual(evaluateExpr(flag, { flag: false }), { status: EVAL_STATUS.VALUE, sort: flag.sort, value: false });
  assert.equal(evaluateExpr(flag, { flag: 'false' }).status, EVAL_STATUS.UNKNOWN);
  assert.equal(evaluateExpr(flag, { flag: 'false' }).reason, 'malformed-boolean-binding');
  assert.equal(evaluateExpr(flag, { flag: 0 }).status, EVAL_STATUS.UNKNOWN);
  assert.equal(evaluateExpr(flag, { flag: 1 }).status, EVAL_STATUS.UNKNOWN);
  assert.equal(evaluateExpr(flag, { flag: {} }).status, EVAL_STATUS.UNKNOWN);
  assert.equal(evaluateExpr(flag, { flag: [] }).status, EVAL_STATUS.UNKNOWN);
  assert.equal(evaluateExpr(flag, { flag: null }).status, EVAL_STATUS.UNKNOWN);
});

test('#3245 boolean wrapper objects still unwrap to their primitive value', () => {
  assert.equal(evaluateExpr(flag, { flag: { value: false } }).value, false);
  assert.equal(evaluateExpr(flag, { flag: { value: true } }).value, true);
  assert.equal(evaluateExpr(flag, { flag: { value: 'false' } }).status, EVAL_STATUS.UNKNOWN);
});

test('#3245 validateSatModel rejects truthy-coerced witnesses', () => {
  assert.equal(validateSatModel({ constraints: [flag] }, { flag: 'false' }).valid, false);
  assert.equal(validateSatModel({ constraints: [flag] }, { flag: {} }).valid, false);
  assert.equal(validateSatModel({ constraints: [flag] }, { flag: [] }).valid, false);
  assert.equal(validateSatModel({ constraints: [flag] }, { flag: 1 }).valid, false);
});

test('#3245 real boolean witnesses still validate', () => {
  const satisfied = validateSatModel({ constraints: [flag] }, { flag: true });
  assert.equal(satisfied.valid, true);
  const violated = validateSatModel({ constraints: [createFreshSymbol(boolSort(), 'other')] }, { flag: true, other: false });
  assert.equal(violated.valid, false);
});

test('#3245 BV bindings keep their existing wrap semantics', () => {
  const x = createFreshSymbol(bvSort(8), 'x');
  const result = evaluateExpr(x, { x: 3 });
  assert.equal(result.status, EVAL_STATUS.VALUE);
  assert.equal(result.value.toBigInt?.() ?? result.value, 3n);
  assert.ok(evaluateExpr(x, { x: createBv(8, 5n) }));
});

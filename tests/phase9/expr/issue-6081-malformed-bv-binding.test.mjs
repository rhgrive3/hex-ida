import test from 'node:test';
import assert from 'node:assert/strict';
import { bvSort } from '../../../js/symbolic/expr/kinds.js';
import { createFreshSymbol } from '../../../js/symbolic/expr/factory.js';
import { evaluateExpr } from '../../../js/symbolic/expr/evaluate.js';

test('6081: malformed string binding becomes UNKNOWN, not a throw', () => {
  const x = createFreshSymbol(bvSort(64), 'x');
  let out = null;
  assert.doesNotThrow(() => { out = evaluateExpr(x, { [x.symbolId]: 'not-an-integer' }); });
  assert.equal(out.status, 'unknown');
  assert.equal(out.reason, 'malformed-bitvector-binding');
});

test('6081: malformed object binding becomes UNKNOWN', () => {
  const x = createFreshSymbol(bvSort(32), 'y');
  const out = evaluateExpr(x, { [x.symbolId]: {} });
  assert.equal(out.status, 'unknown');
  assert.equal(out.reason, 'malformed-bitvector-binding');
});

test('6081: non-integer number binding becomes UNKNOWN', () => {
  const x = createFreshSymbol(bvSort(32), 'z');
  const out = evaluateExpr(x, { [x.symbolId]: 1.5 });
  assert.equal(out.status, 'unknown');
  assert.equal(out.reason, 'malformed-bitvector-binding');
});

test('6081: wrapped object binding becomes UNKNOWN', () => {
  const x = createFreshSymbol(bvSort(8), 'w');
  const out = evaluateExpr(x, { [x.symbolId]: { value: 'nope' } });
  assert.equal(out.status, 'unknown');
  assert.equal(out.reason, 'malformed-bitvector-binding');
});

test('6081: canonical bindings still evaluate', () => {
  const a = createFreshSymbol(bvSort(8), 'a');
  assert.equal(evaluateExpr(a, { [a.symbolId]: 257 }).value, 1n);
  const b = createFreshSymbol(bvSort(64), 'b');
  assert.equal(evaluateExpr(b, { [b.symbolId]: 42n }).value, 42n);
  const c = createFreshSymbol(bvSort(16), 'c');
  assert.equal(evaluateExpr(c, { [c.symbolId]: { value: 7 } }).value, 7n);
});

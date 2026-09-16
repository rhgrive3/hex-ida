import assert from 'node:assert/strict';
import test from 'node:test';

import { expr, sameExpr } from '../../js/decompiler/ast/nodes.js';

const variable = (ssaId, source = null) => expr.variable(
  'local_1',
  32,
  false,
  source,
  { ssaId },
);

test('#8902 malformed object-valued ssaId does not alias', () => {
  const a = variable({ a: 1 });
  const b = variable({ b: 2 });
  assert.equal(sameExpr(a, b), false);
});

test('#8902 conflicting ssaId and source.ssaDefs does not alias', () => {
  const a = variable('x', { ssaDef: 'y' });
  const b = variable('x', { ssaDef: 'y' });
  assert.equal(sameExpr(a, b), false);
});

test('#8902 separate vars without value identity fail closed', () => {
  const a = expr.variable('local_1', 32, false);
  const b = expr.variable('local_1', 32, false);
  assert.equal(sameExpr(a, b), false);
});

test('#8902 matching canonical SSA identity still aliases', () => {
  const a = variable('x', { ssaDef: 'x' });
  const b = variable('x', { ssaDef: 'x' });
  assert.equal(sameExpr(a, b), true);
});

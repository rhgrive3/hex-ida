// Issue #8902 regression: `structuralKey()` must fold a variable's authoritative
// SSA value identity into the `var` case, mirroring the load case's
// `loadValueIdentity`. The recovered source/high-variable NAME is presentation,
// not value equality; one source variable legitimately has many SSA versions.
import assert from 'node:assert/strict';
import test from 'node:test';

import { expr, sameExpr, structuralKey } from '../../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../../js/decompiler/rewrite/rules.js';
import { printExpression } from '../../js/decompiler/pretty/c.js';

const engine = new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: 1000, nodeBudget: 4096, maxIterations: 16 });
const rw = (e) => engine.rewrite(e).root;

const ssaVar = (id) => expr.variable('local_1', 32, false, { ssaDef: id }, { ssaId: id });
const c = (n, bits = 32) => expr.constant(BigInt(n), bits, false);

test('#8902 distinct SSA versions of one source name are NOT value-equal', () => {
  const left = ssaVar('old');
  const right = ssaVar('new');
  assert.equal(sameExpr(left, right), false);
  assert.notEqual(structuralKey(left), structuralKey(right));
});

test('#8902 the identical SSA value still matches', () => {
  assert.equal(sameExpr(ssaVar('old'), ssaVar('old')), true);
});

test('#8902 conflicting ssaId vs source.ssaDefs fails closed', () => {
  const conflict = expr.variable('local_1', 32, false, { ssaDef: 'y' }, { ssaId: 'x' });
  const agreeing = expr.variable('local_1', 32, false, { ssaDef: 'x' }, { ssaId: 'x' });
  assert.equal(sameExpr(conflict, agreeing), false);
  const idOnly = expr.variable('local_1', 32, false, null, { ssaId: 'x' });
  assert.equal(sameExpr(idOnly, agreeing), false);
});

test('#8902 absent value identity fails closed for equality-sensitive comparisons', () => {
  const plainA = expr.variable('x', 32, true);
  const plainB = expr.variable('x', 32, true);
  assert.equal(sameExpr(plainA, plainB), false);
});

test('#8902 sub-self does not fold two distinct SSA values into 0', () => {
  const diff = rw(expr.binary('sub', ssaVar('old'), ssaVar('new'), 32, false));
  assert.equal(diff.kind, 'binary');
  assert.notEqual(printExpression(diff), '0');
  const same = rw(expr.binary('sub', ssaVar('old'), ssaVar('old'), 32, false));
  assert.equal(same.kind, 'const');
  assert.equal(printExpression(same), '0');
});

test('#8902 xor-self does not fold two distinct SSA values into 0', () => {
  const diff = rw(expr.binary('xor', ssaVar('old'), ssaVar('new'), 32, false));
  assert.equal(diff.kind, 'binary');
  const same = rw(expr.binary('xor', ssaVar('old'), ssaVar('old'), 32, false));
  assert.equal(printExpression(same), '0');
});

test('#8902 select-identical-arms does not collapse distinct SSA arms', () => {
  const cond = expr.compare('gt', expr.variable('flag', 32, false), c(0), true);
  const distinct = rw(expr.select(cond, ssaVar('old'), ssaVar('new'), 32, false));
  assert.equal(distinct.kind, 'select');
  const identical = rw(expr.select(cond, ssaVar('old'), ssaVar('old'), 32, false));
  assert.equal(identical.kind, 'var');
});

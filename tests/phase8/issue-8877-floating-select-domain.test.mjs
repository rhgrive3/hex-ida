import assert from 'node:assert/strict';
import test from 'node:test';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../../js/decompiler/rewrite/rules.js';
import { buildNZCVConditionExpression } from '../../js/decompiler/flag-semantics.js';
import { evaluateExpression } from '../../js/decompiler/verify/equivalence.js';
import { evalBinary, u } from '../../js/decompiler/truth/integer.js';

const rewrite = (root) => new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: 1000, nodeBudget: 4096 })
  .rewrite(root, { deterministicTransforms: true });
const rulesOf = (out) => out.proof.map((p) => p.rule);
const dv32 = new DataView(new ArrayBuffer(4)), dv64 = new DataView(new ArrayBuffer(8));
const encode = (value, bits) => {
  if (bits === 32) { dv32.setFloat32(0, value); return BigInt(dv32.getUint32(0)); }
  dv64.setFloat64(0, value); return dv64.getBigUint64(0);
};
const decode = (pattern, bits) => {
  if (bits === 32) { dv32.setUint32(0, Number(u(pattern, 32))); return dv32.getFloat32(0); }
  dv64.setBigUint64(0, u(pattern, 64)); return dv64.getFloat64(0);
};
function fpTruth(n, env, bits) {
  switch (n.kind) {
    case 'const': return u(n.value, n.bits);
    case 'var': return u(env[n.name], bits);
    case 'compare': {
      if (n.comparisonDomain !== 'floating') {
        const a = fpTruth(n.left, env, bits), b = fpTruth(n.right, env, bits);
        return evalBinary(n.op, a, b, n.left?.bits || bits, n.compareSigned);
      }
      const a = decode(fpTruth(n.left, env, bits), bits), b = decode(fpTruth(n.right, env, bits), bits);
      if (n.op === 'lt') return a < b ? 1n : 0n;
      if (n.op === 'le') return a <= b ? 1n : 0n;
      if (n.op === 'gt') return a > b ? 1n : 0n;
      if (n.op === 'ge') return a >= b ? 1n : 0n;
      if (n.op === 'eq') return a === b ? 1n : 0n;
      if (n.op === 'ne') return a !== b ? 1n : 0n;
      return null;
    }
    case 'select': {
      const q = fpTruth(n.condition, env, bits);
      return q == null ? null : fpTruth(q === 0n ? n.whenFalse : n.whenTrue, env, bits);
    }
    case 'unary': {
      const a = fpTruth(n.arg, env, bits);
      return a == null || n.op !== 'neg' ? null : u(-u(a, n.bits), n.bits);
    }
    case 'intrinsic': throw new Error(`integer intrinsic ${n.name} minted from floating select`);
    default: return null;
  }
}

test('#8877 FCMP/FCSEL floating comparison domain never becomes integer min/max', () => {
  const conditions = ['mi', 'lo', 'cc', 'ls', 'ge', 'gt'];
  const values = [1, -1, 2, -2, 0.5, -0.5, 0, -0, Infinity, -Infinity, NaN, 1e-38, -1e-38, 3.25, -7.75];
  let checks = 0;
  for (const bits of [32, 64]) {
    const x = expr.variable('x', bits, null), y = expr.variable('y', bits, null);
    for (const cond of conditions) for (const [left, right] of [[x, y], [y, x]]) {
      const condition = buildNZCVConditionExpression('fsub', cond, left, right, bits);
      assert.equal(condition?.comparisonDomain, 'floating');
      const root = expr.select(condition, left, right, bits, null), out = rewrite(root);
      assert.equal(out.root.kind, 'select');
      assert.equal(out.root.condition.comparisonDomain, 'floating');
      assert.ok(!rulesOf(out).includes('select-min-max'));
      assert.ok(!out.proof.some((p) => p.evidence?.kind === 'select-comparison-equivalence'));
      for (const xv of values) for (const yv of values) {
        const env = { x: encode(xv, bits), y: encode(yv, bits) };
        assert.equal(fpTruth(out.root, env, bits), fpTruth(root, env, bits));
        checks++;
      }
    }
  }
  assert.equal(checks, 5400);
});

test('#8877 floating abs is preserved while integer-domain min/max/abs still optimize', () => {
  for (const bits of [32, 64]) {
    const x = expr.variable('x', bits, null), y = expr.variable('y', bits, null), zero = expr.constant(0n, bits, true);
    const floating = expr.select(expr.compare('lt', x, zero, true, null, { comparisonDomain: 'floating' }),
      expr.unary('neg', x, bits, true), x, bits, true);
    const floatingOut = rewrite(floating);
    assert.notEqual(floatingOut.root.name, 'abs');
    assert.ok(!rulesOf(floatingOut).includes('select-abs'));

    for (const [op, signed, name] of [['lt', true, 'min'], ['gt', true, 'max'], ['lt', false, 'min'], ['ge', false, 'max']]) {
      const root = expr.select(expr.compare(op, x, y, signed), x, y, bits, signed), out = rewrite(root);
      assert.equal(out.root.kind, 'intrinsic');
      assert.equal(out.root.name, name);
      assert.equal(out.proof.find((p) => p.rule === 'select-min-max')?.evidence?.comparisonDomain, 'integer');
      for (const xv of [0n, 1n, 0x7fffffffn, 0x80000000n, 0xffffffffn]) {
        const env = { x: u(xv, bits), y: u(2n, bits) };
        assert.equal(evaluateExpression(out.root, env), evaluateExpression(root, env));
      }
    }
    const absRoot = expr.select(expr.compare('lt', x, zero, true), expr.unary('neg', x, bits, true), x, bits, true);
    assert.equal(rewrite(absRoot).root.name, 'abs');
  }
});

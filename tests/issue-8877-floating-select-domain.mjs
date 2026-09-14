/*
 * #8877 — an FCMP/FCSEL conditional select in the *floating* comparison domain
 * may never be collapsed into the integer-domain `min`/`max` (or `abs`)
 * intrinsic. Truth here is an FP-aware oracle: IEEE-754 ordered predicates on
 * the decoded values, which is exactly what the ARM64 NZCV `fsub` producer
 * models. The repository's integer evaluator is deliberately not the oracle for
 * the floating cases.
 */
import assert from 'node:assert/strict';
import { expr } from '../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { buildNZCVConditionExpression } from '../js/decompiler/flag-semantics.js';
import { evaluateExpression } from '../js/decompiler/verify/equivalence.js';
import { evalBinary, u } from '../js/decompiler/truth/integer.js';
import { printExpression } from '../js/decompiler/pretty/c.js';

const rewrite = (root) => new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: 1000, nodeBudget: 4096 })
  .rewrite(root, { deterministicTransforms: true });
const rulesOf = (out) => out.proof.map((p) => p.rule);

const dv32 = new DataView(new ArrayBuffer(4));
const dv64 = new DataView(new ArrayBuffer(8));
const encode = (value, bits) => {
  if (bits === 32) { dv32.setFloat32(0, value); return BigInt(dv32.getUint32(0)); }
  dv64.setFloat64(0, value); return dv64.getBigUint64(0);
};
const decode = (pattern, bits) => {
  if (bits === 32) { dv32.setUint32(0, Number(u(pattern, 32))); return dv32.getFloat32(0); }
  dv64.setBigUint64(0, u(pattern, 64)); return dv64.getFloat64(0);
};

// FP-aware oracle: IEEE ordered predicates, bitvector-exact arm selection.
function fpTruth(n, env, bits) {
  switch (n.kind) {
    case 'const': return u(n.value, n.bits);
    case 'var': return u(env[n.name], bits);
    case 'compare': {
      if (n.comparisonDomain !== 'floating') {
        const a = fpTruth(n.left, env, bits), b = fpTruth(n.right, env, bits);
        return evalBinary(n.op, a, b, n.left?.bits || bits, n.compareSigned);
      }
      const a = decode(fpTruth(n.left, env, bits), bits);
      const b = decode(fpTruth(n.right, env, bits), bits);
      switch (n.op) {
        case 'lt': return a < b ? 1n : 0n;
        case 'le': return a <= b ? 1n : 0n;
        case 'gt': return a > b ? 1n : 0n;
        case 'ge': return a >= b ? 1n : 0n;
        case 'eq': return a === b ? 1n : 0n;
        case 'ne': return a !== b ? 1n : 0n;
        default: return null;
      }
    }
    case 'select': {
      const q = fpTruth(n.condition, env, bits);
      if (q == null) return null;
      return fpTruth(q === 0n ? n.whenFalse : n.whenTrue, env, bits);
    }
    case 'unary': {
      const a = fpTruth(n.arg, env, bits);
      if (a == null || n.op !== 'neg') return null;
      return u(-u(a, n.bits), n.bits);
    }
    // An integer intrinsic is never a faithful rendering of a floating select.
    case 'intrinsic':
      throw new Error(`integer-domain intrinsic ${n.name} minted from a floating select`);
    default: return null;
  }
}

// Every ordered floating predicate currently produced for an `fsub` producer,
// plus the arm permutations that `select-min-max` recognizes as min/max.
const FLOATING_CONDITIONS = ['mi', 'lo', 'cc', 'ls', 'ge', 'gt'];
const VALUES = [1, -1, 2, -2, 0.5, -0.5, 0, -0, Infinity, -Infinity, NaN, 1e-38, -1e-38, 3.25, -7.75];

let floatChecks = 0;
for (const bits of [32, 64]) {
  const x = expr.variable('x', bits, null);
  const y = expr.variable('y', bits, null);
  for (const cond of FLOATING_CONDITIONS) {
    for (const [xa, ya] of [[x, y], [y, x]]) {
      const condition = buildNZCVConditionExpression('fsub', cond, xa, ya, bits);
      assert.ok(condition && condition.kind === 'compare' && condition.comparisonDomain === 'floating',
        `premise: ${cond} at ${bits} bits must build an ordered floating compare`);
      const root = expr.select(condition, xa, ya, bits, null);
      const out = rewrite(root);

      // 1. The exact FCMP/FCSEL predicate must survive: no integer min/max/abs.
      assert.notEqual(out.root.kind, 'intrinsic',
        `floating ${cond} select was collapsed to ${out.root.kind}/${out.root.name}`);
      assert.equal(out.root.kind, 'select', `floating ${cond} select must be preserved`);
      assert.equal(out.root.condition.comparisonDomain, 'floating',
        `floating ${cond} select must retain its comparison domain`);
      assert.ok(!rulesOf(out).includes('select-min-max'),
        `select-min-max must not be proven for a floating ${cond} select`);
      assert.ok(!out.proof.some((p) => p.evidence?.kind === 'select-comparison-equivalence'),
        `a floating select must not emit a select-comparison-equivalence proof`);

      // 2. The preserved node must still be exactly right for real FP values,
      //    including negative finite pairs, both zeros, infinities and NaN.
      for (let i = 0; i < VALUES.length; i++) {
        for (let j = 0; j < VALUES.length; j++) {
          const env = { x: encode(VALUES[i], bits), y: encode(VALUES[j], bits) };
          const expected = fpTruth(root, env, bits);
          assert.notEqual(expected, null);
          assert.equal(fpTruth(out.root, env, bits), expected,
            `${bits}-bit FCMP/FCSEL ${cond} with x=${VALUES[i]} y=${VALUES[j]}`);
          // And the printer keeps the floating view rather than an integer cast.
          assert.doesNotThrow(() => printExpression(out.root));
          floatChecks++;
        }
      }
    }
  }
}
assert.ok(floatChecks > 5000, `floating corpus too small: ${floatChecks}`);

// 3. The four counterexamples from the report, asserted as raw bit patterns.
{
  const cases = [
    { bits: 32, cond: 'lo', x: -1, y: -2, want: encode(-2, 32) },
    { bits: 32, cond: 'gt', x: -1, y: -2, want: encode(-1, 32) },
    { bits: 64, cond: 'lo', x: -1, y: -2, want: encode(-2, 64) },
    { bits: 64, cond: 'gt', x: -1, y: -2, want: encode(-1, 64) },
  ];
  for (const { bits, cond, x, y, want } of cases) {
    const xv = expr.variable('x', bits, null), yv = expr.variable('y', bits, null);
    const root = expr.select(buildNZCVConditionExpression('fsub', cond, xv, yv, bits), xv, yv, bits, null);
    const out = rewrite(root);
    const env = { x: encode(x, bits), y: encode(y, bits) };
    assert.equal(fpTruth(out.root, env, bits), want,
      `counterexample ${bits}-bit ${cond}: expected ${want.toString(16)}`);
    // The pre-repair node was exactly this integer-domain intrinsic, and it
    // disagrees with the FP truth on ordinary negative values: without the fix
    // this assertion would not hold.
    const corrupted = evaluateExpression(
      expr.intrinsic(cond === 'lo' ? 'min' : 'max', [xv, yv], bits, true), env);
    assert.notEqual(corrupted, want,
      `premise: the integer-domain ${cond === 'lo' ? 'min' : 'max'} reading must be the corrupted result`);
  }
}

// 4. `select-abs` shares the same admission: a floating `x < 0.0` guard must not
//    mint the integer `abs` intrinsic either.
{
  for (const bits of [32, 64]) {
    const x = expr.variable('x', bits, null);
    const zero = expr.constant(0n, bits, true, null, { floating: true });
    const condition = expr.compare('lt', x, zero, true, null, { comparisonDomain: 'floating' });
    const root = expr.select(condition, expr.unary('neg', x, bits, true), x, bits, true);
    assert.equal(root.condition.comparisonDomain, 'floating');
    const out = rewrite(root);
    assert.notEqual(out.root.name, 'abs', 'a floating guarded select must not become integer abs');
    assert.ok(!rulesOf(out).includes('select-abs'));
  }
}

// 5. Integer-domain controls must keep optimizing exactly as before.
{
  for (const bits of [32, 64]) {
    const x = expr.variable('x', bits, null), y = expr.variable('y', bits, null);
    for (const [op, signed, name] of [['lt', true, 'min'], ['gt', true, 'max'], ['lt', false, 'min'], ['ge', false, 'max']]) {
      const condition = expr.compare(op, x, y, signed);
      assert.equal(condition.comparisonDomain, 'integer', 'premise: integer-domain control');
      const root = expr.select(condition, x, y, bits, signed);
      const out = rewrite(root);
      assert.equal(out.root.kind, 'intrinsic', `integer ${op}/${signed ? 'signed' : 'unsigned'} control must collapse`);
      assert.equal(out.root.name, name);
      assert.equal(out.root.signed, signed);
      const evidence = out.proof.find((p) => p.rule === 'select-min-max')?.evidence;
      assert.equal(evidence.comparisonDomain, 'integer', 'proof must record the integer comparison domain');
      for (const xv of [0n, 1n, 0x7fffffffn, 0x80000000n, 0xffffffffn]) {
        for (const yv of [0n, 2n, 0xfffffffen, 0x80000000n]) {
          const env = { x: u(xv, bits), y: u(yv, bits) };
          assert.equal(evaluateExpression(out.root, env), evaluateExpression(root, env),
            'integer-domain control must stay differential-equivalent');
        }
      }
    }
    const zero = expr.constant(0n, bits, true);
    const absRoot = expr.select(expr.compare('lt', x, zero, true), expr.unary('neg', x, bits, true), x, bits, true);
    const absOut = rewrite(absRoot);
    assert.equal(absOut.root.name, 'abs', 'integer-domain abs control must still apply');
  }
}

console.log(`issue-8877 floating select comparison-domain PASS (${floatChecks} FP-oracle checks)`);

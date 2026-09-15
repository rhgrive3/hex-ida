import assert from 'node:assert/strict';
import test from 'node:test';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../../js/decompiler/rewrite/rules.js';
import { evaluateExpression } from '../../js/decompiler/verify/equivalence.js';
import { u } from '../../js/decompiler/truth/integer.js';

const rewrite = (root) => new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: 1000, nodeBudget: 4096 })
  .rewrite(root, { deterministicTransforms: true });
const v = (name, bits, signed = false) => expr.variable(name, bits, signed);
const k = (value, bits, signed = false) => expr.constant(BigInt(value), bits, signed);
const rulesOf = (out) => out.proof.map((p) => p.rule);

function assertEquivalent(root, env) {
  const out = rewrite(root);
  assert.equal(evaluateExpression(out.root, env), evaluateExpression(root, env));
  assert.equal(Number(out.root.bits), Number(root.bits));
  return out;
}

test('#8866 reported cross-width rewrite counterexamples stay value-exact', () => {
  const cases = [
    ['collect-add-constants', expr.binary('add', expr.binary('add', v('x', 8), k(255, 8), 8), k(1, 16), 16), { x: 1n }],
    ['collect-mul-constants', expr.binary('mul', expr.binary('mul', v('x', 8), k(255, 8), 8), k(2, 16), 16), { x: 2n }],
    ['collect-add-sub-constants', expr.binary('sub', expr.binary('add', v('x', 8), k(255, 8), 8), k(1, 16), 16), { x: 1n }],
    ['collect-sub-add-constants', expr.binary('add', expr.binary('sub', v('x', 8), k(1, 8), 8), k(1, 16), 16), { x: 0n }],
    ['collect-sub-sub-constants', expr.binary('sub', expr.binary('sub', v('x', 8), k(1, 8), 8), k(1, 16), 16), { x: 0n }],
  ];
  for (const [rule, root, env] of cases) assert.ok(!rulesOf(assertEquivalent(root, env)).includes(rule));

  const factor = expr.binary('add', expr.binary('mul', v('a', 8), v('x', 8), 8),
    expr.binary('mul', v('a', 8), v('y', 8), 8), 16);
  assert.ok(!rulesOf(assertEquivalent(factor, { a: 200n, x: 2n, y: 2n })).includes('factor-common-left-add'));

  const widenedZero = expr.unary('sext', expr.binary('add', v('x', 8, true), k(0, 16, true), 16, true), 32, true);
  assert.ok(!rulesOf(assertEquivalent(widenedZero, { x: 0xffn })).includes('add-zero-right'));

  const nots = expr.unary('not', expr.unary('not', v('x', 8), 8), 16);
  assert.ok(!rulesOf(assertEquivalent(nots, { x: 0n })).includes('double-bitwise-not'));
});

test('#8866 same-width controls optimize and safe trunc-after-extension cancellation remains enabled', () => {
  for (const bits of [8, 16, 32, 64, 128]) {
    const out = rewrite(expr.binary('add', expr.binary('add', v('x', bits), k(5, bits), bits), k(7, bits), bits));
    assert.ok(rulesOf(out).includes('collect-add-constants'));
    assert.equal(Number(out.root.bits), bits);
  }
  for (const op of ['zext', 'sext']) {
    const x = v('x', 8, op === 'sext');
    const root = expr.unary('trunc', expr.unary(op, x, 16, op === 'sext'), 8, false);
    const out = rewrite(root);
    assert.ok(rulesOf(out).includes(`trunc-after-${op}-to-source-width`));
    for (const value of [0n, 1n, 0x7fn, 0x80n, 0xffn]) {
      assert.equal(evaluateExpression(out.root, { x: value }), evaluateExpression(root, { x: value }));
    }
  }
});

test('#8866 seeded mixed-width differential corpus preserves values and result widths', () => {
  const widths = [8, 16, 32, 64, 128];
  const samples = [0n, 1n, 2n, 127n, 128n, 255n, 0x7fffn, 0xffffn, 0x7fffffffn, 0x80000000n, 0xffffffffn,
    0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn];
  let seed = 0x243f6a88;
  const rnd = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed % n; };
  const pick = (xs) => xs[rnd(xs.length)];
  function gen(depth, variable) {
    const bits = pick(widths), signed = rnd(2) === 0;
    if (depth <= 0 || rnd(5) === 0) return rnd(3) === 0 ? variable : k(pick(samples), bits, signed);
    const inner = gen(depth - 1, variable);
    switch (rnd(9)) {
      case 0: return expr.binary('add', inner, k(pick(samples), bits), bits, signed);
      case 1: return expr.binary('sub', inner, k(pick(samples), bits), bits, signed);
      case 2: return expr.binary('mul', inner, k(pick(samples), bits), bits, signed);
      case 3: return expr.binary('and', inner, k(pick(samples), bits), bits, signed);
      case 4: return expr.binary('or', inner, k(pick(samples), bits), bits, signed);
      case 5: return expr.binary('xor', inner, k(pick(samples), bits), bits, signed);
      case 6: return expr.binary('shl', inner, k(pick([0n, 1n, 3n, 7n, 8n, 16n, 31n, 32n, 64n]), bits), bits, signed);
      case 7: return expr.unary('not', inner, bits, signed);
      default: return expr.unary(rnd(2) ? 'sext' : 'zext', inner, bits, signed);
    }
  }
  const contexts = [
    (n) => n,
    (n) => expr.unary('sext', n, 64, true),
    (n) => expr.unary('zext', n, 64, false),
    (n) => expr.unary('trunc', n, 8, false),
    (n) => expr.binary('add', n, k(0, 64), 64, false),
    (n) => expr.binary('mul', n, k(1, 64), 64, false),
  ];
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const varBits = pick(widths), variable = v('x', varBits, rnd(2) === 0), root = gen(3, variable), out = rewrite(root);
    assert.equal(Number(out.root.bits), Number(root.bits));
    for (const build of contexts) for (let s = 0; s < samples.length; s += 3) {
      const env = { x: u(samples[s], varBits) };
      const a = evaluateExpression(build(root), env), b = evaluateExpression(build(out.root), env);
      if (a == null || b == null) continue;
      assert.equal(b, a);
      checked++;
    }
  }
  assert.ok(checked > 100000, `mixed-width corpus too small: ${checked}`);
});

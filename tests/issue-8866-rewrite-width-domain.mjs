/*
 * #8866 — default decompiler rewrites must not erase fixed-width modular
 * boundaries. Every counterexample is deterministic: it uses the production
 * typed AST, the production RewriteEngine(DEFAULT_RULES), and the repository's
 * own width-exact evaluator as truth.
 */
import assert from 'node:assert/strict';
import { expr } from '../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { evaluateExpression } from '../js/decompiler/verify/equivalence.js';
import { u } from '../js/decompiler/truth/integer.js';

const rewrite = (root) => new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: 1000, nodeBudget: 4096 })
  .rewrite(root, { deterministicTransforms: true });
const v = (name, bits, signed = false) => expr.variable(name, bits, signed);
const k = (value, bits, signed = false) => expr.constant(BigInt(value), bits, signed);
const rulesOf = (out) => out.proof.map((p) => p.rule);

function assertValue(name, root, env, expected) {
  const before = evaluateExpression(root, env);
  assert.equal(before, expected, `${name}: original evaluation drifted`);
  const out = rewrite(root);
  const after = evaluateExpression(out.root, env);
  assert.equal(after, expected, `${name}: rewrite changed the fixed-width value (${before} -> ${after})`);
  return out;
}

const WIDTHS = [8, 16, 32, 64, 128];

// ---- Counterexample A: collect-add-constants erased an 8-bit wrap ----------
{
  const root = expr.binary('add',
    expr.binary('add', v('x', 8), k(255, 8), 8), k(1, 16), 16);
  const out = assertValue('8866-A collect-add', root, { x: 1n }, 1n);
  assert.deepEqual(rulesOf(out), [], 'unsafe cross-width collect-add-constants must not be proven');
}

// ---- Counterexample B: factoring moved multiplication across the boundary --
{
  const env = { a: 200n, x: 2n, y: 2n };
  const root = expr.binary('add',
    expr.binary('mul', v('a', 8), v('x', 8), 8),
    expr.binary('mul', v('a', 8), v('y', 8), 8), 16);
  const out = assertValue('8866-B factor-add', root, env, 288n);
  assert.deepEqual(rulesOf(out), [], 'unsafe cross-width factor-common-left-add must not be proven');

  const subRoot = expr.binary('sub',
    expr.binary('mul', v('a', 8), v('x', 8), 8),
    expr.binary('mul', v('a', 8), v('y', 8, true), 8), 16);
  const subOut = rewrite(subRoot);
  assert.equal(evaluateExpression(subRoot, { a: 200n, x: 2n, y: 0n }),
    evaluateExpression(subOut.root, { a: 200n, x: 2n, y: 0n }),
    'unsafe cross-width factor-common-left-sub must preserve the wrapped child products');
  assert.ok(!rulesOf(subOut).includes('factor-common-left-sub'));
}

// ---- Counterexample C: +0 elimination dropped the result-width authority ---
{
  const root = expr.unary('sext',
    expr.binary('add', v('x', 8, true), k(0, 16, true), 16, true), 32, true);
  const out = assertValue('8866-C add-zero', root, { x: 0xffn }, 255n);
  assert.ok(!rulesOf(out).includes('add-zero-right'),
    'add-zero-right may not return a narrower child for a wider result');
}

// ---- Counterexample D: ~~x collapsed across different widths ---------------
{
  const root = expr.unary('not', expr.unary('not', v('x', 8), 8), 16);
  const out = assertValue('8866-D double-not', root, { x: 0n }, 0xff00n);
  assert.ok(!rulesOf(out).includes('double-bitwise-not'),
    'double-bitwise-not may not collapse mismatched fixed-width NOTs');
}

// ---- Confirmed sibling collection manifestations ---------------------------
{
  const cases = [
    ['collect-mul-constants', expr.binary('mul', expr.binary('mul', v('x', 8), k(255, 8), 8), k(2, 16), 16), { x: 2n }, 508n],
    ['collect-add-sub-constants', expr.binary('sub', expr.binary('add', v('x', 8), k(255, 8), 8), k(1, 16), 16), { x: 1n }, 65535n],
    ['collect-sub-add-constants', expr.binary('add', expr.binary('sub', v('x', 8), k(1, 8), 8), k(1, 16), 16), { x: 0n }, 256n],
    ['collect-sub-sub-constants', expr.binary('sub', expr.binary('sub', v('x', 8), k(1, 8), 8), k(1, 16), 16), { x: 0n }, 254n],
  ];
  for (const [rule, root, env, expected] of cases) {
    const out = assertValue(`8866 sibling ${rule}`, root, env, expected);
    assert.ok(!rulesOf(out).includes(rule), `${rule} must not be proven across mismatched widths`);
  }
}

// ---- Raw constants must be applied at their own declared width -------------
{
  // A constant node's stored value is only authoritative modulo its own width.
  const foldRoot = expr.binary('mul', v('x', 32), k(256, 8), 32);
  const foldOut = rewrite(foldRoot);
  assert.equal(evaluateExpression(foldRoot, { x: 1n }), 0n, 'premise: 256 stored at 8 bits is 0');
  assert.equal(evaluateExpression(foldOut.root, { x: 1n }), 0n,
    'constant folding/idiom lowering may not launder a narrower constant domain');

  const maskRoot = expr.binary('and', v('x', 16), k(0xffff, 8), 16);
  const maskOut = rewrite(maskRoot);
  assert.equal(evaluateExpression(maskRoot, { x: 0xabcdn }), evaluateExpression(maskOut.root, { x: 0xabcdn }),
    'and-full-mask may not treat an out-of-width constant as a full mask');
}

// ---- Same-width controls must still optimize -------------------------------
{
  for (const bits of WIDTHS) {
    const collected = rewrite(expr.binary('add',
      expr.binary('add', v('x', bits), k(5, bits), bits), k(7, bits), bits));
    assert.ok(rulesOf(collected).includes('collect-add-constants'),
      `same-width collect-add-constants must still apply at ${bits} bits`);

    const factored = rewrite(expr.binary('add',
      expr.binary('mul', v('a', bits), v('x', bits), bits),
      expr.binary('mul', v('a', bits), v('y', bits), bits), bits));
    assert.ok(rulesOf(factored).includes('factor-common-left-add'),
      `same-width factor-common-left-add must still apply at ${bits} bits`);

    const identities = [
      ['add-zero-right', expr.binary('add', v('x', bits), k(0, bits), bits)],
      ['sub-zero', expr.binary('sub', v('x', bits), k(0, bits), bits)],
      ['mul-one-right', expr.binary('mul', v('x', bits), k(1, bits), bits)],
      ['or-zero-right', expr.binary('or', v('x', bits), k(0, bits), bits)],
      ['xor-zero-right', expr.binary('xor', v('x', bits), k(0, bits), bits)],
      ['shift-zero-shl', expr.binary('shl', v('x', bits), k(0, bits), bits)],
      ['and-full-mask', expr.binary('and', v('x', bits), k((1n << BigInt(bits)) - 1n, bits), bits)],
      ['double-bitwise-not', expr.unary('not', expr.unary('not', v('x', bits), bits), bits)],
    ];
    for (const [rule, root] of identities) {
      const out = rewrite(root);
      assert.ok(rulesOf(out).includes(rule), `same-width ${rule} control must still apply at ${bits} bits`);
      assert.equal(Number(out.root.bits), Number(root.bits), `${rule} must preserve the result width`);
    }
  }
}

// ---- Seeded mixed-width differential: value + width must survive any context
{
  let seed = 0x243f6a88;
  const rnd = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed % n; };
  const pick = (xs) => xs[rnd(xs.length)];
  const samples = [0n, 1n, 2n, 127n, 128n, 255n, 0x7fffn, 0xffffn, 0x7fffffffn, 0x80000000n, 0xffffffffn,
    0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn];

  function gen(depth, variable) {
    const bits = pick(WIDTHS);
    const signed = rnd(2) === 0;
    if (depth <= 0 || rnd(5) === 0) return rnd(3) === 0 ? variable : k(pick(samples), bits, signed);
    const inner = gen(depth - 1, variable);
    const innerSigned = rnd(2) === 0;
    switch (rnd(9)) {
      case 0: return expr.binary('add', inner, k(pick(samples), bits, innerSigned), bits, signed);
      case 1: return expr.binary('sub', inner, k(pick(samples), bits, innerSigned), bits, signed);
      case 2: return expr.binary('mul', inner, k(pick(samples), bits, innerSigned), bits, signed);
      case 3: return expr.binary('and', inner, k(pick(samples), bits, innerSigned), bits, signed);
      case 4: return expr.binary('or', inner, k(pick(samples), bits, innerSigned), bits, signed);
      case 5: return expr.binary('xor', inner, k(pick(samples), bits, innerSigned), bits, signed);
      case 6: return expr.binary('shl', inner, k(pick([0n, 1n, 3n, 7n, 8n, 16n, 31n, 32n, 64n]), bits, false), bits, signed);
      case 7: return expr.unary('not', inner, bits, signed);
      default: return expr.unary(rnd(2) ? 'sext' : 'zext', inner, bits, signed);
    }
  }

  const contexts = [
    ['plain', (n) => n],
    ['sext64', (n) => expr.unary('sext', n, 64, true)],
    ['zext64', (n) => expr.unary('zext', n, 64, false)],
    ['trunc8', (n) => expr.unary('trunc', n, 8, false)],
    ['add64zero', (n) => expr.binary('add', n, k(0, 64, false), 64, false)],
    ['mul64one', (n) => expr.binary('mul', n, k(1, 64, false), 64, false)],
  ];

  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const varBits = pick(WIDTHS);
    const variable = v('x', varBits, rnd(2) === 0);
    const root = gen(3, variable);
    const out = rewrite(root);
    assert.equal(Number(out.root.bits), Number(root.bits),
      `rewrite ${rulesOf(out).join(',')} changed the declared result width ${root.bits} -> ${out.root.bits}`);
    for (const [label, build] of contexts) {
      const before = build(root), after = build(out.root);
      for (let s = 0; s < samples.length; s += 3) {
        const env = { x: u(samples[s], varBits) };
        const a = evaluateExpression(before, env);
        const b = evaluateExpression(after, env);
        if (a == null || b == null) continue;
        assert.equal(b, a,
          `mixed-width divergence in ${label} context: ${a} -> ${b} (x=${env.x}, rules=${rulesOf(out).join(',')})`);
        checked++;
      }
    }
  }
  assert.ok(checked > 20000, `differential corpus too small: ${checked}`);
  console.log(`issue 8866 rewrite width-domain: ${checked} mixed-width differential checks PASS`);
}

console.log('issue-8866 rewrite width-domain PASS');

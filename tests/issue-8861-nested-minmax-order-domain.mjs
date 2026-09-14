/*
 * #8861 — nested `min`/`max` idempotence must not cross ordering domains.
 * Deterministic: production typed AST, production RewriteEngine(DEFAULT_RULES),
 * and the repository's own width-exact evaluator as truth.
 */
import assert from 'node:assert/strict';
import { expr, structuralKey } from '../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { evaluateExpression } from '../js/decompiler/verify/equivalence.js';
import { u } from '../js/decompiler/truth/integer.js';

const rewrite = (root) => new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: 1000, nodeBudget: 4096 })
  .rewrite(root, { deterministicTransforms: true });
const rulesOf = (out) => out.proof.map((p) => p.rule);
const collapsed = (out) => rulesOf(out).includes('nested-minmax-idempotent');

// inner = op_signed/unsigned(x, y); outer = op_?(inner, y)
const nestedMinMax = (name, innerSigned, outerSigned, bits) => {
  const x = expr.variable('x', bits, null);
  const y = expr.variable('y', bits, null);
  const cmp = name === 'min' ? 'lt' : 'gt';
  const inner = expr.select(expr.compare(cmp, x, y, innerSigned), x, y, bits, innerSigned);
  return expr.select(expr.compare(cmp, inner, y, outerSigned), inner, y, bits, outerSigned);
};

let prng = 0x1234567;
const nextWord = () => { prng ^= prng << 13; prng ^= prng >>> 17; prng ^= prng << 5; prng >>>= 0; return BigInt(prng); };
const DOMAIN_VALUES = {
  32: [0n, 1n, 2n, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0xfffffffen, 0x12345678n]
    .concat(Array.from({ length: 24 }, () => nextWord() & 0xffffffffn)),
  64: [0n, 1n, 2n, 0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn, 0xfffffffffffffffen, 0xdeadbeefn]
    .concat(Array.from({ length: 24 }, () => (nextWord() << 32n) | nextWord())),
};

// 1. Both reported counterexamples, plus every domain permutation, must keep
//    the original nested-select value at both widths.
let differentialChecks = 0;
for (const bits of [32, 64]) {
  for (const name of ['min', 'max']) {
    for (const innerSigned of [true, false]) {
      for (const outerSigned of [true, false]) {
        const root = nestedMinMax(name, innerSigned, outerSigned, bits);
        const out = rewrite(root);
        const sameDomain = innerSigned === outerSigned;
        assert.equal(collapsed(out), sameDomain,
          `${name} ${innerSigned ? 'signed' : 'unsigned'}-inner / ${outerSigned ? 'signed' : 'unsigned'}-outer at ${bits} bits: `
          + `collapse must be ${sameDomain ? 'allowed' : 'refused'}`);
        for (const xv of DOMAIN_VALUES[bits]) {
          for (const yv of DOMAIN_VALUES[bits]) {
            const env = { x: u(xv, bits), y: u(yv, bits) };
            const before = evaluateExpression(root, env);
            const after = evaluateExpression(out.root, env);
            assert.equal(after, before,
              `${name}(${innerSigned}, ${outerSigned}) ${bits}-bit x=${xv} y=${yv}: ${before} -> ${after}`);
            differentialChecks++;
          }
        }
      }
    }
  }
}
assert.ok(differentialChecks > 3000, `differential corpus too small: ${differentialChecks}`);

// 2. The exact issue counterexamples.
{
  const a = rewrite(nestedMinMax('min', true, false, 32));
  const envA = { x: 0xffffffffn, y: 1n };
  assert.equal(evaluateExpression(a.root, envA), 1n, 'counterexample A must stay 0x1');
  const b = rewrite(nestedMinMax('max', true, false, 32));
  const envB = { x: 1n, y: 0xffffffffn };
  assert.equal(evaluateExpression(b.root, envB), 0xffffffffn, 'counterexample B must stay 0xffffffff');
  assert.ok(!rulesOf(a).some((r) => r === 'nested-minmax-idempotent'));
  assert.ok(!rulesOf(b).some((r) => r === 'nested-minmax-idempotent'));
}

// 3. Same-domain controls still collapse and stay differential-equivalent.
for (const signed of [true, false]) {
  for (const name of ['min', 'max']) {
    const out = rewrite(nestedMinMax(name, signed, signed, 64));
    assert.ok(collapsed(out), `same-domain ${name} (${signed ? 'signed' : 'unsigned'}) must still collapse`);
    assert.equal(out.root.name, name);
    assert.equal(out.root.signed, signed);
    const evidence = out.proof.find((p) => p.rule === 'nested-minmax-idempotent')?.evidence;
    assert.ok(evidence, 'accepted collapse must carry a proof record');
    assert.equal(evidence.ordering, signed ? 'signed' : 'unsigned',
      'proof must state the ordering domain that justified idempotence');
    assert.equal(evidence.domainSignature, evidence.innerSignature,
      'proof must record the two matching order signatures');
    for (const xv of DOMAIN_VALUES[64]) {
      const env = { x: xv, y: 0x8000000000000000n };
      assert.equal(evaluateExpression(out.root, env),
        evaluateExpression(nestedMinMax(name, signed, signed, 64), env));
    }
  }
}

// 4. Unknown or contradictory ordering metadata fails closed: no collapse and
//    therefore no `order-idempotence` proof record.
{
  const x = expr.variable('x', 32, null);
  const y = expr.variable('y', 32, null);
  const unknownInner = expr.intrinsic('min', [x, y], 32, null);
  const unknownOuter = expr.intrinsic('min', [unknownInner, y], 32, true);
  const unknownOut = rewrite(unknownOuter);
  assert.ok(!collapsed(unknownOut), 'one-sided unknown ordering metadata must not collapse');
  assert.equal(structuralKey(unknownOut.root), structuralKey(unknownOuter),
    'rejected collapse must preserve the nested expression');
  assert.ok(!rulesOf(unknownOut).includes('nested-minmax-idempotent'));

  const contradictory = expr.intrinsic('min', [expr.intrinsic('max', [x, y], 32, false, null, { compareSigned: true }), y],
    32, false, null, { compareSigned: false });
  // inner claims unsigned result ordering but signed comparison provenance.
  const contradictionOut = rewrite(contradictory);
  assert.ok(!rulesOf(contradictionOut).includes('nested-minmax-idempotent'),
    'contradictory ordering provenance must fail closed');

  const bothUnknown = rewrite(expr.intrinsic('max', [expr.intrinsic('max', [x, y], 32, null), y], 32, null));
  assert.ok(!collapsed(bothUnknown), 'unknown ordering on both sides is still unproven');
}

// 5. Mixed result widths may not be collapsed by the idempotence rule either.
{
  const x = expr.variable('x', 32, null);
  const y = expr.variable('y', 32, null);
  const inner = expr.intrinsic('min', [x, y], 32, true, null, { compareSigned: true });
  const outer = expr.intrinsic('min', [inner, y], 64, true, null, { compareSigned: true });
  const out = rewrite(outer);
  assert.ok(!collapsed(out), 'mixed-width nested min/max must not collapse');
}

// 6. `min(x, x)` idempotence keeps its result width.
{
  const x = expr.variable('x', 32, null);
  const narrow = expr.intrinsic('min', [x, x], 64, true);
  const out = rewrite(narrow);
  assert.ok(!rulesOf(out).includes('idempotent-minmax'),
    'min/max(x,x) may not launder a narrower operand into a wider result');
}

console.log(`issue-8861 nested min/max order-domain PASS (${differentialChecks} differential checks)`);

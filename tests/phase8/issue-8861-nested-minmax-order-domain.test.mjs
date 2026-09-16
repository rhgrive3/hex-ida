import assert from 'node:assert/strict';
import test from 'node:test';
import { expr, structuralKey } from '../../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../../js/decompiler/rewrite/rules.js';
import { evaluateExpression } from '../../js/decompiler/verify/equivalence.js';
import { u } from '../../js/decompiler/truth/integer.js';

const rewrite = (root) => new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: 1000, nodeBudget: 4096 })
  .rewrite(root, { deterministicTransforms: true });
const rulesOf = (out) => out.proof.map((p) => p.rule);
const collapsed = (out) => rulesOf(out).includes('nested-minmax-idempotent');
const nested = (name, innerSigned, outerSigned, bits) => {
  const x = expr.variable('x', bits, null), y = expr.variable('y', bits, null);
  const inner = expr.intrinsic(name, [x, y], bits, innerSigned, null, { compareSigned: innerSigned });
  return expr.intrinsic(name, [inner, y], bits, outerSigned, null, { compareSigned: outerSigned });
};

let prng = 0x1234567;
const nextWord = () => { prng ^= prng << 13; prng ^= prng >>> 17; prng ^= prng << 5; prng >>>= 0; return BigInt(prng); };
const valuesFor = (bits) => {
  const mask = (1n << BigInt(bits)) - 1n;
  const sign = 1n << BigInt(bits - 1);
  return [0n, 1n, 2n, sign - 1n, sign, mask, mask - 1n, 0x12345678n & mask]
    .concat(Array.from({ length: 24 }, () => bits === 32 ? nextWord() : ((nextWord() << 32n) | nextWord()) & mask));
};

test('#8861 nested min/max collapses only inside one proven order domain', () => {
  let checks = 0;
  for (const bits of [32, 64]) {
    const values = valuesFor(bits);
    for (const name of ['min', 'max']) {
      for (const innerSigned of [true, false]) {
        for (const outerSigned of [true, false]) {
          const root = nested(name, innerSigned, outerSigned, bits);
          const out = rewrite(root);
          assert.equal(collapsed(out), innerSigned === outerSigned);
          for (const xv of values) for (const yv of values) {
            const env = { x: u(xv, bits), y: u(yv, bits) };
            assert.equal(evaluateExpression(out.root, env), evaluateExpression(root, env));
            checks++;
          }
        }
      }
    }
  }
  assert.equal(checks, 16384);
});

test('#8861 unknown, contradictory, malformed and mixed-width authority fail closed', () => {
  const x = expr.variable('x', 32, null), y = expr.variable('y', 32, null);
  const reject = (root) => {
    const out = rewrite(root);
    assert.equal(structuralKey(out.root), structuralKey(root));
    assert.ok(!collapsed(out));
    assert.ok(!out.proof.some((p) => p.evidence?.kind === 'order-idempotence'));
  };

  reject(expr.intrinsic('min', [expr.intrinsic('min', [x, y], 32, false, null, { compareSigned: true }), y],
    32, false, null, { compareSigned: true }));
  reject(expr.intrinsic('max', [expr.intrinsic('max', [x, y], 32, false, null, { compareSigned: 'unsigned' }), y],
    32, false, null, { compareSigned: 'unsigned' }));
  reject(expr.intrinsic('min', [expr.intrinsic('min', [x, y], 32, null), y], 32, null));
  reject(expr.intrinsic('max', [expr.intrinsic('max', [x, y], 32, true, null, { compareSigned: true }), y],
    64, true, null, { compareSigned: true }));
});

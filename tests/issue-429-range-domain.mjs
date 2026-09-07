import assert from 'node:assert/strict';
import { expr, structuralKey } from '../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { normalizeIntegerValue, normalizeRangeDomain, rangeWithDomain } from '../js/range-domain.js';

const engine = new RewriteEngine(DEFAULT_RULES, { timeBudgetMs:1000, nodeBudget:4096, maxIterations:16 });
const rw = (e) => engine.rewrite(e).root;
const variable = (name, bits, signed, min, max, rangeSigned = signed) =>
  expr.variable(name, bits, signed, null, { range:{ min:BigInt(min), max:BigInt(max), bits, signed:rangeSigned } });
const constant = (value, bits, signed) => expr.constant(BigInt(value), bits, signed);

for (const bits of [32, 64]) {
  const sign = 1n << BigInt(bits - 1);
  const full = (1n << BigInt(bits)) - 1n;

  // Unsigned high-bit interval becomes a wholly negative signed interval.
  const highUnsigned = variable('u', bits, false, sign, full, false);
  const signedLtZero = expr.compare('lt', highUnsigned, constant(0, bits, true), true);
  const foldedSigned = rw(signedLtZero);
  assert.equal(foldedSigned.kind, 'const');
  assert.equal(foldedSigned.value, 1n, `${bits}-bit unsigned high range is always signed-negative`);

  // Signed-negative interval becomes a high unsigned interval.
  const negativeSigned = variable('s', bits, true, -5n, -1n, true);
  const unsignedGtOne = expr.compare('gt', negativeSigned, constant(1, bits, false), false);
  const foldedUnsigned = rw(unsignedGtOne);
  assert.equal(foldedUnsigned.kind, 'const');
  assert.equal(foldedUnsigned.value, 1n, `${bits}-bit signed negative range is always large unsigned`);

  // Crossing zero in signed space maps to two unsigned intervals. A one-interval
  // proof would be unsound, so the comparison must remain intact.
  const crossing = variable('cross', bits, true, -1n, 1n, true);
  const before = expr.compare('gt', crossing, constant(1, bits, false), false);
  const after = rw(before);
  assert.equal(structuralKey(after), structuralKey(before), `${bits}-bit discontinuous conversion must fail closed`);
}

assert.deepEqual(
  normalizeRangeDomain({ min:0x80000000n, max:0xffffffffn, bits:32, signed:false }, 32, true),
  { min:-0x80000000n, max:-1n, bits:32, signed:true },
);
assert.equal(normalizeRangeDomain({ min:-1n, max:1n, bits:32, signed:true }, 32, false), null);

// #3293: structured/non-number bit widths must not be coerced into valid widths.
assert.equal(normalizeIntegerValue(0x1ffn, '8', false), 0x1ffn);
assert.equal(normalizeIntegerValue(0x1ffn, 8, false), 0xffn);
for (const bits of ['8', true, [32], { valueOf: () => 16 }, NaN, Infinity, 0, -1, 65, 1.5]) {
  assert.equal(rangeWithDomain(0n, 1n, bits, false).bits, 64);
}
for (const bits of [1, 8, 32, 64]) {
  assert.equal(rangeWithDomain(0n, 1n, bits, false).bits, bits);
}

console.log('issue #429/#3293 range-domain regressions passed');

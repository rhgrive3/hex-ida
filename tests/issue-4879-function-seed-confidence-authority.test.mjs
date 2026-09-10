import assert from 'node:assert/strict';
import { isExactFunctionSeed } from '../js/platform/worker-validation.js';
import { analysisFromBinaryImage } from '../js/platform/analysis-result.js';

function imageWith(seed) {
  return {
    format: 'elf',
    symbols: [],
    exports: [],
    imports: [],
    functions: [seed],
    metadata: { functionDiscovery: { complete: true } },
  };
}

const malformed = [
  ['0.95'],
  new Number(0.95),
  true,
  '0.95',
  1n,
  Symbol('0.95'),
  { valueOf() { throw new Error('confidence coercion must not run'); } },
  { toString() { throw new Error('confidence coercion must not run'); } },
];

for (const confidence of malformed) {
  assert.equal(isExactFunctionSeed({
    source: 'entrypoint',
    confidence,
    exactFunctionStart: true,
  }), false, 'structured/coercible generic confidence must not mint exact start authority');
}

for (const exactFunctionStartConfidence of malformed) {
  assert.equal(isExactFunctionSeed({
    source: 'entrypoint',
    confidence: 0.99,
    exactFunctionStart: true,
    exactFunctionStartConfidence,
  }), false, 'malformed exact-start confidence must fail closed');
}

assert.equal(isExactFunctionSeed({ source: 'entrypoint', confidence: 0.9 }), true);
assert.equal(isExactFunctionSeed({ source: 'entrypoint', confidence: 1 }), true);
assert.equal(isExactFunctionSeed({ source: 'entrypoint', confidence: 1.01 }), false);
assert.equal(isExactFunctionSeed({ source: 'entrypoint', confidence: -0.01 }), false);
assert.equal(isExactFunctionSeed({ source: 'entrypoint', confidence: Number.NaN }), false);
assert.equal(isExactFunctionSeed({ source: 'entrypoint', confidence: Number.POSITIVE_INFINITY }), false);
for (const exactFunctionStartConfidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.equal(isExactFunctionSeed({
    source: 'entrypoint', confidence: 0.99, exactFunctionStart: true, exactFunctionStartConfidence,
  }), false, 'out-of-range/non-finite exact-start confidence must fail closed');
}

const structuredStart = analysisFromBinaryImage(imageWith({
  address: 0x1000n,
  end: 0x1010n,
  source: 'entrypoint',
  confidence: ['1'],
  exactFunctionStart: true,
  extentConfidence: 1,
}));
assert.equal(structuredStart.allSeedsExact, false);
assert.equal(structuredStart.functionStartsExact, false);
assert.equal(structuredStart.functionProvenance[0].confirmed, false);
assert.equal(structuredStart.functionProvenance[0].confidence, 0.5);
assert.equal(structuredStart.funcEnds[0], 0n);

const structuredExtent = analysisFromBinaryImage(imageWith({
  address: 0x2000n,
  end: 0x2010n,
  source: 'unwind',
  confidence: 0.99,
  exactFunctionStart: true,
  extentConfidence: ['1'],
}));
assert.equal(structuredExtent.allSeedsExact, true);
assert.equal(structuredExtent.functionStartsExact, true);
assert.equal(structuredExtent.funcEnds[0], 0n, 'structured extent confidence must not mint an exact end');
for (const extentConfidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
  const result = analysisFromBinaryImage(imageWith({
    address: 0x2500n, end: 0x2510n, source: 'unwind', confidence: 0.99, exactFunctionStart: true, extentConfidence,
  }));
  assert.equal(result.funcEnds[0], 0n, 'out-of-range/non-finite extent confidence must fail closed');
}

let coercions = 0;
const hostile = { valueOf() { coercions++; return 1; }, toString() { coercions++; return '1'; } };
const hostileResult = analysisFromBinaryImage(imageWith({
  address: 0x3000n,
  end: 0x3010n,
  source: 'unwind',
  confidence: 0.99,
  exactFunctionStart: true,
  extentConfidence: hostile,
}));
assert.equal(hostileResult.funcEnds[0], 0n);
assert.equal(coercions, 0, 'confidence validation must not invoke coercion hooks');

const valid = analysisFromBinaryImage(imageWith({
  address: 0x4000n,
  end: 0x4010n,
  source: 'unwind',
  confidence: 0.99,
  exactFunctionStart: true,
  extentConfidence: 0.99,
}));
assert.equal(valid.allSeedsExact, true);
assert.equal(valid.functionStartsExact, true);
assert.equal(valid.funcEnds[0], 0x4010n);
assert.equal(valid.functionProvenance[0].confirmed, true);

console.log('issue-4879 function-seed confidence authority: PASS');

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

// Stateful getter regressions: authority-bearing properties must be snapshotted
// strictly once, preventing TOCTOU promotion from non-exact to exact.
{
  let exactReads = 0;
  const statefulStartSeed = {
    address: 0x5000n,
    end: 0x5020n,
    source: 'entrypoint',
    exactFunctionStart: true,
    extentConfidence: 0.99,
    get exactFunctionStartConfidence() {
      exactReads++;
      return exactReads === 1 ? 0.1 : 0.95;
    },
  };
  const result = analysisFromBinaryImage(imageWith(statefulStartSeed));
  assert.equal(exactReads, 1, 'exactFunctionStartConfidence must be sampled strictly once per seed');
  assert.equal(result.allSeedsExact, false);
  assert.equal(result.functionStartsExact, false);
  assert.equal(result.functionProvenance[0].confirmed, false);
  assert.equal(result.funcEnds[0], 0n);
}

{
  let confidenceReads = 0;
  const statefulConfidenceSeed = {
    address: 0x6000n,
    end: 0x6020n,
    source: 'symbol',
    exactFunctionStart: true,
    extentConfidence: 0.99,
    get confidence() {
      confidenceReads++;
      return confidenceReads === 1 ? 0.1 : 0.95;
    },
  };
  const result = analysisFromBinaryImage(imageWith(statefulConfidenceSeed));
  assert.equal(confidenceReads, 1, 'confidence must be sampled strictly once per seed');
  assert.equal(result.allSeedsExact, false);
  assert.equal(result.functionStartsExact, false);
  assert.equal(result.functionProvenance[0].confirmed, false);
  assert.equal(result.funcEnds[0], 0n);
}

{
  let extentReads = 0;
  const statefulExtentSeed = {
    address: 0x7000n,
    end: 0x7020n,
    source: 'entrypoint',
    confidence: 0.99,
    exactFunctionStart: true,
    get extentConfidence() {
      extentReads++;
      return extentReads === 1 ? 0.1 : 0.95;
    },
  };
  const result = analysisFromBinaryImage(imageWith(statefulExtentSeed));
  assert.equal(extentReads, 1, 'extentConfidence must be sampled strictly once per seed');
  assert.equal(result.funcEnds[0], 0n);
}

console.log('issue-4879 function-seed confidence authority: PASS');

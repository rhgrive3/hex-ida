import assert from 'node:assert/strict';
import { isExactFunctionSeed } from '../js/platform/worker-validation.js';
import { analysisFromBinaryImage } from '../js/platform/analysis-result.js';

// 1. valid exact seedsはexactのまま
assert.equal(isExactFunctionSeed({ confidence: 1, exactFunctionStart: true }), true);
assert.equal(isExactFunctionSeed({ confidence: 0.95, source: 'entrypoint' }), true);
assert.equal(isExactFunctionSeed({ confidence: 0.9, source: 'export' }), true);

// 2. structured confidenceはexactへ昇格しない
assert.equal(isExactFunctionSeed({ confidence: ['0.95'], exactFunctionStart: true }), false);
assert.equal(isExactFunctionSeed({ confidence: [1], source: 'entrypoint' }), false);
assert.equal(isExactFunctionSeed({ confidence: { value: 1 }, source: 'entrypoint' }), false);

// 3. boolean/blank/NaN/Infinity/out-of-rangeはexactへ昇格しない
assert.equal(isExactFunctionSeed({ confidence: true, exactFunctionStart: true }), false);
assert.equal(isExactFunctionSeed({ confidence: '0.95', source: 'entrypoint' }), false);
assert.equal(isExactFunctionSeed({ confidence: '', source: 'entrypoint' }), false);
assert.equal(isExactFunctionSeed({ confidence: NaN, source: 'entrypoint' }), false);
assert.equal(isExactFunctionSeed({ confidence: Infinity, source: 'entrypoint' }), false);
assert.equal(isExactFunctionSeed({ confidence: 1.5, source: 'entrypoint' }), false);
assert.equal(isExactFunctionSeed({ confidence: -0.2, source: 'entrypoint' }), false);
assert.equal(isExactFunctionSeed({ confidence: 0.89, source: 'entrypoint' }), false);
assert.equal(isExactFunctionSeed(null), false);
assert.equal(isExactFunctionSeed({}), false);

// 4. source authorityはvalid numeric confidenceの場合のみ維持
assert.equal(isExactFunctionSeed({ confidence: 0.5, source: 'entrypoint' }), false);
assert.equal(isExactFunctionSeed({ confidence: 0.95, source: 'heuristic' }), false);

// 5. malformed seedが1件でもあればallSeedsExact=false / functionStartsExact=false
{
  const image = {
    functions: [
      { address: 0x1000n, confidence: 1, exactFunctionStart: true, source: 'entrypoint' },
      { address: 0x2000n, confidence: [1], source: 'entrypoint' },
    ],
    metadata: { functionDiscovery: { complete: true } },
  };
  const r = analysisFromBinaryImage(image);
  assert.equal(r.allSeedsExact, false);
  assert.equal(r.functionStartsExact, false);
  const byAddr = new Map(r.functionProvenance.map((p, i) => [r.funcs[i].toString(), p]));
  assert.equal(byAddr.get('4096').confirmed, true);
  assert.equal(byAddr.get('8192').confirmed, false);
}

// 6. 全seed validなら既存exactnessを維持
{
  const image = {
    functions: [
      { address: 0x1000n, confidence: 1, exactFunctionStart: true, source: 'entrypoint' },
      { address: 0x2000n, confidence: 0.95, source: 'export' },
    ],
    metadata: { functionDiscovery: { complete: true } },
  };
  const r = analysisFromBinaryImage(image);
  assert.equal(r.allSeedsExact, true);
  assert.equal(r.functionStartsExact, true);
}

// 7. discoveryComplete=falseならfunctionStartsExact=false (独立性維持)
{
  const image = {
    functions: [{ address: 0x1000n, confidence: 1, exactFunctionStart: true }],
    metadata: {},
  };
  const r = analysisFromBinaryImage(image);
  assert.equal(r.allSeedsExact, true);
  assert.equal(r.functionStartsExact, false);
}

console.log('issue #5116 isExactFunctionSeed strict confidence: PASS');

import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFromBinaryImage } from '../js/platform/analysis-result.js';

const exact = {
  address: 0x1000n,
  source: 'function_starts',
  confidence: 1,
  end: 0x1010n,
  extentConfidence: 1,
};

const heuristic = {
  address: 0x1000n,
  source: 'heuristic',
  confidence: 0.5,
};

test('issue #6096 - duplicate seed provenance is order-independent', () => {
  const a = analysisFromBinaryImage({
    format: 'macho',
    functions: [exact, heuristic],
    metadata: { functionDiscovery: { complete: true } },
  });
  const b = analysisFromBinaryImage({
    format: 'macho',
    functions: [heuristic, exact],
    metadata: { functionDiscovery: { complete: true } },
  });
  assert.deepEqual(a.functionProvenance, b.functionProvenance);
});

test('issue #6096 - exact seed is not downgraded by trailing heuristic', () => {
  const a = analysisFromBinaryImage({
    format: 'macho',
    functions: [exact, heuristic],
    metadata: { functionDiscovery: { complete: true } },
  });
  assert.equal(a.functionProvenance[0].confirmed, true);
  assert.equal(a.functionProvenance[0].source, 'function_starts');
  assert.equal(a.functionProvenance[0].confidence, 1);
});

test('issue #6096 - exact extent is kept when heuristic trails', () => {
  const a = analysisFromBinaryImage({
    format: 'macho',
    functions: [exact, heuristic],
    metadata: { functionDiscovery: { complete: true } },
  });
  assert.equal(a.funcEnds[0], 0x1010n);
});

test('issue #6096 - same-strength tie-break is order-independent', () => {
  const s1 = { address: 0x2000n, source: 'heuristic', confidence: 0.5 };
  const s2 = { address: 0x2000n, source: 'heuristic', confidence: 0.5 };
  const a = analysisFromBinaryImage({ format: 'macho', functions: [s1, s2], metadata: {} });
  const b = analysisFromBinaryImage({ format: 'macho', functions: [s2, s1], metadata: {} });
  assert.deepEqual(a.functionProvenance, b.functionProvenance);
});

test('issue #6096 - distinct addresses still sorted', () => {
  const r = analysisFromBinaryImage({
    format: 'macho',
    functions: [
      { address: 0x3000n, source: 'heuristic', confidence: 0.5 },
      { address: 0x1000n, source: 'function_starts', confidence: 1 },
    ],
    metadata: {},
  });
  assert.deepEqual(Array.from(r.funcs), [0x1000n, 0x3000n]);
});

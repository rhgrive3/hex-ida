// Regression for #6096: duplicate function seeds for one address must merge
// by evidence quality, not input order. A trailing heuristic seed must not
// demote exact function-start provenance (and permutations must agree).
import assert from 'node:assert/strict';
import { test } from 'node:test';

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

function analysisFor(order) {
  return analysisFromBinaryImage({
    format: 'macho',
    functions: order,
    metadata: { functionDiscovery: { complete: true } },
  });
}

test('#6096 a trailing heuristic seed does not demote exact provenance', () => {
  const a = analysisFor([exact, heuristic]);
  assert.deepEqual(a.functionProvenance[0], {
    source: 'function_starts',
    confidence: 1,
    confirmed: true,
  });
});

test('#6096 permutations of the same seed set produce identical provenance', () => {
  const a = analysisFor([exact, heuristic]);
  const b = analysisFor([heuristic, exact]);
  assert.deepEqual(a.functionProvenance, b.functionProvenance);
  assert.deepEqual([...a.funcs], [...b.funcs]);
  assert.deepEqual([...a.funcEnds], [...b.funcEnds]);
});

test('#6096 exact extent evidence survives the merge in both orders', () => {
  for (const order of [[exact, heuristic], [heuristic, exact]]) {
    const result = analysisFor(order);
    assert.equal(result.funcEnds[0], 0x1010n);
  }
});

test('#6096 a stronger exact seed replaces an earlier weaker one deterministically', () => {
  const weakFirst = analysisFor([heuristic, exact]);
  assert.equal(weakFirst.functionProvenance[0].confirmed, true);
  assert.equal(weakFirst.functionProvenance[0].source, 'function_starts');
});

test('#6096 equal-strength seeds use a deterministic source-name tie-break', () => {
  const first = { ...heuristic, source: 'zeta-provider' };
  const second = { ...heuristic, source: 'alpha-provider' };
  const a = analysisFor([first, second]);
  const b = analysisFor([second, first]);
  assert.equal(a.functionProvenance[0].source, 'alpha-provider');
  assert.deepEqual(a.functionProvenance, b.functionProvenance);
});

test('#6096 conflicting exact ends are discarded in either input order', () => {
  const conflict = { ...exact, end: 0x1020n };
  const a = analysisFor([exact, conflict]);
  const b = analysisFor([conflict, exact]);
  assert.deepEqual([...a.funcEnds], [0n]);
  assert.deepEqual([...b.funcEnds], [0n]);
});

test('#6096 distinct starts remain sorted in typed-array output', () => {
  const high = { ...exact, address: 0x1200n, end: 0x1210n };
  const low = { ...exact, address: 0x1000n, end: 0x1010n };
  const result = analysisFor([high, low]);
  assert.ok(result.funcs instanceof BigUint64Array);
  assert.ok(result.funcEnds instanceof BigUint64Array);
  assert.deepEqual([...result.funcs], [0x1000n, 0x1200n]);
  assert.deepEqual([...result.funcEnds], [0x1010n, 0x1210n]);
});

test('#6096 confidence ranking and provenance use the same null/nonfinite defaults', () => {
  const nullExact = {
    ...exact,
    source: 'a-null',
    confidence: null,
    exactFunctionStartConfidence: 1,
  };
  const finiteExact = {
    ...exact,
    source: 'z-finite',
    confidence: 0.5,
    exactFunctionStartConfidence: 1,
  };
  const selectedNull = analysisFor([finiteExact, nullExact]).functionProvenance[0];
  assert.deepEqual(selectedNull, { source: 'a-null', confidence: 1, confirmed: true });

  const nanExact = { ...exact, confidence: Number.NaN, exactFunctionStartConfidence: 1 };
  const infExact = { ...exact, confidence: Number.POSITIVE_INFINITY, exactFunctionStartConfidence: 1 };
  assert.equal(analysisFor([nanExact]).functionProvenance[0].confidence, 1);
  assert.equal(analysisFor([infExact]).functionProvenance[0].confidence, 1);
  assert.equal(analysisFor([{ ...heuristic, confidence: null }]).functionProvenance[0].confidence, 0.5);
});

test('#6096 allSeedsExact reports raw input evidence before deduplication', () => {
  const mixed = analysisFor([exact, heuristic]);
  assert.equal(mixed.allSeedsExact, false);
  assert.equal(mixed.functionStartsExact, false);

  const allExact = analysisFor([exact, { ...exact, source: 'unwind' }]);
  assert.equal(allExact.allSeedsExact, true);
  assert.equal(allExact.functionStartsExact, true);
});

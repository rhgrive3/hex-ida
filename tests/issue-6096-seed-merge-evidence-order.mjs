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

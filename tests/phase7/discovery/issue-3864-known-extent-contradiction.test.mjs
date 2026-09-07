import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFunctionCandidate,
  hasKnownExtent,
} from '../../../js/analysis/discovery/candidates.js';

const REGION = Object.freeze({
  start: 0x1000n,
  end: 0x1010n,
  ownership: 'exclusive',
});

function candidate(extentState, regions = [REGION], extra = {}) {
  return createFunctionCandidate({
    start: 0x1000n,
    extentState,
    regions,
    ...extra,
  });
}

test('hasKnownExtent rejects contradicted extents without weakening other extent states', () => {
  for (const extentState of ['exact', 'probable', 'heuristic']) {
    assert.equal(hasKnownExtent(candidate(extentState)), true, extentState);
  }

  const contradicted = candidate('contradicted');
  assert.equal(contradicted.extentState, 'contradicted');
  assert.equal(contradicted.regions.length, 1);
  assert.equal(hasKnownExtent(contradicted), false);

  const unknown = candidate('unknown', [REGION], { allowRegionsWithUnknownExtent: true });
  assert.equal(hasKnownExtent(unknown), false);

  for (const extentState of ['exact', 'probable', 'heuristic', 'contradicted']) {
    assert.equal(hasKnownExtent(candidate(extentState, [])), false, `${extentState}:empty`);
  }
});

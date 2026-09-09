import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadFrozenBaseline,
  loadFrozenProvenance,
  safetyCounters,
} from '../../../tools/validation/phase8/metrics.mjs';

const baseline = loadFrozenBaseline();
const frozenProvenance = loadFrozenProvenance(undefined, baseline);
const before = baseline.observations.find((observation) => observation.semantic === true);
assert.ok(before, 'fixture needs one semantic baseline observation');

function candidate(renderProvenance) {
  return { ...before, renderProvenance };
}

function completeRenderProvenance(overrides = {}) {
  return {
    version:1,
    snapshotId:'snapshot:test',
    completeness:'complete',
    reasons:[],
    entities:1,
    provenanceLoss:0,
    truncated:false,
    ...overrides,
  };
}

test('P8-PROV safety counters admit only complete bound render provenance', () => {
  const accepted = safetyCounters(
    [candidate(completeRenderProvenance())], baseline, frozenProvenance);
  assert.equal(accepted.unknownSafetyRegressionCount, 0);
  assert.equal(accepted.renderProvenanceLossCount, 0);
  assert.equal(accepted.renderProvenanceUnboundCount, 0);

  const cases = [
    ['missing map', null, 1, 1],
    ['reported loss', completeRenderProvenance({ provenanceLoss:2 }), 2, 0],
    ['unbound map', completeRenderProvenance({ snapshotId:null }), 0, 1],
    ['truncated map', completeRenderProvenance({ completeness:'incomplete', reasons:['truncated'], truncated:true }), 0, 0],
    ['cancelled map', completeRenderProvenance({ completeness:'incomplete', reasons:['cancelled'] }), 0, 0],
    ['malformed loss count', completeRenderProvenance({ provenanceLoss:'0' }), 1, 0],
  ];

  for (const [label, renderProvenance, expectedLoss, expectedUnbound] of cases) {
    const counters = safetyCounters([candidate(renderProvenance)], baseline, frozenProvenance);
    assert.equal(counters.unknownSafetyRegressionCount, 1,
      `${label} must trip the existing frozen hard-zero counter`);
    assert.equal(counters.renderProvenanceLossCount, expectedLoss, `${label}: loss counter`);
    assert.equal(counters.renderProvenanceUnboundCount, expectedUnbound, `${label}: unbound counter`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessJevEligibility, fallbackToLocalPinpointResult, JEV_REASON, JEV_PIPELINE,
} from '../js/pinpoint-jev-eligibility.js';

const eligible = () => ({
  queryMode: 'partial', candidateLattice: 'complete', candidateCount: 2,
  localVerdict: 'ambiguous', deterministicEvidence: 'unresolved', highImpact: true,
});

test('Jev eligibility admits only a high-impact unresolved partial ambiguity', () => {
  const result = assessJevEligibility(eligible());
  assert.equal(result.eligible, true);
  assert.equal(result.reason, JEV_REASON.ELIGIBLE);
  assert.deepEqual(JEV_PIPELINE, [
    'candidate-lattice', 'deterministic-ranking-and-evidence', 'unresolved-ambiguity-only',
    'jev-assist', 'fail-closed-verdict',
  ]);
});

test('Jev eligibility never calls for exact, strong, recall-broken, or low-impact cases', () => {
  const cases = [
    [{ ...eligible(), queryMode: 'exact' }, JEV_REASON.EXACT],
    [{ ...eligible(), localVerdict: 'likely' }, JEV_REASON.VERDICT],
    [{ ...eligible(), localVerdict: 'confirmed' }, JEV_REASON.VERDICT],
    [{ ...eligible(), candidateLattice: 'truncated' }, JEV_REASON.RECALL],
    [{ ...eligible(), candidateCount: 1 }, JEV_REASON.CANDIDATES],
    [{ ...eligible(), deterministicEvidence: 'decisive' }, JEV_REASON.DECISIVE],
    [{ ...eligible(), highImpact: false }, JEV_REASON.IMPACT],
    [{ ...eligible(), highImpact: 1 }, JEV_REASON.IMPACT],
  ];
  for (const [input, reason] of cases) {
    const result = assessJevEligibility(input);
    assert.equal(result.eligible, false, reason);
    assert.equal(result.reason, reason);
  }
});

test('Jev eligibility excludes parser/lifter/function-extent failures and malformed input', () => {
  for (const [input, reason] of [
    [{ ...eligible(), parserFailure: true }, JEV_REASON.PARSER],
    [{ ...eligible(), lifterFailure: true }, JEV_REASON.LIFTER],
    [{ ...eligible(), functionExtentFailure: true }, JEV_REASON.EXTENT],
    [null, JEV_REASON.INVALID],
    [{ ...eligible(), candidateCount: '2' }, JEV_REASON.CANDIDATES],
  ]) {
    const result = assessJevEligibility(input);
    assert.equal(result.eligible, false, reason);
    assert.equal(result.reason, reason);
  }
});

test('Jev failure fallback is identity-preserving and cannot replace the local verdict', () => {
  const local = Object.freeze({ verdict: 'ambiguous', top: { key: 'local-top' } });
  assert.equal(fallbackToLocalPinpointResult(local), local);
});

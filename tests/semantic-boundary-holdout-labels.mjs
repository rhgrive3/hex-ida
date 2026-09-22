/*
 * Regression for the labelled boundary holdout's own labels.
 *
 * The failure this exists for is silent: a case labelled "the truth is at rank
 * 4" passes every check the first harness version made, because ranks 1..4 are
 * always inside the baseline D1..D4 verification set. The label can therefore
 * never be contradicted, the case reports `labelsConsistent: true`, and its
 * measurements become evidence they are not. The same applies to a declared
 * oracle whose response the contract rejects: the one-probe ceiling stays
 * unmeasured while the case still looks green.
 *
 * These checks need no game artifact, so they run in the ordinary gate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BOUNDARY_FIRST_RANK, evaluateHoldoutLabels } from './fixtures/real-holdout-labels.mjs';

const MANIFEST = JSON.parse(fs.readFileSync(
  new URL('./fixtures/real-game-boundary-holdout.manifest.json', import.meta.url), 'utf8',
));
const CASE = MANIFEST.cases[0];
const OBSERVED = MANIFEST.observed;
const BOUNDARY_ORDER = OBSERVED.boundaryOrder.map(String);
const RANK = CASE.expectedDeterministicRank;

function measurementFromObserved() {
  return {
    rankedShapeScores: OBSERVED.rankedShapeScores,
    rankedCandidateOffsets: BOUNDARY_ORDER,
    finalTopOffset: String(OBSERVED.deterministicTopOffset),
    oracle: {
      refereeStatus: OBSERVED.oracleCeiling.refereeStatus,
      probeCandidateId: OBSERVED.oracleCeiling.probeCandidateId,
      probeAttempted: true,
    },
  };
}

/* 1. The committed fixture must describe itself consistently. */
assert.equal(BOUNDARY_ORDER.length, CASE.expectedCandidateCount, 'boundary order must cover every candidate');
assert.ok(RANK >= BOUNDARY_FIRST_RANK, 'a truth inside ranks 1..3 can never be reached by the referee');
assert.equal(
  BOUNDARY_ORDER[RANK - 1], String(CASE.offset),
  'the labelled rank must be where the labelled truth sits in the recorded boundary order',
);
assert.equal(
  CASE.oracleChallengerId, `c${RANK - BOUNDARY_FIRST_RANK}`,
  'a declared oracle must name the labelled rank inside the boundary set',
);
assert.equal(
  OBSERVED.oracleCeiling.probeCandidateId, `d${RANK}`,
  'the recorded ceiling must be a probe of the labelled rank',
);

/* 2. Positive control: the recorded measurement satisfies every label check. */
const accepted = evaluateHoldoutLabels({ caseDef: CASE, measurement: measurementFromObserved() });
assert.equal(accepted.labelsConsistent, true, `every recorded label check must pass: ${JSON.stringify(accepted.labelChecks)}`);
assert.deepEqual(accepted.labelChecks, {
  candidateCountMatches: true,
  rankWithinCandidates: true,
  truthRankMatchesBoundaryOrder: true,
  reachabilityClaimMatchesRank: true,
  deterministicTopClaimMatchesMeasurement: true,
  deterministicTopReproduced: true,
  oracleProbeTargetsLabelledRank: true,
  oracleCeilingMeasured: true,
});

/* 3. The regression: a rank that always sits in the baseline set must fail. */
for (const unfalsifiableRank of [1, 2, 3, 4]) {
  const relabelled = evaluateHoldoutLabels({
    caseDef: { ...CASE, expectedDeterministicRank: unfalsifiableRank, oracleChallengerId: `c${RANK - BOUNDARY_FIRST_RANK}` },
    measurement: measurementFromObserved(),
  });
  assert.equal(
    relabelled.labelChecks.truthRankMatchesBoundaryOrder, false,
    `rank ${unfalsifiableRank} is not where the truth sits and must be rejected`,
  );
  assert.equal(relabelled.labelsConsistent, false, `rank ${unfalsifiableRank} must not produce evidence`);
}

/* A rank that is not a boundary rank cannot claim reachability. */
const claimedUnreachable = evaluateHoldoutLabels({
  caseDef: { ...CASE, expectedDeterministicRank: 1, boundaryTruthReachable: true, oracleChallengerId: 'c1' },
  measurement: measurementFromObserved(),
});
assert.equal(claimedUnreachable.labelChecks.reachabilityClaimMatchesRank, false);
assert.equal(claimedUnreachable.labelsConsistent, false);

/* 4. A declared oracle that was never admitted leaves the ceiling unmeasured. */
for (const rejected of [
  { refereeStatus: 'invalid-response', probeCandidateId: null, probeAttempted: false },
  { refereeStatus: 'not-admitted:margin', probeCandidateId: null, probeAttempted: false },
  { refereeStatus: 'probe-promoted-by-binary-evidence', probeCandidateId: 'd6', probeAttempted: true },
]) {
  const silent = evaluateHoldoutLabels({
    caseDef: CASE,
    measurement: { ...measurementFromObserved(), oracle: rejected },
  });
  assert.equal(silent.labelsConsistent, false, `a ceiling that was not measured must fail: ${JSON.stringify(rejected)}`);
  assert.equal(silent.labelChecks.oracleCeilingMeasured, rejected.probeAttempted === true);
}

/* 5. Missing instrumentation fails closed instead of passing by absence. */
const uninstrumented = evaluateHoldoutLabels({
  caseDef: CASE,
  measurement: { rankedShapeScores: OBSERVED.rankedShapeScores, rankedCandidateOffsets: null, finalTopOffset: '148', oracle: null },
});
assert.equal(uninstrumented.labelChecks.truthRankMatchesBoundaryOrder, false);
assert.equal(uninstrumented.labelChecks.candidateCountMatches, false);
assert.equal(uninstrumented.labelsConsistent, false);

process.stdout.write('semantic-boundary-holdout-labels: ok\n');

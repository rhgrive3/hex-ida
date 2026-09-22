/*
 * Label checks for a labelled boundary holdout, kept out of the opt-in harness
 * so they are exercisable without the pinned game artifact.
 *
 * A promotion decision may only rest on cases whose labels are *falsifiable*:
 * every claim a manifest makes has to be contradicted by the measurement when
 * it is wrong.  The rank claim is the one that matters most, and two ways of
 * checking it are wrong:
 *
 *   1. Checking membership in the baseline verification set.  Ranks 1..4 are
 *      always verified, so a "rank 4" label can never fail — the check looks
 *      green no matter where the truth actually sits.
 *   2. Checking against the final fusion order.  The referee's candidate ids
 *      are allocated from the boundary order (shape score per rank), which is
 *      not the fusion order, so a truth at fusion rank 4 can be boundary rank 5.
 *
 * The rank is therefore checked against `rankedCandidateOffsets`, the boundary
 * order itself, and a declared oracle challenger must actually have been
 * admitted and probed at that rank — otherwise the case documents a ceiling it
 * never measured.
 */

/* The boundary set given to the referee starts at rank 4, so only a truth at
 * rank 4 or later can be reached by a challenger at all. */
export const BOUNDARY_FIRST_RANK = 4;

function finiteRank(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 1
    ? value
    : null;
}

/**
 * @param {object} o
 * @param {object} o.caseDef              labelled case from the manifest
 * @param {object} o.measurement          measurements for that case
 * @param {number[]|null} o.measurement.rankedShapeScores
 * @param {string[]|null} o.measurement.rankedCandidateOffsets
 * @param {string|null}   o.measurement.finalTopOffset
 * @param {object|null}   o.measurement.oracle  `oracleChallengerId` variant, if it ran
 */
export function evaluateHoldoutLabels({ caseDef = {}, measurement = {} } = {}) {
  const rank = finiteRank(caseDef.expectedDeterministicRank);
  const scores = Array.isArray(measurement.rankedShapeScores) ? measurement.rankedShapeScores : null;
  const offsets = Array.isArray(measurement.rankedCandidateOffsets) ? measurement.rankedCandidateOffsets : null;
  const truthOffset = String(caseDef.offset);
  const oracleDeclared = typeof caseDef.oracleChallengerId === 'string' && caseDef.oracleChallengerId.length > 0;
  const oracle = measurement.oracle || null;
  // Only a truth at rank >= 4 sits inside the boundary set the referee is
  // handed, and a declared oracle challenger is only meaningful there.
  const truthReachableByRank = rank != null && rank >= BOUNDARY_FIRST_RANK;

  const labelChecks = {
    candidateCountMatches: Array.isArray(scores)
      && scores.length === caseDef.expectedCandidateCount
      && Array.isArray(offsets) && offsets.length === scores.length,
    rankWithinCandidates: rank != null && Array.isArray(scores) && rank <= scores.length,
    // The whole point: the labelled rank has to be the boundary-order rank the
    // truth offset actually occupies.
    truthRankMatchesBoundaryOrder: rank != null && Array.isArray(offsets)
      && rank <= offsets.length && offsets[rank - 1] === truthOffset,
    reachabilityClaimMatchesRank: (caseDef.boundaryTruthReachable === true) === truthReachableByRank,
    deterministicTopClaimMatchesMeasurement: (caseDef.deterministicTopIsTruth === true)
      === (measurement.finalTopOffset === truthOffset),
    deterministicTopReproduced: measurement.finalTopOffset === String(caseDef.deterministicTopOffset),
    // When the oracle runs it names the boundary id it forced; that id must be
    // the rank the manifest labelled, which proves the rank label is real.
    oracleProbeTargetsLabelledRank: oracleDeclared && rank != null
      ? oracle?.probeCandidateId === `d${rank}`
      : true,
    // A declared oracle that was never admitted (for example a response the
    // contract rejected) leaves the one-probe ceiling unmeasured, which must be
    // a label failure rather than a silent zero.
    oracleCeilingMeasured: oracleDeclared
      ? oracle?.refereeStatus !== 'invalid-response' && oracle?.probeAttempted === true
      : true,
  };

  return {
    rank,
    truthReachableByRank,
    labelChecks,
    labelsConsistent: Object.values(labelChecks).every(Boolean),
  };
}

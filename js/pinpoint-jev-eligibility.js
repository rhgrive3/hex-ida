/*
 * Cheap, fail-closed boundary for a future Jev assist.
 *
 * This module deliberately does not call Jev and does not change ranking or a
 * verdict.  An orchestrator may ask for assistance only after the complete
 * deterministic candidate lattice/ranking/evidence pass has reported an
 * unresolved, high-impact partial-query ambiguity.  Any missing authority is
 * an ineligible result.
 */

export const JEV_ELIGIBILITY_VERSION = 'pinpoint-jev-eligibility/v1';

export const JEV_PIPELINE = Object.freeze([
  'candidate-lattice',
  'deterministic-ranking-and-evidence',
  'unresolved-ambiguity-only',
  'jev-assist',
  'fail-closed-verdict',
]);

export const JEV_REASON = Object.freeze({
  ELIGIBLE: 'eligible-unresolved-high-impact-partial',
  INVALID: 'invalid-input',
  EXACT: 'exact-query',
  RECALL: 'candidate-lattice-not-sufficient',
  PARSER: 'parser-failure',
  LIFTER: 'lifter-failure',
  EXTENT: 'function-extent-failure',
  VERDICT: 'local-verdict-not-ambiguous',
  CANDIDATES: 'not-a-multi-candidate-ambiguity',
  DECISIVE: 'deterministic-evidence-not-unresolved',
  IMPACT: 'not-high-impact',
});

function safeCandidateCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Return a structured decision so callers can audit why no external model was
 * contacted.  Only literal `true` enables the high-impact path; truthy values
 * and unrecognised enums never grant authority.
 */
export function assessJevEligibility(input) {
  if (!input || typeof input !== 'object') return { eligible: false, reason: JEV_REASON.INVALID };
  if (input.queryMode !== 'partial') return { eligible: false, reason: JEV_REASON.EXACT };
  if (input.candidateLattice !== 'complete') return { eligible: false, reason: JEV_REASON.RECALL };
  if (input.parserFailure === true) return { eligible: false, reason: JEV_REASON.PARSER };
  if (input.lifterFailure === true) return { eligible: false, reason: JEV_REASON.LIFTER };
  if (input.functionExtentFailure === true) return { eligible: false, reason: JEV_REASON.EXTENT };
  if (input.localVerdict !== 'ambiguous') return { eligible: false, reason: JEV_REASON.VERDICT };
  const candidates = safeCandidateCount(input.candidateCount);
  if (candidates === null || candidates < 2) return { eligible: false, reason: JEV_REASON.CANDIDATES };
  if (input.deterministicEvidence !== 'unresolved') return { eligible: false, reason: JEV_REASON.DECISIVE };
  if (input.highImpact !== true) return { eligible: false, reason: JEV_REASON.IMPACT };
  return { eligible: true, reason: JEV_REASON.ELIGIBLE, version: JEV_ELIGIBILITY_VERSION };
}

/**
 * The only mandatory integration fallback: transport failures, timeouts,
 * malformed replies, and low-confidence replies retain the exact local result.
 * Keeping this identity-preserving helper separate prevents an integration
 * layer from accidentally substituting an invented candidate on failure.
 */
export function fallbackToLocalPinpointResult(localResult) {
  return localResult;
}

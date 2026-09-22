/*
 * OpenJev boundary-referee contracts.
 *
 * This module deliberately has no fetch, Cloudflare, evidence, or verdict
 * dependency.  It only prepares a compact observation packet and validates a
 * model preference before the caller decides whether a bounded binary probe is
 * worth spending.  In particular, probabilities returned here are never
 * evidence and must never be fused into a Hex result.
 */

/* Verified against the live service: the only offered System One model is
 * `openjev` (GET https://api.openjev.sh/v1/models).  Pinning the exact id keeps
 * an alias change from silently altering a Hex verdict. */
export const OPENJEV_BOUNDARY_MODEL = 'openjev';
export const SEMANTIC_BOUNDARY_MAX_CANDIDATES = 8;
export const SEMANTIC_BOUNDARY_MIN_CANDIDATES = 5;
export const SEMANTIC_BOUNDARY_AMBIGUITY_SCHEMA = 'hex-semantic-boundary-ambiguity/v1';
export const SEMANTIC_BOUNDARY_ADMISSION_SCHEMA = 'hex-semantic-boundary-admission/v1';

/*
 * `free` is the free-form goal: `parseGoal` maps anything that does not match a
 * preset to `{ id: 'free', free: true, text: raw }`, so the user's own words are
 * the semantic target.  It is measured as the mainstream path on real binaries
 * -- 192 of 196 sampled partial-name queries -- and it is the only goal whose
 * failures this referee is ever in a position to see.
 */
const SUPPORTED_SHAPE_GOALS = new Set([
  'attack', 'damage', 'hp', 'stamina', 'money', 'score', 'level', 'item', 'free',
]);
const METHODS = new Set(['choice', 'noul']);
const CANDIDATE_ID = /^c[0-7]$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteInteger(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function boundedText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
}

function unitInterval(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sourceOf(candidate) {
  return candidate?.shape && typeof candidate.shape === 'object' ? candidate.shape : candidate;
}

function siteCounts(candidate) {
  const sites = Array.isArray(candidate?.sites) ? candidate.sites : [];
  let loads = 0;
  let stores = 0;
  for (const site of sites) {
    loads += finiteInteger(site?.loads);
    stores += finiteInteger(site?.stores);
  }
  return { loads, stores };
}

function knownFunctionCount(candidate) {
  const functions = Array.isArray(candidate?.functions) ? candidate.functions : [];
  const known = new Set();
  for (const fn of functions) {
    if (fn?.addr == null) continue;
    try { known.add(BigInt(fn.addr).toString()); } catch { /* malformed local fact is omitted */ }
  }
  return known.size;
}

/**
 * Convert an internal shape candidate into the only fact schema permitted to
 * leave the browser.  This is intentionally an explicit allow-list: addresses,
 * offsets, scores, ranks, role labels, disassembly, and symbols cannot leak by
 * adding fields to the internal candidate object.
 */
export function semanticBoundaryCandidateFacts(candidate, id, { complete = false } = {}) {
  if (!CANDIDATE_ID.test(String(id || ''))) return null;
  const source = sourceOf(candidate);
  if (!source || typeof source !== 'object') return null;
  const counts = siteCounts(candidate);
  return {
    id: String(id),
    size: finiteInteger(source.size),
    decreases: finiteInteger(source.decreases),
    increases: finiteInteger(source.increases),
    clamped: finiteInteger(source.clamped),
    crossObject: finiteInteger(source.crossObject),
    scaled: finiteInteger(source.scaled),
    usedAsAmount: finiteInteger(source.usedAsAmount),
    usedCross: finiteInteger(source.usedCross),
    usedScaled: finiteInteger(source.usedScaled),
    functionCount: knownFunctionCount(candidate),
    loadCount: counts.loads,
    storeCount: counts.stores,
    identityKnown: source.identityKnown === true,
    completeness: complete === true && source.complete !== false,
  };
}

export function semanticBoundaryGoal(goal) {
  const id = typeof goal?.id === 'string' ? goal.id : '';
  if (!SUPPORTED_SHAPE_GOALS.has(id)) return null;
  /* For a free-form goal `text` is the user's raw query; for a preset it is the
     calibrated label.  Either way this is the only goal wording the model sees.
     The packet stays `{ id, label }` on purpose: whether the goal was preset or
     free-form is not something the model needs to know. */
  const label = boundedText(goal?.label || goal?.text || id, 160) || id;
  return { id, label };
}

/**
 * The caller supplies exactly D4..D8 (or the available suffix).  IDs are
 * allocated locally and have no relationship to an address, offset, rank, or
 * score outside this transient request.
 */
/*
 * Model-facing goal guidance.
 *
 * The wording below is the only place a semantic expectation about a goal
 * reaches the model, so it is calibrated from a labelled holdout rather than
 * written from intuition.  Each entry records the fixture that justified it,
 * and a regression asserts that every named fixture exists and actually labels
 * that goal, so an unvalidated prompt cannot be added silently.
 */
const DEPLETABLE_VITAL_POOL_GUIDANCE = ' A vital depletable resource is clamped so it cannot fall below zero and is driven by loss more often than by recovery: prefer the candidate whose decrease count strictly exceeds its increase count. A candidate with as many increases as decreases is an auxiliary or effect-driven pool, not the answer.';

export const SEMANTIC_BOUNDARY_GOAL_GUIDANCE = Object.freeze({
  hp: Object.freeze({ family: 'depletable-vital-pool', calibratedBy: 'openmw-boundary-holdout', text: DEPLETABLE_VITAL_POOL_GUIDANCE }),
  stamina: Object.freeze({ family: 'depletable-vital-pool', calibratedBy: 'openmw-boundary-holdout', text: DEPLETABLE_VITAL_POOL_GUIDANCE }),
});

/**
 * Empty for every goal without calibrated guidance, so an unmeasured goal keeps
 * the neutral wording instead of inheriting another goal's expectation.
 */
export function semanticBoundaryGoalGuidance(goalId) {
  if (typeof goalId !== 'string' || !Object.hasOwn(SEMANTIC_BOUNDARY_GOAL_GUIDANCE, goalId)) return '';
  const entry = SEMANTIC_BOUNDARY_GOAL_GUIDANCE[goalId];
  return typeof entry?.text === 'string' ? entry.text : '';
}

export function buildSemanticBoundaryRequest({ goal, candidates, complete = false } = {}) {
  const safeGoal = semanticBoundaryGoal(goal);
  if (!safeGoal || !Array.isArray(candidates) || candidates.length < 2 || candidates.length > 5) return null;
  const facts = candidates.map((candidate, index) => semanticBoundaryCandidateFacts(candidate, `c${index}`, { complete }));
  if (facts.some((candidate) => candidate == null)) return null;
  return { goal: safeGoal, candidates: facts };
}

function scoreOf(candidate) {
  const score = Number(sourceOf(candidate)?.score);
  return Number.isFinite(score) && score >= 0 ? score : null;
}

/** Internal-only deterministic measurements.  Never pass this object to a referee. */
export function deterministicBoundaryMetrics(candidates) {
  if (!Array.isArray(candidates) || candidates.length < SEMANTIC_BOUNDARY_MIN_CANDIDATES) return null;
  const d4Score = scoreOf(candidates[3]);
  const d5Score = scoreOf(candidates[4]);
  if (d4Score == null || d5Score == null) return null;
  return {
    candidateCount: candidates.length,
    d4Score,
    d5Score,
    gap: Math.abs(d4Score - d5Score),
  };
}

/**
 * An ambiguity policy is intentionally supplied by a labelled holdout, rather
 * than baked into the scorer.  No policy means no network call.  This keeps a
 * future promotion from being accidentally enabled by an intuitive threshold.
 */
export function normalizeSemanticBoundaryAmbiguityPolicy(policy) {
  if (!isPlainObject(policy) || policy.schema !== SEMANTIC_BOUNDARY_AMBIGUITY_SCHEMA) return null;
  if (!unitInterval(policy.maxD4D5Gap)) return null;
  if (policy.minD4Score != null && !unitInterval(policy.minD4Score)) return null;
  return Object.freeze({
    schema: SEMANTIC_BOUNDARY_AMBIGUITY_SCHEMA,
    maxD4D5Gap: policy.maxD4D5Gap,
    minD4Score: policy.minD4Score == null ? 0 : policy.minD4Score,
  });
}

export function isSemanticBoundaryAmbiguous(metrics, policy) {
  const normalized = normalizeSemanticBoundaryAmbiguityPolicy(policy);
  if (!metrics || !normalized) return false;
  return metrics.d4Score >= normalized.minD4Score && metrics.gap <= normalized.maxD4D5Gap;
}

export function semanticBoundaryEligibility({
  goal, candidates, shapes, interactive = false, analyze, cancelled = false,
  budget, ambiguityPolicy,
} = {}) {
  const metrics = deterministicBoundaryMetrics(candidates);
  if (interactive !== true) return { eligible: false, reason: 'not-interactive', metrics };
  if (typeof analyze !== 'function') return { eligible: false, reason: 'no-analyze', metrics };
  const safeGoal = semanticBoundaryGoal(goal);
  if (!safeGoal) return { eligible: false, reason: 'unsupported-goal', metrics };
  /*
   * A goal without calibrated guidance is never asked.  The question would be
   * ill-posed — measured on the OpenMW fixture, `level` and `item` expose the
   * same candidate list as `hp` — so only a goal whose wording was justified by
   * a labelled holdout may spend a request.  Adding a holdout case is therefore
   * also what makes a goal eligible.
   */
  /*
   * A free-form goal needs no authored guidance: the request's goal label *is*
   * the user's own words, so there is no wording of ours that could be wrong.
   * The rule below exists to stop an unvalidated prompt from being added
   * silently, which is why it still applies to every preset goal.
   */
  if (goal?.free !== true && !semanticBoundaryGoalGuidance(safeGoal.id)) {
    return { eligible: false, reason: 'uncalibrated-goal', metrics };
  }
  if (!Array.isArray(candidates) || candidates.length < SEMANTIC_BOUNDARY_MIN_CANDIDATES
    || candidates.length > SEMANTIC_BOUNDARY_MAX_CANDIDATES) {
    return { eligible: false, reason: 'candidate-count', metrics };
  }
  if (shapes?.complete !== true || shapes?.capped === true) return { eligible: false, reason: 'scan-incomplete', metrics };
  if (cancelled === true) return { eligible: false, reason: 'cancelled', metrics };
  if (!budget || typeof budget.left !== 'number' || !Number.isFinite(budget.left) || budget.left <= 0) {
    return { eligible: false, reason: 'no-budget', metrics };
  }
  if (!metrics) return { eligible: false, reason: 'missing-boundary-score', metrics };
  if (!normalizeSemanticBoundaryAmbiguityPolicy(ambiguityPolicy)) {
    return { eligible: false, reason: 'no-ambiguity-policy', metrics };
  }
  if (!isSemanticBoundaryAmbiguous(metrics, ambiguityPolicy)) {
    return { eligible: false, reason: 'clear-boundary', metrics };
  }
  return { eligible: true, reason: null, metrics };
}

/** Strictly validate the small preference object returned by the worker. */
export function normalizeSemanticBoundaryResponse(value, { candidateIds, expectedMethod = null } = {}) {
  if (!isPlainObject(value) || value.model !== OPENJEV_BOUNDARY_MODEL || !METHODS.has(value.method)) return null;
  if (expectedMethod != null && value.method !== expectedMethod) return null;
  if (!Array.isArray(candidateIds) || candidateIds.length < 2 || candidateIds.length > 5) return null;
  const ids = new Set(candidateIds);
  if (ids.size !== candidateIds.length || [...ids].some((id) => !CANDIDATE_ID.test(id))) return null;
  if (!isPlainObject(value.probabilities) || !unitInterval(value.probabilities.none)) return null;
  const probabilities = { none: value.probabilities.none };
  for (const id of candidateIds) {
    if (!Object.hasOwn(value.probabilities, id) || !unitInterval(value.probabilities[id])) return null;
    probabilities[id] = value.probabilities[id];
  }
  const abstain = value.abstain === true;
  const challengerId = value.challengerId === null ? null : value.challengerId;
  if (abstain) {
    if (challengerId !== null) return null;
    return Object.freeze({ method: value.method, model: value.model, challengerId: null, probabilities, abstain: true, margin: null });
  }
  if (typeof challengerId !== 'string' || !ids.has(challengerId)) return null;
  let bestId = null;
  let best = -1;
  let tied = false;
  for (const id of candidateIds) {
    const probability = probabilities[id];
    if (probability > best) { best = probability; bestId = id; tied = false; }
    else if (probability === best) tied = true;
  }
  if (tied || bestId !== challengerId || best <= probabilities.none) return null;
  let other = probabilities.none;
  for (const id of candidateIds) if (id !== challengerId) other = Math.max(other, probabilities[id]);
  return Object.freeze({
    method: value.method,
    model: value.model,
    challengerId,
    probabilities,
    abstain: false,
    margin: best - other,
  });
}

/** Admission is separate from response validation so it can be frozen from holdout data. */
export function normalizeSemanticBoundaryAdmissionPolicy(policy) {
  if (!isPlainObject(policy) || policy.schema !== SEMANTIC_BOUNDARY_ADMISSION_SCHEMA) return null;
  if (!unitInterval(policy.minProbability) || !unitInterval(policy.minMargin)) return null;
  return Object.freeze({
    schema: SEMANTIC_BOUNDARY_ADMISSION_SCHEMA,
    minProbability: policy.minProbability,
    minMargin: policy.minMargin,
  });
}

export function admitSemanticBoundaryChallenger(response, policy) {
  const normalizedPolicy = normalizeSemanticBoundaryAdmissionPolicy(policy);
  if (!response || response.abstain || !normalizedPolicy || !response.challengerId) {
    return { admitted: false, reason: response?.abstain ? 'abstain' : 'not-admissible' };
  }
  const probability = response.probabilities[response.challengerId];
  if (probability < normalizedPolicy.minProbability) return { admitted: false, reason: 'probability' };
  if (response.margin < normalizedPolicy.minMargin) return { admitted: false, reason: 'margin' };
  return { admitted: true, challengerId: response.challengerId };
}

export function supportedSemanticShapeGoal(goal) {
  return semanticBoundaryGoal(goal) != null;
}

/*
 * agent/candidate-authority.js — the single C2 authority decision for
 * global/terminal candidate-selection claims.
 *
 * A positive local verification proves one property of one observed candidate
 * ("X contains the requested update path"). It does not prove anything about
 * the candidate universe. Every consumer that projects a planner result into
 * terminal authority (`0.98` answer confidence, a `verified` goal-level claim,
 * or "the strongest candidate" prose) must consult this predicate, so a
 * truncated search, a partial semantic enumeration, a shortlist/source-pool
 * cap, a budget stop, or candidate-local incompleteness cannot be laundered
 * into a global conclusion (#8673).
 *
 * A reported negative coverage state always disqualifies. A malformed or
 * non-canonical coverage value also disqualifies: completeness is a typed
 * boolean authority, not a truthiness test. Absent coverage metadata is not a
 * negative report — the deterministic planner always publishes
 * `completeness`, so a plan without it is a non-planner producer that never
 * claimed universe coverage, and it keeps its previous behavior here instead
 * of being silently re-scoped by this change.
 */

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function coverageReports(plan) {
  const reports = [];
  if (Object.hasOwn(plan, 'completeness')) reports.push(['completeness', plan.completeness]);
  if (Object.hasOwn(plan, 'searchCompleteness') && plan.searchCompleteness !== undefined) reports.push(['searchCompleteness', plan.searchCompleteness]);
  if (Object.hasOwn(plan, 'semanticCompleteness') && plan.semanticCompleteness !== undefined) reports.push(['semanticCompleteness', plan.semanticCompleteness]);
  const best = plan.best;
  if (isPlainObject(best)) {
    if (Object.hasOwn(best, 'complete')) reports.push(['best-complete', best.complete]);
    if (Object.hasOwn(best, 'semanticCompleteness') && best.semanticCompleteness !== undefined) reports.push(['best-semanticCompleteness', best.semanticCompleteness]);
  }
  return reports;
}

function evaluate(label, value, reasons) {
  if (label === 'completeness') {
    if (!isPlainObject(value)) { reasons.push('completeness-malformed'); return; }
    if (value.complete !== true) reasons.push('plan-coverage-incomplete');
    if (value.partial !== undefined && typeof value.partial !== 'boolean') reasons.push('plan-coverage-partial');
    else if (value.partial === true) reasons.push('plan-coverage-partial');
    if (value.budgetLimited !== undefined && typeof value.budgetLimited !== 'boolean') reasons.push('plan-budget-limited');
    else if (value.budgetLimited === true) reasons.push('plan-budget-limited');
    if (value.searchComplete !== undefined && typeof value.searchComplete !== 'boolean') reasons.push('search-coverage-incomplete');
    else if (value.searchComplete === false) reasons.push('search-coverage-incomplete');
    if (value.unanalyzedFunctions !== undefined) {
      if (typeof value.unanalyzedFunctions !== 'number' || !Number.isSafeInteger(value.unanalyzedFunctions) || value.unanalyzedFunctions !== 0) {
        reasons.push('candidate-coverage-incomplete');
      }
    }
    return;
  }
  if (label === 'best-complete') {
    if (value !== true) reasons.push('candidate-coverage-incomplete');
    return;
  }
  if (label === 'best-semanticCompleteness') {
    if (!isPlainObject(value) || value.complete !== true) reasons.push('semantic-coverage-incomplete');
    return;
  }
  if (label === 'semanticCompleteness') {
    if (!isPlainObject(value) || value.complete !== true) reasons.push('semantic-coverage-incomplete');
    if (Array.isArray(value.incomplete) && value.incomplete.length > 0) reasons.push('semantic-coverage-incomplete');
    return;
  }
  if (!isPlainObject(value) || value.complete !== true) reasons.push('search-coverage-incomplete');
}

/**
 * @param {object} plan a deterministic goal planner result (or a plan-shaped
 *   object produced by an injected planner).
 * @returns {{authoritative: boolean, reasons: string[]}} whether a positive
 *   candidate verification may authorize a global/terminal conclusion.
 */
export function globalCandidateAuthority(plan) {
  if (!isPlainObject(plan) || !isPlainObject(plan.best)) {
    return { authoritative: false, reasons: ['no-candidate'] };
  }
  const reasons = [];
  for (const [label, value] of coverageReports(plan)) evaluate(label, value, reasons);
  if (plan.partial === true) reasons.push('plan-coverage-partial');
  if (plan.exhausted === true) reasons.push('plan-budget-limited');
  return { authoritative: reasons.length === 0, reasons: Array.from(new Set(reasons)) };
}

/** A positive local verification, independent of whether it may be widened. */
export function locallyVerifiedCandidate(plan) {
  return isPlainObject(plan?.best?.verification) && plan.best.verification.verified === true;
}

/**
 * Terminal/global verification authority: a positive local verification plus
 * coverage that actually spans the candidate universe.
 */
export function terminalCandidateAuthority(plan) {
  const authority = globalCandidateAuthority(plan);
  const local = locallyVerifiedCandidate(plan);
  return {
    authoritative: local && authority.authoritative,
    local,
    reasons: authority.authoritative ? (local ? [] : ['no-local-verification']) : authority.reasons,
  };
}

export default terminalCandidateAuthority;

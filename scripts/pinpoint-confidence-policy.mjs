/*
 * OLD / NEW(#9418 P1) / P4 confidence policy replay (measurement-only output).
 *
 * NEW (P1) and P4 delegate to the production decision core
 * (verdictForFusions in js/evidence.js) so the replay can never drift from
 * production decide(). Policy endpoints:
 *   OLD (pre-#9418 baseline, historical, local replay only):
 *     confirmed: identifying>0, verified, groups>=3, p>=0.99, margin>=ln20
 *     likely:    p>=0.85 AND margin>=ln(4), no independent-group requirement
 *   NEW / P1 (#9418, production default):
 *     confirmed: identical to OLD
 *     likely:    p>=0.85 AND margin>=ln(4) AND independentGroups>=3
 *   P4 (production field path, allowTrustedTwoGroup=true):
 *     confirmed: unchanged (still needs >=3 groups)
 *     likely:    p>=0.85 AND margin>=ln(4) AND
 *                (groups>=3 OR exactly {metadata, structural} 2-group combo,
 *                 validated fail-closed by the production gate)
 *   Both keep the pre-existing identifying downgrade and the ambiguous/none
 *   thresholds below. Field path has no maxVerdict cap, so none is applied here.
 *
 * OLD / B / C stay local: they are historical or measurement-only
 * counterfactuals and are never production semantics (never implemented):
 *   Policy B: OLD + likely additionally requires verified evidence.
 *   Policy C: OLD + groups==2 likely additionally requires accessor-level
 *             verification (getter-verified or setter-verified) in top items.
 */
import { verdictForFusions } from '../js/evidence.js';

export const LIKELY_P = 0.85;
export const LIKELY_MARGIN = Math.log(4);
export const CONFIRM_P = 0.99;
export const CONFIRM_MARGIN = Math.log(20);
export const CONFIRM_GROUPS = 3;
export const AMBIGUOUS_P = 0.35;
export const AMBIGUOUS_FLOOR = 0.05;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function verifiedOf(f) {
  const v = f?.verified;
  if (v === true) return true;
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}
function identifyingOf(f) {
  const v = f?.identifying;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function indepOf(f) {
  const v = f?.independentGroups;
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

function baseMissing(top, margin) {
  const missing = [];
  if (!(identifyingOf(top) > 0)) missing.push('need-name-evidence');
  if (!verifiedOf(top)) missing.push('need-verification');
  if (indepOf(top) < CONFIRM_GROUPS) missing.push('need-independent-evidence');
  if (!(num(top?.probability) >= CONFIRM_P)) missing.push('need-more-evidence');
  // NOTE: production compares raw margin (Infinity when single candidate),
  // not a finiteness-filtered value: Infinity >= threshold is true.
  if (!(margin >= CONFIRM_MARGIN)) missing.push('need-separation');
  return missing;
}

function finish(top, runner, likelyOk) {
  const p = num(top?.probability) ?? 0;
  const tLog = num(top?.logOdds);
  const rLog = runner ? num(runner?.logOdds) : null;
  const margin = !runner ? Infinity : (tLog !== null && rLog !== null ? tLog - rLog : -Infinity);
  const missing = baseMissing(top, margin);
  let verdict = 'none';
  if (!missing.length) verdict = 'confirmed';
  else if (p >= LIKELY_P && margin >= LIKELY_MARGIN && likelyOk) verdict = 'likely';
  else if (p >= AMBIGUOUS_P || (runner && margin < LIKELY_MARGIN && p >= AMBIGUOUS_FLOOR)) verdict = 'ambiguous';
  if (!(identifyingOf(top) > 0) && (verdict === 'likely' || verdict === 'confirmed')) verdict = 'ambiguous';
  return { verdict, margin, marginRatio: margin === Infinity ? Infinity : Math.exp(margin), missing };
}

/**
 * NEW (#9418 P1): likely requires 3 independent groups.
 * Delegates to the production core with the P4 exception OFF, so replay and
 * production decide() can never disagree on this policy.
 */
export function newVerdictForFusion(topFusion, runnerFusion) {
  return verdictForFusions(topFusion, runnerFusion, { allowTrustedTwoGroup: false });
}

/**
 * P4 (production field policy): trusted 2-group {metadata, structural} likely
 * exception allowed. Pass `{ allowTrustedTwoGroup: false }` for the location
 * path (field-only exception must not apply there).
 */
export function p4VerdictForFusion(topFusion, runnerFusion, opts) {
  const allow = !opts || opts.allowTrustedTwoGroup !== false;
  return verdictForFusions(topFusion, runnerFusion, { ...(opts || {}), allowTrustedTwoGroup: allow });
}

/** OLD (baseline): likely has no group requirement. */
export function oldVerdictForFusion(topFusion, runnerFusion) {
  return finish(topFusion, runnerFusion, true);
}

/** Policy B: OLD + likely requires verified evidence. */
export function policyBVerdictForFusion(topFusion, runnerFusion, topCodes) {
  void topCodes;
  return finish(topFusion, runnerFusion, verifiedOf(topFusion));
}

/** Policy C: OLD + groups==2 likely requires accessor-level verification. */
export function policyCVerdictForFusion(topFusion, runnerFusion, topCodes) {
  const codes = new Set(topCodes || []);
  const accessor = codes.has('getter-verified') || codes.has('setter-verified');
  const ok = indepOf(topFusion) >= CONFIRM_GROUPS || accessor;
  return finish(topFusion, runnerFusion, ok);
}

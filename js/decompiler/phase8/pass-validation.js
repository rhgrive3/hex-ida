import { stableDigest } from '../../core/identity/index.js';
import { verifyBoundedEquivalence } from '../../symbolic/verify/equivalence.js';
import { VERDICT, CLAIM_KIND } from '../../symbolic/verify/query.js';

export const REWRITE_VALIDATION_VERIFIER = 'hex.symbolic.verify.bounded-equivalence';
export const REWRITE_VALIDATION_STATUSES = Object.freeze(['equivalent', 'refuted', 'unknown', 'unsupported']);

function fail(code) { throw new TypeError(code); }

function rewriteBinding(rewrite, { beforeTarget = undefined, afterTarget = undefined } = {}) {
  if (!rewrite || typeof rewrite !== 'object' || Array.isArray(rewrite)) {
    fail('phase8-rewrite-proof-binding-required');
  }
  if (!Object.hasOwn(rewrite, 'before') || !Object.hasOwn(rewrite, 'after')) {
    fail('phase8-rewrite-proof-binding-required');
  }
  const beforeDigest = stableDigest(rewrite.before);
  const afterDigest = stableDigest(rewrite.after);
  if (beforeTarget !== undefined && beforeDigest !== stableDigest(beforeTarget)) {
    fail('phase8-rewrite-adoption-before-binding-mismatch');
  }
  if (afterTarget !== undefined && afterDigest !== stableDigest(afterTarget)) {
    fail('phase8-rewrite-adoption-after-binding-mismatch');
  }
  return Object.freeze({
    beforeDigest,
    afterDigest,
    rewriteDigest: stableDigest(rewrite),
  });
}

/**
 * C4-04: deterministic, recomputable identity for one validated rewrite
 * adoption. The digest covers everything the adoption decision depended on;
 * a commit-time recompute must reproduce it or the record is forged.
 */
export function rewriteProofDigest(input = {}) {
  const required = [
    'passId',
    'passVersion',
    'transformKind',
    'targets',
    'beforeDigest',
    'afterDigest',
    'rewriteDigest',
    'verdict',
    'claimKind',
  ];
  for (const key of required) {
    if (input?.[key] == null || input[key] === '') fail(`phase8-rewrite-proof-field-required:${key}`);
  }
  if (typeof input.verifierIdentity !== 'string' || !input.verifierIdentity.length) {
    fail('phase8-rewrite-proof-verifier-required');
  }
  return `p8rw_${stableDigest({
    schema: 'phase8-rewrite-adoption/v2',
    passId: String(input.passId),
    passVersion: String(input.passVersion),
    transformKind: String(input.transformKind),
    targets: [...input.targets].map(String).sort(),
    beforeDigest: input.beforeDigest,
    afterDigest: input.afterDigest,
    rewriteDigest: input.rewriteDigest,
    verifierIdentity: input.verifierIdentity,
    verdict: String(input.verdict),
    claimKind: String(input.claimKind),
    queryHash: input.queryHash ?? null,
  })}`;
}

/**
 * Validate one rewrite through the canonical bounded-equivalence verifier.
 * The result is a typed validation record a Phase 8 transform may attach:
 * `equivalent` (adopt), `refuted` (refuse), `unknown`/`unsupported`
 * (drop with diagnostics). Cancellation and timeouts stay `unknown` —
 * they never mint adoption.
 */
export async function validateRewriteAdoption({
  passId,
  passVersion,
  transformKind,
  targets,
  beforeTarget,
  afterTarget,
  rewrite = null,
  beforeIr = null,
  afterIr = null,
  correspondence = {},
  preconditions = null,
  backend = null,
  session = null,
  options = {},
} = {}) {
  if (!passId || !passVersion || !transformKind) fail('phase8-rewrite-adoption-identity-required');
  if (!Array.isArray(targets) || targets.length === 0) fail('phase8-rewrite-adoption-targets-required');
  if (beforeTarget == null || afterTarget == null) fail('phase8-rewrite-adoption-targets-required');

  // The verifier and the commit gate must talk about the same staged rewrite.
  // When callers omit an explicit payload, the canonical payload is the exact
  // before/after pair being sent to the verifier. Any later payload mutation
  // changes the recomputed binding and therefore cannot reuse this proof id.
  const rewritePayload = rewrite ?? Object.freeze({ before: beforeTarget, after: afterTarget });
  const binding = rewriteBinding(rewritePayload, { beforeTarget, afterTarget });

  const outcome = await verifyBoundedEquivalence({
    beforeIr,
    afterIr,
    beforeTarget,
    afterTarget,
    correspondence,
    preconditions,
    backend,
    session,
    options,
  });

  const verdict = outcome?.verdict;
  const claimKind = outcome?.claimKind ?? CLAIM_KIND.EQUIVALENT;
  if (verdict === VERDICT.PROVED && claimKind === CLAIM_KIND.EQUIVALENT) {
    const equivalenceProofId = rewriteProofDigest({
      passId,
      passVersion,
      transformKind,
      targets,
      ...binding,
      verifierIdentity: REWRITE_VALIDATION_VERIFIER,
      verdict,
      claimKind,
      queryHash: outcome.queryHash ?? null,
    });
    return Object.freeze({
      validation: 'equivalent',
      equivalenceProofId,
      verifier: REWRITE_VALIDATION_VERIFIER,
      verdictSource: 'unsat-difference',
      solverStatus: outcome.solverStatus ?? null,
      completeness: outcome.completeness ?? null,
      queryHash: outcome.queryHash ?? null,
    });
  }
  if (verdict === VERDICT.REFUTED) {
    return Object.freeze({
      validation: 'refuted',
      reason: outcome.reasonCode ?? 'rewrite-not-equivalent',
      verifier: REWRITE_VALIDATION_VERIFIER,
      solverStatus: outcome.solverStatus ?? null,
      counterexample: outcome.evidence ? Object.freeze({ ...outcome.evidence }) : null,
    });
  }
  const unsupported = outcome?.completeness?.translation === 'unsupported'
    || outcome?.reasonCode === 'translation-failed';
  return Object.freeze({
    validation: unsupported ? 'unsupported' : 'unknown',
    reason: outcome?.reasonCode ?? 'rewrite-validation-unknown',
    verifier: REWRITE_VALIDATION_VERIFIER,
    solverStatus: outcome?.solverStatus ?? null,
  });
}

/**
 * Recompute the proof id a transform's validation record must carry.
 * Used at commit time so a mutated record fails the transaction. A malformed
 * or missing staged rewrite returns null, which the caller treats as a proof
 * mismatch rather than allowing an exception to bypass the fail-closed gate.
 */
export function recomputeEquivalenceProofId(transform, descriptor) {
  const validation = transform?.validation;
  if (!validation || validation.validation !== 'equivalent') fail('phase8-rewrite-proof-not-equivalent');
  let binding;
  try {
    binding = rewriteBinding(transform?.rewrite);
  } catch {
    return null;
  }
  return rewriteProofDigest({
    passId: descriptor?.id,
    passVersion: descriptor?.version,
    transformKind: String(transform.kind ?? ''),
    targets: transform.targets ?? [],
    ...binding,
    verifierIdentity: validation.verifier,
    verdict: 'proved',
    claimKind: CLAIM_KIND.EQUIVALENT,
    queryHash: validation.queryHash ?? null,
  });
}

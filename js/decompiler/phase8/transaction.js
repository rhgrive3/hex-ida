import { createPassResult } from './contract.js';
import {
  attachValidatedRewriteMetadata,
  recomputeEquivalenceProofId,
  validatedRewriteMetadataFor,
} from './pass-validation.js';
import * as core from './transaction-core.js';
import { rewritePolicyFailure } from './rewrite-registry.js';

const COMMITTED_PROOF_OVERLAYS = new WeakMap();
const COMMITTED_DCE_ARTIFACTS = new WeakMap();
let proofTransactionAdapter = null;
let canonicalDceRunner = null;

/** Register the private proof hooks without importing proof-plan here.  The
 * latter imports this transaction module for the overlay reader, so a direct
 * top-level import would create an evaluation cycle. Registration is lazy and
 * occurs only after a proof capability has been issued. */
export function registerProofTransactionAdapter(adapter) {
  if (adapter == null || typeof adapter !== 'object') throw new TypeError('phase8-proof-transaction-adapter-invalid');
  if (proofTransactionAdapter != null && proofTransactionAdapter !== adapter) {
    throw new TypeError('phase8-proof-transaction-adapter-already-registered');
  }
  proofTransactionAdapter = adapter;
}

/** Register the one effect-aware DCE runner whose committed facts may be used
 * as provenance authority. A pass descriptor alone is not sufficient: a
 * caller can reuse the descriptor with an impersonating function, and that
 * must remain analysis-only. */
export function registerDcePassRunner(runner) {
  if (typeof runner !== 'function') throw new TypeError('phase8-dce-runner-invalid');
  if (canonicalDceRunner != null && canonicalDceRunner !== runner) {
    throw new TypeError('phase8-dce-runner-already-registered');
  }
  canonicalDceRunner = runner;
}

export function createAnalysisState(...args) {
  return core.createAnalysisState(...args);
}

export function forkAnalysisState(source) {
  const working = core.forkAnalysisState(source);
  const overlay = COMMITTED_PROOF_OVERLAYS.get(source);
  if (overlay != null) COMMITTED_PROOF_OVERLAYS.set(working, overlay);
  const dce = COMMITTED_DCE_ARTIFACTS.get(source);
  if (dce != null) COMMITTED_DCE_ARTIFACTS.set(working, dce);
  return working;
}

export function commitAnalysisState(target, working, before) {
  const committed = core.commitAnalysisState(target, working, before);
  if (!committed) return false;
  const overlay = COMMITTED_PROOF_OVERLAYS.get(working);
  if (overlay != null && target.get('provedRewrites') === overlay) COMMITTED_PROOF_OVERLAYS.set(target, overlay);
  else COMMITTED_PROOF_OVERLAYS.delete(target);
  const dce = COMMITTED_DCE_ARTIFACTS.get(working);
  if (dce != null && target.get('deadCode') === dce) COMMITTED_DCE_ARTIFACTS.set(target, dce);
  else COMMITTED_DCE_ARTIFACTS.delete(target);
  return true;
}

export const invalidationFor = core.invalidationFor;
export const seedAnalysisState = core.seedAnalysisState;
export const transactionDigest = core.transactionDigest;

// The proof-plan module consumes this capability. It returns an overlay only
// while the same object is still the authoritative staged analysis value.
export function committedProofOverlay(state) {
  const overlay = COMMITTED_PROOF_OVERLAYS.get(state);
  try {
    return overlay != null && state?.get?.('provedRewrites') === overlay ? overlay : null;
  } catch {
    return null;
  }
}

/** Read-only authority for the committed effect-aware DCE facts. */
export function committedDceArtifact(state) {
  const facts = COMMITTED_DCE_ARTIFACTS.get(state);
  try { return facts != null && state?.get?.('deadCode') === facts ? facts : null; }
  catch { return null; }
}

class RewriteRefusal extends Error {
  constructor(reason) { super(`phase8-c4-04-refusal:${reason}`); this.reason = reason; }
}

function admission(result, descriptor, metadata) {
  const transforms = [];
  const retainedIndexes = [];
  const diagnostics = [];
  for (let index = 0; index < result.transforms.length; index += 1) {
    const transform = result.transforms[index];
    const validation = transform.validation;
    if (validation == null) {
      if (transform.rewrite != null && transform.unvalidatedReason == null) throw new RewriteRefusal('rewrite-unvalidated');
      transforms.push(transform); retainedIndexes.push(index); continue;
    }
    if (validation.validation === 'refuted') throw new RewriteRefusal('rewrite-refuted');
    if (validation.validation === 'equivalent') {
      if (metadata?.[index]?.equivalenceAuthority !== true) {
        throw new RewriteRefusal('rewrite-equivalence-authority-missing');
      }
      const expected = recomputeEquivalenceProofId(transform, descriptor);
      if (validation.equivalenceProofId !== expected) throw new RewriteRefusal('rewrite-proof-id-mismatch');
      transforms.push(transform); retainedIndexes.push(index); continue;
    }
    if (validation.validation === 'unknown' || validation.validation === 'unsupported') {
      const reason = validation.reason ?? validation.validation;
      diagnostics.push(Object.freeze({
        severity:'warning', code:'phase8-rewrite-not-adopted',
        message:`rewrite ${String(transform.kind)} was not adopted: ${String(reason)}`,
        reason:String(reason),
      }));
      continue;
    }
    throw new RewriteRefusal('rewrite-validation-malformed');
  }
  return { transforms, retainedIndexes, diagnostics };
}

function coreResultOf(result, descriptor, admitted) {
  const withheldCount = result.transforms.length - admitted.transforms.length;
  if (withheldCount > 0 && result.produced.length > 0) {
    throw new RewriteRefusal('withheld-rewrite-has-produced-artifacts');
  }
  const retainedChange = admitted.transforms.length > 0 || result.produced.length > 0;
  return createPassResult({
    descriptor,
    status:retainedChange ? result.status : 'unchanged',
    changed:retainedChange,
    completeness:result.completeness,
    transforms:admitted.transforms.map(({ kind, targets, proof, originRefs }) => ({ kind, targets, proof, originRefs })),
    diagnostics:[...result.diagnostics, ...admitted.diagnostics],
    invalidated:retainedChange ? result.invalidated : [],
    produced:result.produced,
    stopReason:result.stopReason,
  });
}

export function runPassTransaction(state, pass, context = {}, budget = {}) {
  let publishedMetadata = null;
  let retainedIndexes = null;
  const proofAdapter = proofTransactionAdapter;
  const proofPass = proofAdapter != null && pass?.descriptor === proofAdapter.descriptor;
  let proofRaw = null;
  let proofStaged = null;
  let proofAdmissionFailed = false;
  const executionBudget = proofPass ? {
    ...budget,
    // The core transaction performs this callback at its final pre-commit
    // checkpoint. Re-checking the private capability there closes the TOCTOU
    // window between initial proof admission and publication.
    shouldAbort() {
      let cancelled = false;
      try { cancelled = typeof budget?.shouldAbort === 'function' && budget.shouldAbort() === true; }
      catch { cancelled = true; }
      if (!cancelled && proofRaw != null && proofStaged != null) {
        try { proofAdmissionFailed = proofAdapter.admission(proofRaw, proofStaged, pass.descriptor, context) != null; }
        catch { proofAdmissionFailed = true; }
      }
      return cancelled || proofAdmissionFailed;
    },
  } : budget;
  const wrapped = {
    descriptor:pass.descriptor,
    run(passContext, passBudget, area) {
      const raw = pass.run(passContext, passBudget, area);
      if (proofPass) {
        const stagedWrites = new Map(area.stagedEntries?.() ?? []);
        proofRaw = raw;
        proofStaged = stagedWrites;
        const reason = proofAdapter.admission(raw, stagedWrites, pass.descriptor, passContext);
        if (reason) throw new RewriteRefusal(reason);
        const published = proofAdapter.publication(raw);
        if (published == null) throw new RewriteRefusal('proof-publication-invalid');
        const policyFailure = rewritePolicyFailure(pass.descriptor, published,
          { required: passContext.requireRewritePolicy === true, proofPass: true });
        if (policyFailure) throw new RewriteRefusal(policyFailure);
        return published;
      }
      const policyFailure = rewritePolicyFailure(pass.descriptor, raw,
        { required: passContext.requireRewritePolicy === true, proofPass: false });
      if (policyFailure) throw new RewriteRefusal(policyFailure);
      const metadata = validatedRewriteMetadataFor(raw);
      if (metadata == null) return raw;
      const enriched = attachValidatedRewriteMetadata(raw, metadata);
      const admitted = admission(enriched, pass.descriptor, metadata);
      publishedMetadata = metadata;
      retainedIndexes = admitted.retainedIndexes;
      return coreResultOf(enriched, pass.descriptor, admitted);
    },
  };
  const outcome = core.runPassTransaction(state, wrapped, context, executionBudget);
  if (!outcome.committed && typeof outcome.stopReason === 'string' && outcome.stopReason.startsWith('failed:phase8-c4-04-refusal:')) {
    const reason = outcome.stopReason.slice('failed:phase8-c4-04-refusal:'.length);
    return Object.freeze({ ...outcome, stopReason:reason });
  }
  if (outcome.committed && proofPass && outcome.staged.includes('provedRewrites')) {
    const overlay = state.get('provedRewrites');
    if (overlay != null) COMMITTED_PROOF_OVERLAYS.set(state, overlay);
  } else if (proofPass && (!outcome.committed || outcome.invalidated.includes('provedRewrites'))) {
    COMMITTED_PROOF_OVERLAYS.delete(state);
  }
  if (outcome.committed && pass?.descriptor?.id === 'phase8.dce' && pass?.run === canonicalDceRunner
      && outcome.staged.includes('deadCode')) {
    const facts = state.get('deadCode');
    if (facts != null) COMMITTED_DCE_ARTIFACTS.set(state, facts);
  } else if (!outcome.committed || outcome.invalidated.includes('deadCode')) {
    COMMITTED_DCE_ARTIFACTS.delete(state);
  }
  if (!outcome.committed || publishedMetadata == null || outcome.result == null) return outcome;
  const retainedMetadata = retainedIndexes.map((index) => publishedMetadata[index]);
  const result = attachValidatedRewriteMetadata(outcome.result, retainedMetadata);
  return Object.freeze({ ...outcome, result });
}

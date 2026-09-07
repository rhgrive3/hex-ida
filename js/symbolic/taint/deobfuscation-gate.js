/** Proof and taint gate for symbolic/deobfuscation rewrites. */

import { stableDigest } from '../../core/identity/index.js';
import {
  isRewriteProof,
  isRewriteProofFor,
  REWRITE_PROOF_VERSION,
} from '../../decompiler/verify/equivalence.js';
import { TAINT_STATUS, TAINT_VERSION, hasUnknownTaint } from './lattice.js';

const COMPLETE = 'complete';
const BAD_LIFECYCLE = new Set([
  'timeout', 'timed-out', 'cancelled', 'canceled', 'stale', 'disposed',
  'budget-limited', 'resource-limit', 'unsupported', 'unknown',
]);

function taintRecords(value) {
  if (!value) return [];
  if (value.version === TAINT_VERSION && Array.isArray(value.labels)) return [value];
  if (value.taints instanceof Map) return [...value.taints.values()];
  if (value.taints && typeof value.taints === 'object') return Object.values(value.taints);
  if (Array.isArray(value.values)) return value.values;
  return Array.isArray(value) ? value : [];
}

function taintGateReason(input) {
  const analysis = input?.taintAnalysis ?? input?.taint ?? null;
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return 'taint-analysis-missing';
  if (analysis.version !== TAINT_VERSION) return 'taint-analysis-untrusted';
  if (analysis.status !== TAINT_STATUS.COMPLETE) return `taint-${analysis.status || 'unknown'}`;
  if (analysis.complete !== true) return 'taint-analysis-incomplete';
  if (!Array.isArray(analysis.paths) || !analysis.taints || typeof analysis.taints !== 'object') {
    return 'taint-analysis-incomplete';
  }
  if (analysis.stats?.status && analysis.stats.status !== TAINT_STATUS.COMPLETE) {
    return `taint-${analysis.stats.status}`;
  }
  if (analysis.store?.status && analysis.store.status !== TAINT_STATUS.COMPLETE) {
    return `taint-${analysis.store.status}`;
  }
  if (analysis.memoryUnknown === true || analysis.unknownAlias === true || analysis.incompleteAlias === true) {
    return 'taint-memory-alias-incomplete';
  }
  if (analysis.paths.some((path) => path?.status != null && path.status !== TAINT_STATUS.COMPLETE)) {
    return 'taint-analysis-incomplete';
  }
  for (const value of taintRecords(analysis)) if (hasUnknownTaint(value)) return 'taint-unknown-value';
  return null;
}

function pairFor(input = {}) {
  const candidate = input.candidate && typeof input.candidate === 'object' ? input.candidate : null;
  const before = input.before
    ?? input.original
    ?? candidate?.before
    ?? candidate?.original
    ?? null;
  const after = input.after
    ?? candidate?.after
    ?? candidate?.expression
    ?? null;
  return { before, after };
}

function proofOptionsFor(input = {}) {
  const options = input.proofOptions ?? input.context ?? {};
  return options && typeof options === 'object' && !Array.isArray(options) ? options : {};
}

function proofMatches(proof, before, after, options) {
  try { return isRewriteProofFor(proof, before, after, options); } catch { return false; }
}

function proofLifecycleValues(proof) {
  const lifecycle = proof.lifecycle || proof.state || {};
  return {
    lifecycle,
    values: [
      proof.status,
      proof.state,
      proof.reason,
      proof.solverStatus,
      lifecycle.status,
      lifecycle.reason,
    ].filter((value) => typeof value === 'string').map((value) => value.toLowerCase()),
  };
}

function proofGateReason(input, pair = pairFor(input)) {
  const proof = input?.proof ?? null;
  if (!isRewriteProof(proof) || proof.proofVersion !== REWRITE_PROOF_VERSION || proof.accepted !== true) {
    return proof ? 'proof-authority-untrusted' : 'proof-missing';
  }
  if (!pair.before || !pair.after || typeof pair.before !== 'object' || typeof pair.after !== 'object') {
    return 'proof-pair-missing';
  }
  if (!proofMatches(proof, pair.before, pair.after, proofOptionsFor(input))) {
    return 'proof-pair-mismatch';
  }
  const { lifecycle, values } = proofLifecycleValues(proof);
  if (values.some((value) => BAD_LIFECYCLE.has(value))) return 'proof-lifecycle-not-publishable';
  if (lifecycle.timedOut === true || lifecycle.cancelled === true || lifecycle.stale === true
      || lifecycle.disposed === true || lifecycle.budgetExceeded === true || lifecycle.publishable === false) {
    return 'proof-lifecycle-not-publishable';
  }
  if (proof.verdict !== 'proved') return 'proof-verdict-not-proved';
  if (proof.solverStatus !== 'unsat') return 'proof-solver-not-unsat';
  const completeness = proof.completeness;
  if (!completeness || ['translation', 'controlFlow', 'memoryEffects', 'pathCoverage', 'queryScope']
    .some((key) => completeness[key] !== COMPLETE)) return 'proof-completeness-incomplete';
  return null;
}

function safeDigest(value) {
  try { return value == null ? null : stableDigest(value); } catch { return null; }
}

export function evaluateDeobfuscationGate(input = {}, capturedPair = null) {
  const pair = capturedPair || pairFor(input);
  const taintReason = taintGateReason(input);
  const proofReason = taintReason ? null : proofGateReason(input, pair);
  const reason = taintReason || proofReason;
  const taint = input.taintAnalysis ?? input.taint ?? null;
  const proof = input.proof ?? null;
  const approved = !reason;
  return Object.freeze({
    version: TAINT_VERSION,
    status: approved ? 'approved' : 'withheld',
    adopted: approved,
    reason: approved ? 'proof-and-taint-gate-passed' : reason,
    proofDigest: safeDigest(proof),
    taintDigest: safeDigest(taint),
    taintStatus: taint?.status ?? null,
    before: pair.before,
    after: pair.after,
  });
}

/**
 * Adopt only the exact pair covered by a canonical branded proof and a
 * complete taint analysis. A transform may compute the already-proved
 * `after` value, but its result is checked against the same proof binding
 * before it is published.
 */
export function applyProofGatedDeobfuscation(input = {}) {
  const pair = pairFor(input);
  const gate = evaluateDeobfuscationGate(input, pair);
  const candidate = pair.after ?? input.candidate ?? input.root ?? input.value;
  if (!gate.adopted) return Object.freeze({ ...gate, candidate, result: pair.before ?? candidate });

  const proof = input.proof;
  const proofOptions = proofOptionsFor(input);
  // The caller may mutate the pair after the first gate check. Revalidate the
  // private binding immediately before invoking any caller-owned transform.
  if (!proofMatches(proof, pair.before, pair.after, proofOptions)) {
    return Object.freeze({ ...gate, status: 'withheld', adopted: false, reason: 'proof-pair-changed', candidate, result: pair.before });
  }

  const transform = input.transform ?? input.apply ?? input.candidateTransform ?? null;
  if (transform == null) return Object.freeze({ ...gate, candidate, result: pair.after });
  if (typeof transform !== 'function') {
    return Object.freeze({ ...gate, status: 'withheld', adopted: false, reason: 'deobfuscation-transform-missing', candidate, result: pair.before });
  }
  let result;
  try {
    result = transform(pair.before, pair.after, proof);
  } catch (error) {
    return Object.freeze({ ...gate, status: 'withheld', adopted: false, reason: 'deobfuscation-transform-failed', candidate, result: pair.before, error: String(error?.message || error) });
  }
  if (!proofMatches(proof, pair.before, result, proofOptions)) {
    return Object.freeze({ ...gate, status: 'withheld', adopted: false, reason: 'deobfuscation-result-not-proof-bound', candidate, result: pair.before });
  }
  return Object.freeze({ ...gate, candidate: result, result });
}

export const gateDeobfuscation = evaluateDeobfuscationGate;
export const deobfuscationGate = evaluateDeobfuscationGate;
export const canAdoptDeobfuscation = evaluateDeobfuscationGate;
export const proofGatedDeobfuscation = applyProofGatedDeobfuscation;
export const adoptDeobfuscation = applyProofGatedDeobfuscation;

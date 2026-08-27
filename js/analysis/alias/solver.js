/**
 * Canonical Phase 7 alias solver.
 *
 * One entry point, layered:
 *
 *   A1 (region identity)  →  A2 (field-sensitive points-to)  →  reconcile
 *
 * A2 may only *strengthen* A1's answer, and only when the two do not
 * contradict each other. A contradiction — one side proving separation while
 * the other proves identity — means at least one input is wrong, so the solver
 * returns `unknown` rather than picking whichever answer is more useful. That
 * rule is what stops a precision bug in one layer from becoming a soundness bug
 * in the product.
 *
 * This module is the only thing wired into MemorySSA's `queryAlias` seam.
 * Consumers that want a stronger answer ask here; nobody gets a private path.
 */

import { createAnalysisStatus, isCompleteStatus, mergeAnalysisStatus } from '../status.js';
import { analyzeLocalPointsTo } from '../pointsto/local.js';
import { pointsToAlias } from '../pointsto/alias.js';
import { analyzeEscape } from '../summary/escape.js';
import { a1RegionAlias } from './a1-region-alias.js';
import { createAliasResult, unknownAlias } from './result.js';

export const PHASE7_ALIAS_SOLVER_ID = 'phase7.alias.solver';
export const PHASE7_ALIAS_SOLVER_VERSION = '1.1.0';

const STRENGTH = { unknown: 0, may: 1, must: 2, no: 2 };

function contradicts(left, right) {
  if (left === 'no' && right === 'must') return true;
  if (left === 'must' && right === 'no') return true;
  return false;
}

/**
 * The status every answer from this solver starts from.
 *
 * Cancellation is checked here rather than only inside the fixed point,
 * because A1 can answer a question without ever running A2 — and a cancelled
 * caller must not receive a `complete` status just because the cheap layer
 * happened to have an answer ready (P7-INV-010).
 */
function baseStatus(options) {
  const cancelled = options.signal?.aborted === true;
  if (options.status) {
    if (!cancelled) return options.status;
    const cancellationStatus = createAnalysisStatus({
      snapshotId: options.status.snapshotId,
      analyzerId: options.status.analyzerId,
      analyzerVersion: options.status.analyzerVersion,
      completeness: 'partial',
      budgetClass: options.status.budgetClass ?? null,
      stopReason: 'cancelled',
    });
    return mergeAnalysisStatus(options.status, cancellationStatus);
  }
  return createAnalysisStatus({
    snapshotId: options.snapshotId ?? 'snapshot-unbound',
    analyzerId: PHASE7_ALIAS_SOLVER_ID,
    analyzerVersion: PHASE7_ALIAS_SOLVER_VERSION,
    completeness: cancelled ? 'partial' : 'complete',
    budgetClass: options.budgetClass ?? null,
    stopReason: cancelled ? 'cancelled' : null,
  });
}

/**
 * Creates a solver bound to one function's semantic artifacts.
 *
 * The A2 fixed point runs once per function and is reused for every alias
 * question about it — demand-driven per P7-INV-009, not a whole-program solve.
 */
export function createPhase7AliasSolver({ ir, cfg, ssa, options = {} } = {}) {
  let pointsToRun = null;
  let baselineRun = null;
  let refinedRun = null;
  let escapeRun = null;
  let effectiveSnapshotId = options.snapshotId ?? 'snapshot-unbound';
  const enableA2 = options.enableA2 !== false && ir != null;
  const enableEscape = options.enableEscape !== false && enableA2;

  // MemorySSA is built from this solver's baseline answers. It can therefore
  // only be attached after that build has completed; the refinement below is a
  // one-way consumer pass and never feeds a new answer back into MemorySSA.
  let memoryBinding = null;
  if (options.memorySsaBinding?.memorySsa != null || options.memorySsa != null) {
    memoryBinding = {
      ...(options.memorySsaBinding ?? {}),
      memorySsa: options.memorySsaBinding?.memorySsa ?? options.memorySsa,
    };
    if (options.snapshotId == null && memoryBinding.snapshotId != null) {
      effectiveSnapshotId = String(memoryBinding.snapshotId);
    }
  }

  function baselineOptions() {
    const result = { ...options, snapshotId: effectiveSnapshotId };
    delete result.memorySsa;
    delete result.memorySsaBinding;
    return result;
  }

  function baselinePointsTo() {
    if (!enableA2) return null;
    if (baselineRun == null) baselineRun = analyzeLocalPointsTo(ir, cfg, ssa, baselineOptions());
    return baselineRun;
  }

  function refinementOptions() {
    const base = baselineOptions();
    const memorySsa = memoryBinding?.memorySsa ?? null;
    if (memorySsa == null) return base;
    return {
      ...base,
      memorySsa,
      memorySsaBinding: { ...memoryBinding, memorySsa },
    };
  }

  function stageMemoryRefinement() {
    const baseline = baselinePointsTo();
    if (!baseline || memoryBinding?.memorySsa == null) {
      pointsToRun = baseline;
      refinedRun = null;
      return pointsToRun;
    }
    const candidate = analyzeLocalPointsTo(ir, cfg, ssa, refinementOptions());
    refinedRun = candidate;
    const publishable = isCompleteStatus(candidate.status)
      && candidate.recovery?.bindingState === 'current'
      && candidate.recovery?.publicationAllowed === true;
    if (publishable) {
      // The replacement is one immutable result boundary. Escape evidence is
      // tied to the old map and must be recomputed after a successful swap.
      pointsToRun = candidate;
      escapeRun = null;
      return pointsToRun;
    }
    // Keep the complete baseline authoritative when the staged pass is stale,
    // cancelled, truncated, malformed, or otherwise incomplete. Preserve the
    // candidate diagnostics as audit evidence without exposing its map.
    pointsToRun = candidate.recovery == null
      ? baseline
      : { ...baseline, recovery: { ...candidate.recovery, publicationAllowed: false } };
    return pointsToRun;
  }

  function pointsTo() {
    if (!enableA2) return null;
    if (pointsToRun == null) {
      if (memoryBinding?.memorySsa != null) return stageMemoryRefinement();
      pointsToRun = baselinePointsTo();
    }
    return pointsToRun;
  }

  /** Attach one already-validated MemorySSA artifact for a post-build pass. */
  function refineMemorySsa(memorySsa, binding = {}) {
    memoryBinding = {
      ...binding,
      ...(memoryBinding ?? {}),
      ...((binding && typeof binding === 'object') ? binding : {}),
      memorySsa,
    };
    if (options.snapshotId == null && memoryBinding.snapshotId != null) {
      effectiveSnapshotId = String(memoryBinding.snapshotId);
    }
    refinedRun = null;
    // Preserve demand-driven construction when the solver has not been asked
    // a question yet. A builder that already queried the baseline receives the
    // refinement immediately, and escape facts are invalidated on publication.
    if (baselineRun != null || pointsToRun != null) return stageMemoryRefinement();
    return null;
  }

  /**
   * Escape evidence, computed on demand from the same points-to run.
   *
   * A1/A2 do not depend on escape to satisfy their own contracts — this is the
   * later refinement §7.2 allows, layered on top rather than folded backwards
   * into the earlier checkpoints.
   */
  function escape() {
    if (!enableEscape) return null;
    if (escapeRun == null) {
      const run = pointsTo();
      escapeRun = run == null ? null : analyzeEscape(ir, cfg, ssa, run, { ...options, snapshotId: effectiveSnapshotId });
    }
    return escapeRun;
  }

  function nonEscapingRoots() {
    if (options.nonEscapingRoots) return options.nonEscapingRoots;
    return escape()?.nonEscapingRoots ?? new Set();
  }

  function setFor(addressValueId) {
    if (addressValueId == null) return null;
    const run = pointsTo();
    if (!run) return null;
    return run.pointsTo.get(String(addressValueId)) ?? null;
  }

  /**
   * Answers one alias question.
   *
   * `leftAccess`/`rightAccess` are the semantic memory accesses when the caller
   * has them. Without them only A1 runs, which is correct but coarser — region
   * identity alone cannot see field offsets.
   */
  function alias(leftRegion, rightRegion, context = {}) {
    const status = baseStatus({ signal: options.signal, ...options, snapshotId: effectiveSnapshotId, ...context });
    if (status.stopReason != null && status.completeness !== 'bounded') {
      return unknownAlias(status, [status.stopReason === 'cancelled' ? 'analysis-cancelled' : 'budget-exhausted']);
    }

    const a1 = a1RegionAlias(leftRegion, rightRegion, { ...options, status });
    const leftAccess = context.leftAccess ?? null;
    const rightAccess = context.rightAccess ?? null;
    if (!enableA2 || !leftAccess || !rightAccess) return a1;

    const leftSet = setFor(leftAccess.addressValueId);
    const rightSet = setFor(rightAccess.addressValueId);
    if (!leftSet || !rightSet) return a1;

    const run = pointsTo();
    const a2Status = mergeAnalysisStatus(status, run.status);
    const a2 = pointsToAlias(leftSet, rightSet, {
      status: a2Status,
      widthBitsLeft: leftAccess.widthBits,
      widthBitsRight: rightAccess.widthBits,
      nonEscapingRoots: nonEscapingRoots(),
    });

    if (contradicts(a1.relation, a2.relation)) {
      return unknownAlias(a2Status, ['unresolved-root'], {
        regionIds: a1.regionIds,
        proof: { conflict: { a1: a1.relation, a2: a2.relation } },
      });
    }
    if (STRENGTH[a2.relation] > STRENGTH[a1.relation]) {
      return createAliasResult({
        relation: a2.relation,
        reasonCodes: a2.reasonCodes,
        evidenceIds: [...a1.evidenceIds, ...a2.evidenceIds],
        regionIds: a1.regionIds,
        status: a2Status,
        proof: { layer: 'a2', a1: a1.relation, detail: a2.proof },
      });
    }
    return a1;
  }

  /** MemorySSA `queryAlias` provider. */
  function queryAlias(leftRegion, rightRegion, memorySsaContext = {}) {
    const result = alias(leftRegion, rightRegion, {
      leftAccess: memorySsaContext.left?.descriptor?.memory ?? null,
      rightAccess: memorySsaContext.right?.descriptor?.memory ?? null,
    });
    return {
      relation: result.relation,
      reasonCodes: result.reasonCodes,
      evidenceIds: result.evidenceIds,
      proof: {
        analyzerId: PHASE7_ALIAS_SOLVER_ID,
        analyzerVersion: PHASE7_ALIAS_SOLVER_VERSION,
        completeness: result.status.completeness,
        stopReason: result.status.stopReason,
        reasonCodes: result.reasonCodes,
      },
    };
  }

  return Object.freeze({
    alias,
    queryAlias,
    pointsToRun: pointsTo,
    refineMemorySsa,
    escapeRun: escape,
    analyzerId: PHASE7_ALIAS_SOLVER_ID,
    analyzerVersion: PHASE7_ALIAS_SOLVER_VERSION,
  });
}

/**
 * The public Phase 7 analysis boundary.
 *
 * This is the surface consumers ask instead of rebuilding logic: the UI, the AI
 * layer, the decompiler, the verifier and plugins all come through here. Phase
 * 8 consumes exactly this and nothing else — no reaching into private A1/A2/A3
 * solver state (§22), which is what lets the solvers be replaced later without
 * coupling transformation correctness to how they happen to work today.
 *
 * Every answer carries its `AnalysisStatus`, so completeness, budget class and
 * stop reason travel with the result rather than being inferred by the caller.
 * That is the difference between "no relationship" and "we ran out of budget
 * before we could look", and the whole phase depends on consumers being able to
 * tell them apart.
 */

import { createAnalysisStatus, isCompleteStatus, satisfiesRequirement } from './status.js';
import { createPhase7AliasSolver } from './alias/solver.js';
import { buildLocalFunctionSummary } from './summary/local.js';
import { solveInterproceduralSummaries } from './summary/interprocedural.js';
import { analyzeEscape } from './summary/escape.js';
import { summaryMayWriteRegion } from './summary/contract.js';
import { TypeConstraintGraph, selectedTypeIfCertain, reconstructStructuralType } from './types/graph.js';
import { applyDebugTypesToGraph } from './debug/provider.js';
import { DiscoveryProducerRegistry, fuseFunctionCandidates } from './discovery/fusion.js';
import { GENERIC_PRODUCERS } from './discovery/producers.js';
import {
  attachDiscoveryArtifactToSearchResult,
  createDiscoveryArtifact,
  DISCOVERY_ARTIFACT_DEFAULT_BUDGET,
  discoveryArtifactResourcePreflight,
  discoveryArtifactForRebuild,
  normalizeDiscoveryArtifactBudget,
  verifyDiscoveryReparse,
} from './discovery/artifact.js';
import {
  explainMemoryPath as explainMemoryPathQuery,
  reachingMemoryDefinition,
} from '../semantics/memoryssa/queries.js';

export const PHASE7_ANALYSIS_CONTRACT_VERSION = '1.0.0';

/**
 * Creates the analysis surface for one function's semantic artifacts.
 *
 * Everything is demand-driven: constructing this does no work, and each query
 * expands only as far as it needs to (P7-INV-009). One snapshot is bound at
 * construction so a single query cannot mix an old MemorySSA graph with a new
 * alias result (P7-INV-012).
 */
export function createAnalysisSurface({
  ir,
  cfg,
  ssa,
  memorySsa,
  snapshotId = 'snapshot-unbound',
  resolveRegion = null,
  options = {},
} = {}) {
  // MemorySSA answers are only published as complete when the binding itself
  // is complete (issues #3127/#3129). The binding-declared completeness is the
  // authority; the legacy option is a fallback, never an override.
  const memorySsaCompleteness = options.memorySsaBinding?.completeness ?? options.memorySsaCompleteness ?? 'complete';
  const solverOptions = {
    ...options,
    snapshotId,
    ...(ir?.functionId == null ? {} : { functionId: ir.functionId }),
    ...(ir?.contractVersion == null ? {} : { semanticIrVersion: ir.contractVersion }),
    ...(memorySsa == null ? {} : {
      memorySsa,
      memorySsaBinding: {
        ...(options.memorySsaBinding ?? {}),
        memorySsa,
        // Binding-declared identity is the authority; the current surface
        // values are fallbacks only (same principle as `completeness` above).
        // Overwriting a supplied stale identity here would launder it past
        // `prepareMemoryBoundary()`'s fail-closed checks.
        snapshotId: options.memorySsaBinding?.snapshotId ?? snapshotId,
        functionId: options.memorySsaBinding?.functionId ?? (ir?.functionId ?? null),
        semanticIrVersion: options.memorySsaBinding?.semanticIrVersion ?? (ir?.contractVersion ?? null),
        memorySsaBuildVersion: options.memorySsaBinding?.memorySsaBuildVersion ?? (memorySsa.buildVersion ?? null),
        completeness: memorySsaCompleteness,
      },
    }),
  };
  const solver = createPhase7AliasSolver({ ir, cfg, ssa, options: solverOptions });
  let localSummary = null;
  let escapeResult = null;
  let typeGraph = null;

  const status = (completeness, stopReason = null) => createAnalysisStatus({
    snapshotId,
    analyzerId: 'phase7.analysis.surface',
    analyzerVersion: PHASE7_ANALYSIS_CONTRACT_VERSION,
    completeness,
    stopReason,
  });

  /** Alias relation with proof and completeness. */
  function alias(leftRegion, rightRegion, context = {}) {
    return solver.alias(leftRegion, rightRegion, context);
  }

  /** The reaching memory definition for one load, with its status. */
  function reachingMemoryDef(useOrId) {
    if (!memorySsa || memorySsaCompleteness !== 'complete') {
      return { definition: null, status: status('unsupported', memorySsa ? 'dependency-mismatch' : 'dependency-missing') };
    }
    const definition = reachingMemoryDefinition(memorySsa, useOrId);
    // A clobber is a real answer — it says the link is blocked — so it is
    // returned rather than treated as a failure.
    return {
      definition,
      blocked: definition != null && definition.kind !== 'memory-def',
      status: status('complete'),
    };
  }

  /** The evidence path between a memory source and a sink. */
  function explainMemoryPath(useOrId, pathOptions = {}) {
    if (!memorySsa || memorySsaCompleteness !== 'complete') {
      return { path: null, status: status('unsupported', memorySsa ? 'dependency-mismatch' : 'dependency-missing') };
    }
    return { path: explainMemoryPathQuery(memorySsa, useOrId, pathOptions), status: status('complete') };
  }

  /** This function's summary, built on demand. */
  function functionSummary(summaryOptions = {}) {
    if (Object.keys(summaryOptions).length > 0) {
      return buildLocalFunctionSummary(ir, cfg, ssa, memorySsa, {
        snapshotId, resolveRegion, ...options, ...summaryOptions,
      });
    }
    if (localSummary == null) {
      localSummary = buildLocalFunctionSummary(ir, cfg, ssa, memorySsa, {
        snapshotId, resolveRegion, ...options,
      });
    }
    return localSummary;
  }

  /**
   * Memory effects of this function or of one call inside it.
   *
   * Answers `mayWrite` conservatively whenever the summary cannot prove
   * otherwise, which is what keeps an incomplete summary from reading as pure.
   */
  function memoryEffects({ regionId = null } = {}) {
    const { summary } = functionSummary();
    if (!summary) return { mayWrite: true, summary: null, status: status('partial', 'evidence-missing') };
    return {
      mayWrite: summaryMayWriteRegion(summary, regionId),
      reads: summary.memoryReadRegions,
      writes: summary.memoryWriteRegions,
      unknownCalls: summary.unknownCallEffects,
      summary,
      status: summary.status,
    };
  }

  /** Escape facts for this function's roots. */
  function escape() {
    if (escapeResult == null) {
      const pointsTo = solver.pointsToRun();
      escapeResult = pointsTo == null
        ? { escapes: [], nonEscapingRoots: new Set(), status: status('unsupported', 'dependency-missing') }
        : analyzeEscape(ir, cfg, ssa, pointsTo, { snapshotId, ...options });
    }
    return escapeResult;
  }

  /** The type constraint graph for this scope, created on first use. */
  function types() {
    if (typeGraph == null) {
      typeGraph = new TypeConstraintGraph({ snapshotId });
      ingestCanonicalTypeEvidence(typeGraph);
    }
    return typeGraph;
  }

  /**
   * Feeds the canonical evidence this surface was constructed with into the
   * type graph. Only identity-verified debug facts may become hard
   * constraints; everything else stays soft evidence, and presentation-side
   * data never reaches this path at all.
   */
  function ingestCanonicalTypeEvidence(graph) {
    const canonical = options.canonicalTypeEvidence;
    if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) return;
    const direct = Array.isArray(canonical.hardConstraints) ? canonical.hardConstraints : [];
    for (const constraint of direct) graph.addHardConstraint(constraint);
    const soft = Array.isArray(canonical.softEvidence) ? canonical.softEvidence : [];
    for (const evidence of soft) graph.addSoftEvidence(evidence);
    const debug = Array.isArray(canonical.debug) ? canonical.debug : [];
    for (const entry of debug) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const result = entry.result ?? entry.providerResult ?? null;
      const page = entry.page ?? entry.typesPage ?? null;
      if (!result || !page) continue;
      applyDebugTypesToGraph(graph, result, page);
    }
  }

  /** The full type answer for one entity, contradictions included. */
  function explainType(entityId, typeOptions = {}) {
    return types().solveEntity(entityId, typeOptions);
  }

  return Object.freeze({
    contractVersion: PHASE7_ANALYSIS_CONTRACT_VERSION,
    snapshotId,
    alias,
    reachingMemoryDef,
    explainMemoryPath,
    memoryEffects,
    functionSummary,
    escape,
    types,
    explainType,
    // Exposed so a consumer can inspect the points-to result it was given,
    // without any consumer being able to build a stronger answer of its own.
    pointsTo: solver.pointsToRun,
  });
}

/**
 * Interprocedural summaries for a set of roots.
 *
 * Separate from the per-function surface because it spans functions: the
 * surface is bound to one scope, and pretending otherwise would blur which
 * snapshot an answer came from.
 */
export function analyzeInterproceduralSummaries(input) {
  return solveInterproceduralSummaries(input);
}

/**
 * Function candidates fused from evidence.
 *
 * Callers may register additional target-specific producers; the fusion stays
 * generic regardless of what they register.
 */
export function functionCandidates({ input, architectureId = 'generic', producers = [], ...options } = {}) {
  const registry = new DiscoveryProducerRegistry();
  for (const producer of GENERIC_PRODUCERS) registry.register(producer);
  for (const producer of producers) registry.register(producer);
  const byteIntervals = options.byteIntervals ?? input?.image?.byteIntervals ?? [];
  const intervalCounts = new Map();
  if (Array.isArray(byteIntervals)) {
    for (const interval of byteIntervals) {
      if (typeof interval?.producerId !== 'string') continue;
      intervalCounts.set(interval.producerId, (intervalCounts.get(interval.producerId) ?? 0) + 1);
    }
  }
  const { evidence, producerRuns, resourceLimitReason } = registry.collect(input, architectureId, options, intervalCounts);
  const externalProducerIds = new Set(
    producerRuns.filter((run) => run.authorityClass === 'external').map((run) => run.id),
  );
  if (evidence.some((item) => item.authority === 'authoritative' && externalProducerIds.has(item.producerId))) {
    throw new TypeError('discovery-producer-authoritative-evidence-untrusted');
  }
  return fuseFunctionCandidates(evidence, {
    architectureId,
    ...options,
    producerRuns,
    byteIntervals,
    artifactResourceLimitReason: resourceLimitReason,
  });
}

import {
  applyLanguageMetadataTypesToGraph,
  languageMetadataFunctionEvidence,
} from '../metadata/index.js';

export {
  TypeConstraintGraph,
  isCompleteStatus,
  satisfiesRequirement,
  selectedTypeIfCertain,
  reconstructStructuralType,
  applyDebugTypesToGraph,
  applyLanguageMetadataTypesToGraph,
  languageMetadataFunctionEvidence,
  attachDiscoveryArtifactToSearchResult,
  createDiscoveryArtifact,
  DISCOVERY_ARTIFACT_DEFAULT_BUDGET,
  discoveryArtifactResourcePreflight,
  discoveryArtifactForRebuild,
  normalizeDiscoveryArtifactBudget,
  verifyDiscoveryReparse,
};

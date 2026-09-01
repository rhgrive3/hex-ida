/**
 * P7-4 — TypeConstraintGraph.
 *
 * Constraints are added per entity and per layer; solving produces one
 * `TypeResult` per entity. The graph's job is not to pick the nicest-looking
 * type — it is to keep hard facts, soft rankings and contradictions apart so
 * that a consumer can tell the difference (P7-INV-005, FM-6).
 *
 * Two rules decide every answer:
 *
 *  1. A layer with contradictory *hard* constraints has no selected type.
 *     Confidence is not lowered — selection is withheld entirely, because a
 *     "70% certain" answer between two mutually exclusive hard facts is a
 *     fabrication.
 *  2. Soft evidence orders the candidates that survive the hard constraints. It
 *     never introduces a candidate that a hard constraint excludes, and it
 *     never raises a conclusion to `certain`.
 *
 * Contradictions stay localized to the entity and layer that carry them, so one
 * bad debug record cannot poison unrelated components of the graph.
 *
 * HEX-C3-01 extends this shell with:
 *  - Recursive struct recovery (self-referential & mutually recursive pointers)
 *  - Cyclic type dependency graph condensation into SCCs via Tarjan's algorithm
 *  - Fixed-point iteration with finite recursion budgets
 *  - Ambiguity-preserving candidate sets and multi-entity graph solving
 *  - Deterministic, bounded, cancellation-safe structural type reconstruction
 */

import { deepFreeze, stableDigest, stableStringify } from '../../core/identity/index.js';
import { createAnalysisStatus, isCompleteStatus, weakestCompleteness } from '../status.js';
import {
  TYPE_LAYERS,
  claimsConflict,
  createContradiction,
  createHardConstraint,
  createSoftEvidence,
  createTypeClaim,
} from './constraints.js';
import { condenseTypeGraph } from './scc.js';

export const TYPE_GRAPH_ANALYZER_ID = 'phase7.types.constraint-graph';
export const TYPE_GRAPH_ANALYZER_VERSION = '1.1.0';
export const TYPE_RESULT_SCHEMA_VERSION = 1;
export const TYPE_GRAPH_RESULT_SCHEMA_VERSION = 1;

export const TYPE_GRAPH_DEFAULT_LIMITS = Object.freeze({
  maxConstraintsPerLayer: 4096,
  maxComparisonsPerLayer: 50000,
  maxContradictionsPerLayer: 1024,
  maxIterationsPerComponent: 16,
  maxComponents: 4096,
  maxNodes: 10000,
  maxEdges: 50000,
});

/**
 * Confidence bands. `certain` is reachable only from an uncontradicted hard
 * constraint; everything soft tops out at `probable`.
 */
export const TYPE_CONFIDENCE = Object.freeze(['certain', 'probable', 'possible', 'unknown']);

function fail(code) { throw new TypeError(code); }

function positiveLimit(value, fallback, code) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail(code);
  return number;
}

function defaultAlign(sizeBytes) {
  const size = Number(sizeBytes ?? 0);
  if (!Number.isSafeInteger(size) || size <= 0) return 1;
  if (size >= 8) return 8;
  if (size >= 4) return 4;
  if (size >= 2) return 2;
  return 1;
}

function mergedEvidenceIds(left, right) {
  return [...new Set([...(left ?? []), ...(right ?? [])])].sort();
}

function constraintOrderKey(constraint) {
  return stableDigest(constraint);
}

function hardIdentity(constraint) {
  return stableDigest({
    kind: constraint.kind,
    origin: constraint.origin,
    claim: constraint.claim,
    providerVersion: constraint.providerVersion,
    buildIdentity: constraint.buildIdentity,
    abiProfile: constraint.abiProfile,
  });
}

function softIdentity(evidence) {
  return stableDigest({
    kind: evidence.kind,
    origin: evidence.origin,
    claim: evidence.claim,
    weight: evidence.weight,
  });
}

function extractDependencies(claim) {
  const deps = new Set();
  const d = claim?.descriptor;
  if (!d || typeof d !== 'object') return deps;

  if (typeof d.targetEntityId === 'string' && d.targetEntityId.trim()) {
    deps.add(d.targetEntityId.trim());
  }
  if (typeof d.elementEntityId === 'string' && d.elementEntityId.trim()) {
    deps.add(d.elementEntityId.trim());
  }
  if (typeof d.entityId === 'string' && d.entityId.trim() && d.entityId !== claim.entityId) {
    deps.add(d.entityId.trim());
  }
  if (d.memberType && typeof d.memberType === 'object') {
    if (typeof d.memberType.targetEntityId === 'string' && d.memberType.targetEntityId.trim()) {
      deps.add(d.memberType.targetEntityId.trim());
    }
    if (typeof d.memberType.elementEntityId === 'string' && d.memberType.elementEntityId.trim()) {
      deps.add(d.memberType.elementEntityId.trim());
    }
    if (d.memberType.elementType?.targetEntityId) {
      deps.add(String(d.memberType.elementType.targetEntityId).trim());
    }
  }
  if (Array.isArray(d.members)) {
    for (const member of d.members) {
      if (member?.memberType?.targetEntityId) deps.add(String(member.memberType.targetEntityId).trim());
      if (member?.memberType?.elementEntityId) deps.add(String(member.memberType.elementEntityId).trim());
      if (member?.memberType?.elementType?.targetEntityId) deps.add(String(member.memberType.elementType.targetEntityId).trim());
    }
  }
  return deps;
}

function isMemberRecursive(member, entityId, sccMembers = []) {
  const target = member?.memberType?.targetEntityId ?? member?.targetEntityId ?? null;
  const elementTarget = member?.memberType?.elementType?.targetEntityId ?? member?.memberType?.elementEntityId ?? null;
  if (target === entityId || (target && sccMembers.includes(target))) return true;
  if (elementTarget === entityId || (elementTarget && sccMembers.includes(elementTarget))) return true;
  return member?.isRecursive === true || member?.memberType?.isRecursive === true;
}

function mergeCompatibleHardClaims(entityId, layer, claims, sccContext = null) {
  const distinct = [...new Map(claims.map((claim) => [claim.key, claim])).values()]
    .sort((left, right) => left.key.localeCompare(right.key));
  if (distinct.length === 1 && layer !== 'structural') return distinct[0];

  const descriptors = distinct.map((claim) => claim.descriptor);
  if (descriptors.some((descriptor) => !descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor))) return null;

  if (layer === 'structural') {
    const rawMembers = [];
    let explicitSize = null;
    let explicitAlign = null;

    for (const desc of descriptors) {
      if (Array.isArray(desc.members)) {
        rawMembers.push(...desc.members);
      } else if (desc.offset != null && desc.sizeBytes != null) {
        rawMembers.push(desc);
      }
      if (desc.sizeBytes != null && desc.offset == null) explicitSize = Number(desc.sizeBytes);
      if (desc.alignBytes != null && desc.offset == null) explicitAlign = Number(desc.alignBytes);
    }

    const membersByOffset = new Map();
    for (const member of rawMembers) {
      const offset = Number(member.offset ?? 0);
      const existing = membersByOffset.get(offset);
      if (existing) {
        if (stableStringify(existing) !== stableStringify(member)) return null;
      } else {
        membersByOffset.set(offset, member);
      }
    }

    const members = [...membersByOffset.values()].sort((left, right) => {
      const leftOffset = Number(left.offset ?? 0);
      const rightOffset = Number(right.offset ?? 0);
      return leftOffset - rightOffset || stableStringify(left).localeCompare(stableStringify(right));
    });

    const sccMembers = sccContext?.sccMembers ?? [entityId];
    const isRecursive = sccContext?.isRecursive === true
      || members.some((m) => isMemberRecursive(m, entityId, sccMembers));

    const updatedMembers = members.map((m) => {
      if (isMemberRecursive(m, entityId, sccMembers)) {
        const memberType = typeof m.memberType === 'object' && m.memberType
          ? { ...m.memberType, isRecursive: true }
          : { kind: 'pointer', targetEntityId: entityId, isRecursive: true };
        return { ...m, memberType, isRecursive: true };
      }
      return m;
    });

    let maxAlign = explicitAlign ?? 1;
    for (const m of updatedMembers) {
      const mAlign = Number(m.alignBytes ?? defaultAlign(m.sizeBytes));
      if (mAlign > maxAlign) maxAlign = mAlign;
    }

    let calculatedSize = explicitSize ?? 0;
    if (updatedMembers.length > 0) {
      const maxOffsetSpan = Math.max(...updatedMembers.map((m) => Number(m.offset ?? 0) + Number(m.sizeBytes ?? 0)));
      calculatedSize = maxAlign > 1
        ? Math.ceil(maxOffsetSpan / maxAlign) * maxAlign
        : maxOffsetSpan;
      if (explicitSize != null && explicitSize > calculatedSize) calculatedSize = explicitSize;
    }

    const baseDescriptor = updatedMembers[0] ?? descriptors[0];
    const structDescriptor = {
      ...baseDescriptor,
      kind: 'struct',
      members: updatedMembers,
      sizeBytes: baseDescriptor.sizeBytes ?? calculatedSize,
      totalSizeBytes: calculatedSize,
      alignBytes: maxAlign,
      isRecursive,
      recursiveIdentity: isRecursive ? entityId : null,
      sccMembers: sccMembers.length > 1 ? sccMembers : (isRecursive ? [entityId] : null),
    };

    return createTypeClaim({ layer, entityId, descriptor: structDescriptor });
  }

  const merged = {};
  if (layer === 'nominal') {
    const names = [...new Set(descriptors.flatMap((descriptor) => [descriptor.name, ...(descriptor.aliases ?? [])]).filter(Boolean))].sort();
    if (names.length > 0) {
      merged.name = names[0];
      merged.aliases = names;
    }
  }
  for (const descriptor of descriptors) {
    for (const [key, value] of Object.entries(descriptor).sort(([left], [right]) => left.localeCompare(right))) {
      if (layer === 'nominal' && (key === 'name' || key === 'aliases')) continue;
      if (!(key in merged)) merged[key] = value;
      else if (stableStringify(merged[key]) !== stableStringify(value)) return null;
    }
  }
  return createTypeClaim({ layer, entityId, descriptor: merged });
}

export class TypeConstraintGraph {
  constructor({ snapshotId = 'snapshot-unbound', budgetClass = null, limits = {} } = {}) {
    this.snapshotId = snapshotId;
    this.budgetClass = budgetClass;
    this.limits = Object.freeze({
      maxConstraintsPerLayer: positiveLimit(limits.maxConstraintsPerLayer, TYPE_GRAPH_DEFAULT_LIMITS.maxConstraintsPerLayer, 'type-graph-invalid-constraint-limit'),
      maxComparisonsPerLayer: positiveLimit(limits.maxComparisonsPerLayer, TYPE_GRAPH_DEFAULT_LIMITS.maxComparisonsPerLayer, 'type-graph-invalid-comparison-limit'),
      maxContradictionsPerLayer: positiveLimit(limits.maxContradictionsPerLayer, TYPE_GRAPH_DEFAULT_LIMITS.maxContradictionsPerLayer, 'type-graph-invalid-contradiction-limit'),
      maxIterationsPerComponent: positiveLimit(limits.maxIterationsPerComponent, TYPE_GRAPH_DEFAULT_LIMITS.maxIterationsPerComponent, 'type-graph-invalid-iteration-limit'),
      maxComponents: positiveLimit(limits.maxComponents, TYPE_GRAPH_DEFAULT_LIMITS.maxComponents, 'type-graph-invalid-component-limit'),
      maxNodes: positiveLimit(limits.maxNodes, TYPE_GRAPH_DEFAULT_LIMITS.maxNodes, 'type-graph-invalid-node-limit'),
      maxEdges: positiveLimit(limits.maxEdges, TYPE_GRAPH_DEFAULT_LIMITS.maxEdges, 'type-graph-invalid-edge-limit'),
    });
    /** entityId -> layer -> bounded constraint bucket */
    this.entities = new Map();
    /** entityId -> Set<dependentEntityId> */
    this.dependencies = new Map();
    this.userConstraintDigests = new Set();
  }

  #bucket(entityId, layer) {
    if (!this.entities.has(entityId)) this.entities.set(entityId, new Map());
    const layers = this.entities.get(entityId);
    if (!layers.has(layer)) {
      layers.set(layer, {
        hard: [],
        soft: [],
        hardIndex: new Map(),
        softIndex: new Map(),
        truncated: false,
      });
    }
    return layers.get(layer);
  }

  #recordDependencies(claim) {
    const deps = extractDependencies(claim);
    if (deps.size === 0) return;
    if (!this.dependencies.has(claim.entityId)) {
      this.dependencies.set(claim.entityId, new Set());
    }
    const current = this.dependencies.get(claim.entityId);
    for (const dep of deps) current.add(dep);
  }

  dependenciesOf(entityId) {
    return new Set(this.dependencies.get(entityId) ?? []);
  }

  addHardConstraint(input) {
    const constraint = createHardConstraint(input);
    const bucket = this.#bucket(constraint.claim.entityId, constraint.claim.layer);
    const identity = hardIdentity(constraint);
    const duplicateIndex = bucket.hardIndex.get(identity);
    if (duplicateIndex == null) {
      if (bucket.hard.length + bucket.soft.length >= this.limits.maxConstraintsPerLayer) {
        bucket.truncated = true;
      } else {
        bucket.hardIndex.set(identity, bucket.hard.length);
        bucket.hard.push(constraint);
      }
    } else {
      const existing = bucket.hard[duplicateIndex];
      const evidenceIds = mergedEvidenceIds(existing.evidenceIds, constraint.evidenceIds);
      if (evidenceIds.length !== existing.evidenceIds.length) {
        bucket.hard[duplicateIndex] = createHardConstraint({
          kind: existing.kind,
          origin: existing.origin,
          claim: existing.claim,
          evidenceIds,
          providerVersion: existing.providerVersion,
          buildIdentity: existing.buildIdentity,
          abiProfile: existing.abiProfile,
        });
      }
    }
    this.#recordDependencies(constraint.claim);
    if (constraint.origin === 'user-approved') {
      this.userConstraintDigests.add(stableDigest(constraint.claim));
    }
    return constraint;
  }

  addSoftEvidence(input) {
    const evidence = createSoftEvidence(input);
    const bucket = this.#bucket(evidence.claim.entityId, evidence.claim.layer);
    const identity = softIdentity(evidence);
    const duplicateIndex = bucket.softIndex.get(identity);
    if (duplicateIndex == null) {
      if (bucket.hard.length + bucket.soft.length >= this.limits.maxConstraintsPerLayer) {
        bucket.truncated = true;
      } else {
        bucket.softIndex.set(identity, bucket.soft.length);
        bucket.soft.push(evidence);
      }
    } else {
      const existing = bucket.soft[duplicateIndex];
      const evidenceIds = mergedEvidenceIds(existing.evidenceIds, evidence.evidenceIds);
      if (evidenceIds.length !== existing.evidenceIds.length) {
        bucket.soft[duplicateIndex] = createSoftEvidence({
          kind: existing.kind,
          origin: existing.origin,
          claim: existing.claim,
          weight: existing.weight,
          evidenceIds,
        });
      }
    }
    return evidence;
  }

  entityIds() {
    return [...this.entities.keys()].sort();
  }

  /** Every layer's answer for one entity. */
  solveEntity(entityId, { signal = null, sccContext = null } = {}) {
    const layers = this.entities.get(entityId);
    if (!layers) {
      return createTypeResult({
        entityId,
        status: this.#status('unsupported', 'evidence-missing'),
        layers: {},
      });
    }
    if (signal?.aborted) {
      return createTypeResult({ entityId, status: this.#status('partial', 'cancelled'), layers: {} });
    }

    const effectiveSccContext = sccContext ?? {
      isRecursive: this.dependenciesOf(entityId).has(entityId),
      sccMembers: [entityId],
    };

    const solvedLayers = {};
    let stopReason = null;
    for (const layer of TYPE_LAYERS) {
      const bucket = layers.get(layer);
      if (!bucket) continue;
      const solved = solveLayer(entityId, layer, bucket, {
        signal,
        maxComparisons: this.limits.maxComparisonsPerLayer,
        maxContradictions: this.limits.maxContradictionsPerLayer,
        sccContext: effectiveSccContext,
      });
      solvedLayers[layer] = solved.layer;
      if (solved.stopReason === 'cancelled') {
        stopReason = 'cancelled';
        break;
      }
      if (solved.stopReason === 'budget-exhausted') stopReason = stopReason ?? 'budget-exhausted';
    }
    return createTypeResult({
      entityId,
      status: stopReason === 'cancelled'
        ? this.#status('partial', 'cancelled')
        : stopReason === 'budget-exhausted'
          ? this.#status('truncated', 'budget-exhausted')
          : this.#status('complete', null),
      layers: solvedLayers,
      userConstrained: [...this.userConstraintDigests].some((digest) => (
        Object.values(solvedLayers).some((solved) => solved.hardConstraints.some((constraint) => (
          constraint.origin === 'user-approved' && stableDigest(constraint.claim) === digest
        )))
      )),
    });
  }

  /**
   * Solves all registered entities across the type graph, handling recursive SCCs
   * in bottom-up reverse topological order using fixed-point iteration.
   */
  solveGraph({ roots = null, maxIterationsPerComponent = null, signal = null } = {}) {
    const iterationLimit = maxIterationsPerComponent != null
      ? positiveLimit(maxIterationsPerComponent, this.limits.maxIterationsPerComponent, 'type-graph-invalid-iteration-limit')
      : this.limits.maxIterationsPerComponent;

    const allEntities = (roots ? [...new Set(roots)] : this.entityIds())
      .filter((id) => this.entities.has(id))
      .sort();

    const {
      components,
      recursiveComponents,
      isRecursiveMap,
      sccMembersMap,
      truncated,
      cancelled,
    } = condenseTypeGraph(allEntities, (id) => this.dependenciesOf(id), {
      signal,
      maxComponents: this.limits.maxComponents,
      maxNodes: this.limits.maxNodes,
      maxEdges: this.limits.maxEdges,
    });

    if (cancelled || signal?.aborted) {
      return createTypeGraphResult({
        snapshotId: this.snapshotId,
        results: new Map(),
        components,
        recursiveComponents,
        iterations: 0,
        status: this.#status('partial', 'cancelled'),
      });
    }

    if (truncated) {
      return createTypeGraphResult({
        snapshotId: this.snapshotId,
        results: new Map(),
        components,
        recursiveComponents,
        iterations: 0,
        status: this.#status('truncated', 'budget-exhausted'),
      });
    }

    const solvedResults = new Map();
    let totalIterations = 0;
    let worstStopReason = null;
    let worstCompleteness = 'complete';

    for (const component of components) {
      if (signal?.aborted) {
        return createTypeGraphResult({
          snapshotId: this.snapshotId,
          results: solvedResults,
          components,
          recursiveComponents,
          iterations: totalIterations,
          status: this.#status('partial', 'cancelled'),
        });
      }

      const isRecursive = isRecursiveMap.get(component[0]) === true;
      const sccMembers = sccMembersMap.get(component[0]) ?? component;
      const sccContext = { isRecursive, sccMembers };

      let iterations = 0;
      let changed = true;
      let converged = true;
      const componentDigests = new Map();

      while (changed) {
        if (iterations >= iterationLimit) {
          converged = false;
          break;
        }
        iterations += 1;
        totalIterations += 1;
        changed = false;

        for (const entityId of component) {
          if (!this.entities.has(entityId)) continue;
          const solved = this.solveEntity(entityId, { signal, sccContext });
          const digest = stableDigest(solved);
          if (componentDigests.get(entityId) !== digest) {
            componentDigests.set(entityId, digest);
            solvedResults.set(entityId, solved);
            changed = true;
          }
        }
        if (!isRecursive) break;
      }

      if (!converged) {
        for (const entityId of component) {
          const existing = solvedResults.get(entityId);
          const truncatedResult = createTypeResult({
            entityId,
            layers: existing?.layers ?? {},
            userConstrained: existing?.userConstrained ?? false,
            status: this.#status('truncated', 'iteration-limit'),
          });
          solvedResults.set(entityId, truncatedResult);
        }
        worstStopReason = 'iteration-limit';
        worstCompleteness = weakestCompleteness(worstCompleteness, 'truncated');
      }
    }

    for (const result of solvedResults.values()) {
      worstCompleteness = weakestCompleteness(worstCompleteness, result.status.completeness);
      if (result.status.stopReason && !worstStopReason) worstStopReason = result.status.stopReason;
    }
    if (worstCompleteness === 'complete') worstStopReason = null;
    else if (!worstStopReason) worstStopReason = 'evidence-missing';

    return createTypeGraphResult({
      snapshotId: this.snapshotId,
      results: solvedResults,
      components,
      recursiveComponents,
      iterations: totalIterations,
      status: this.#status(worstCompleteness, worstStopReason),
    });
  }

  #status(completeness, stopReason) {
    return createAnalysisStatus({
      snapshotId: this.snapshotId,
      analyzerId: TYPE_GRAPH_ANALYZER_ID,
      analyzerVersion: TYPE_GRAPH_ANALYZER_VERSION,
      completeness,
      budgetClass: this.budgetClass,
      stopReason,
    });
  }
}

function solveLayer(entityId, layer, bucket, { signal, maxComparisons, maxContradictions, sccContext = null }) {
  const contradictions = [];
  let comparisons = 0;
  let stopReason = bucket.truncated ? 'budget-exhausted' : null;

  const canCompare = () => {
    if (signal?.aborted) {
      stopReason = 'cancelled';
      return false;
    }
    if (comparisons >= maxComparisons) {
      stopReason = 'budget-exhausted';
      return false;
    }
    comparisons += 1;
    return true;
  };

  if (!stopReason) {
    hardPairs: for (let i = 0; i < bucket.hard.length; i += 1) {
      for (let j = i + 1; j < bucket.hard.length; j += 1) {
        if (!canCompare()) break hardPairs;
        if (claimsConflict(bucket.hard[i].claim, bucket.hard[j].claim)) {
          const pair = [bucket.hard[i], bucket.hard[j]].sort((left, right) => constraintOrderKey(left).localeCompare(constraintOrderKey(right)));
          contradictions.push(createContradiction({
            layer,
            entityId,
            left: pair[0],
            right: pair[1],
            detail: `hard constraints disagree: ${pair[0].kind} vs ${pair[1].kind}`,
          }));
          if (contradictions.length >= maxContradictions) {
            stopReason = 'budget-exhausted';
            break hardPairs;
          }
        }
      }
    }
  }

  const hardClaims = bucket.hard.map((constraint) => constraint.claim);
  const candidates = new Map();
  const add = (claim, weight, source) => {
    const existing = candidates.get(claim.key);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      existing.sources.add(source);
      return;
    }
    candidates.set(claim.key, { claim, weight, sources: new Set([source]) });
  };
  for (const constraint of bucket.hard) add(constraint.claim, 1, 'hard');
  if (!stopReason) {
    softEvidence: for (const evidence of bucket.soft) {
      let conflicts = false;
      for (const hard of hardClaims) {
        if (!canCompare()) break softEvidence;
        if (claimsConflict(hard, evidence.claim)) {
          conflicts = true;
          break;
        }
      }
      if (!conflicts) add(evidence.claim, evidence.weight, 'soft');
    }
  }

  const ranked = [...candidates.values()].sort((left, right) => (
    right.weight - left.weight || left.claim.key.localeCompare(right.claim.key)
  ));

  let selected = null;
  let confidence = 'unknown';
  if (stopReason != null) {
    selected = null;
    confidence = 'unknown';
  } else if (contradictions.length > 0) {
    confidence = 'unknown';
  } else if (bucket.hard.length > 0) {
    selected = mergeCompatibleHardClaims(entityId, layer, hardClaims, sccContext);
    confidence = selected == null ? 'unknown' : 'certain';
  } else if (ranked.length === 1) {
    selected = ranked[0].claim;
    confidence = ranked[0].weight >= 0.75 ? 'probable' : 'possible';
  } else if (ranked.length > 1 && ranked[0].weight > ranked[1].weight) {
    selected = ranked[0].claim;
    confidence = ranked[0].weight >= 0.75 ? 'probable' : 'possible';
  } else if (ranked.length > 1) {
    confidence = 'unknown';
  }

  return {
    stopReason,
    layer: deepFreeze({
      layer,
      candidates: deepFreeze(ranked.map((entry) => ({
        claim: entry.claim,
        weight: entry.weight,
        sources: [...entry.sources].sort(),
      }))),
      selected,
      confidence,
      hardConstraints: deepFreeze([...bucket.hard].sort((left, right) => constraintOrderKey(left).localeCompare(constraintOrderKey(right)))),
      softEvidence: deepFreeze([...bucket.soft].sort((left, right) => constraintOrderKey(left).localeCompare(constraintOrderKey(right)))),
      contradictions: deepFreeze(contradictions.sort((left, right) => stableDigest(left).localeCompare(stableDigest(right)))),
    }),
  };
}

export function createTypeResult(input = {}) {
  const layers = input.layers ?? {};
  const contradictions = Object.values(layers).flatMap((layer) => layer.contradictions ?? []);
  const status = input.status;
  if (!status) fail('type-result-status-required');
  return deepFreeze({
    schemaVersion: TYPE_RESULT_SCHEMA_VERSION,
    entityId: String(input.entityId ?? ''),
    layers: deepFreeze(layers),
    contradictions: deepFreeze(contradictions),
    userConstrained: input.userConstrained === true,
    status,
  });
}

export function createTypeGraphResult(input = {}) {
  const status = input.status;
  if (!status) fail('type-graph-result-status-required');
  const rawMap = input.results instanceof Map ? input.results : new Map(Object.entries(input.results ?? {}));
  const readOnlyMap = new Map();
  for (const [key, value] of rawMap) {
    readOnlyMap.set(key, value);
  }
  readOnlyMap.set = () => { throw new TypeError('TypeGraphResult.results is read-only'); };
  readOnlyMap.delete = () => { throw new TypeError('TypeGraphResult.results is read-only'); };
  readOnlyMap.clear = () => { throw new TypeError('TypeGraphResult.results is read-only'); };

  return Object.freeze({
    schemaVersion: TYPE_GRAPH_RESULT_SCHEMA_VERSION,
    snapshotId: String(input.snapshotId ?? 'snapshot-unbound'),
    results: readOnlyMap,
    components: deepFreeze((input.components ?? []).map((c) => [...c].sort())),
    recursiveComponents: deepFreeze((input.recursiveComponents ?? []).map((c) => [...c].sort())),
    iterations: Number(input.iterations ?? 0),
    status,
  });
}

/**
 * Reconstructs a canonical structural type definition from solved TypeResult
 * or TypeConstraintGraph.
 */
export function reconstructStructuralType(graphOrResult, entityId, options = {}) {
  let result = null;
  if (graphOrResult instanceof TypeConstraintGraph) {
    result = graphOrResult.solveEntity(entityId, options);
  } else if (graphOrResult && graphOrResult.layers) {
    result = graphOrResult;
  } else {
    return null;
  }

  const structuralLayer = result?.layers?.structural;
  const nominalLayer = result?.layers?.nominal;
  const selected = structuralLayer?.selected?.descriptor;
  const nominalName = nominalLayer?.selected?.descriptor?.name ?? null;

  if (!selected) {
    return deepFreeze({
      kind: 'unknown',
      entityId: String(entityId ?? result?.entityId ?? ''),
      name: nominalName,
      sizeBytes: null,
      alignBytes: null,
      members: [],
      isRecursive: false,
      recursiveIdentity: null,
      sccMembers: null,
      confidence: structuralLayer?.confidence ?? 'unknown',
      status: result?.status ?? null,
    });
  }

  const members = (selected.members ?? []).map((m) => deepFreeze({
    offset: Number(m.offset ?? 0),
    sizeBytes: Number(m.sizeBytes ?? 0),
    alignBytes: Number(m.alignBytes ?? defaultAlign(m.sizeBytes)),
    name: m.fieldName ?? m.name ?? null,
    type: deepFreeze(m.memberType ?? { kind: 'unknown' }),
  }));

  let maxAlign = selected.alignBytes != null ? Number(selected.alignBytes) : 1;
  for (const m of members) {
    if (m.alignBytes > maxAlign) maxAlign = m.alignBytes;
  }

  let totalSize = selected.totalSizeBytes != null
    ? Number(selected.totalSizeBytes)
    : selected.sizeBytes != null
      ? Number(selected.sizeBytes)
      : null;

  if (members.length > 0) {
    const maxOffsetSpan = Math.max(...members.map((m) => m.offset + m.sizeBytes));
    if (totalSize == null || totalSize < maxOffsetSpan) {
      totalSize = maxAlign > 1 ? Math.ceil(maxOffsetSpan / maxAlign) * maxAlign : maxOffsetSpan;
    }
  }

  return deepFreeze({
    kind: selected.kind ?? 'struct',
    entityId: String(entityId ?? result?.entityId ?? ''),
    name: nominalName,
    sizeBytes: totalSize,
    alignBytes: maxAlign,
    isRecursive: selected.isRecursive === true,
    recursiveIdentity: selected.recursiveIdentity ?? (selected.isRecursive ? String(entityId ?? result?.entityId ?? '') : null),
    sccMembers: selected.sccMembers ?? null,
    members: deepFreeze(members),
    confidence: structuralLayer.confidence,
    status: result.status,
  });
}

/**
 * The one question a consumer may ask before printing a type as fact.
 *
 * It requires an uncontradicted hard constraint *and* a sound status, so a
 * cancelled or budget-limited solve can never present a certain type.
 */
export function selectedTypeIfCertain(result, layer) {
  const solved = result?.layers?.[layer];
  if (!solved) return null;
  if (!isCompleteStatus(result.status)) return null;
  if (solved.contradictions.length > 0) return null;
  if (solved.confidence !== 'certain') return null;
  return solved.selected;
}

/** Counts conclusions presented as certain, for the false-certainty metric. */
export function certainConclusions(result) {
  if (!isCompleteStatus(result?.status)) return [];
  return Object.entries(result.layers ?? {})
    .filter(([, solved]) => solved.confidence === 'certain' && solved.contradictions.length === 0)
    .map(([layer, solved]) => ({ layer, claim: solved.selected }));
}

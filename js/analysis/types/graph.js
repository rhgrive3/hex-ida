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
 */

import { deepFreeze, stableDigest, stableStringify } from '../../core/identity/index.js';
import { createAnalysisStatus, isCompleteStatus } from '../status.js';
import {
  TYPE_LAYERS,
  claimsConflict,
  createContradiction,
  createHardConstraint,
  createSoftEvidence,
  createTypeClaim,
} from './constraints.js';

export const TYPE_GRAPH_ANALYZER_ID = 'phase7.types.constraint-graph';
export const TYPE_GRAPH_ANALYZER_VERSION = '1.0.0';
export const TYPE_RESULT_SCHEMA_VERSION = 1;
export const TYPE_GRAPH_DEFAULT_LIMITS = Object.freeze({
  maxConstraintsPerLayer: 4096,
  maxComparisonsPerLayer: 50000,
  maxContradictionsPerLayer: 1024,
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

function mergeCompatibleHardClaims(entityId, layer, claims) {
  const distinct = [...new Map(claims.map((claim) => [claim.key, claim])).values()]
    .sort((left, right) => left.key.localeCompare(right.key));
  if (distinct.length === 1) return distinct[0];

  const descriptors = distinct.map((claim) => claim.descriptor);
  if (descriptors.some((descriptor) => !descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor))) return null;
  if (layer === 'structural') {
    const members = [...descriptors].sort((left, right) => {
      const leftOffset = Number(left.offset ?? 0);
      const rightOffset = Number(right.offset ?? 0);
      return leftOffset - rightOffset || stableStringify(left).localeCompare(stableStringify(right));
    });
    return createTypeClaim({ layer, entityId, descriptor:{ ...members[0], members } });
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
    for (const [key,value] of Object.entries(descriptor).sort(([left],[right]) => left.localeCompare(right))) {
      if (layer === 'nominal' && (key === 'name' || key === 'aliases')) continue;
      if (!(key in merged)) merged[key] = value;
      else if (stableStringify(merged[key]) !== stableStringify(value)) return null;
    }
  }
  return createTypeClaim({ layer, entityId, descriptor:merged });
}

export class TypeConstraintGraph {
  constructor({ snapshotId = 'snapshot-unbound', budgetClass = null, limits = {} } = {}) {
    this.snapshotId = snapshotId;
    this.budgetClass = budgetClass;
    this.limits = Object.freeze({
      maxConstraintsPerLayer: positiveLimit(limits.maxConstraintsPerLayer, TYPE_GRAPH_DEFAULT_LIMITS.maxConstraintsPerLayer, 'type-graph-invalid-constraint-limit'),
      maxComparisonsPerLayer: positiveLimit(limits.maxComparisonsPerLayer, TYPE_GRAPH_DEFAULT_LIMITS.maxComparisonsPerLayer, 'type-graph-invalid-comparison-limit'),
      maxContradictionsPerLayer: positiveLimit(limits.maxContradictionsPerLayer, TYPE_GRAPH_DEFAULT_LIMITS.maxContradictionsPerLayer, 'type-graph-invalid-contradiction-limit'),
    });
    /** entityId -> layer -> bounded constraint bucket */
    this.entities = new Map();
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
        });
      }
    }
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
  solveEntity(entityId, { signal = null } = {}) {
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

    const solvedLayers = {};
    let stopReason = null;
    for (const layer of TYPE_LAYERS) {
      const bucket = layers.get(layer);
      if (!bucket) continue;
      const solved = solveLayer(entityId, layer, bucket, {
        signal,
        maxComparisons: this.limits.maxComparisonsPerLayer,
        maxContradictions: this.limits.maxContradictionsPerLayer,
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

function solveLayer(entityId, layer, bucket, { signal, maxComparisons, maxContradictions }) {
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

  // Candidates that survive the hard constraints. A soft claim that conflicts
  // with any hard one is excluded outright rather than down-weighted: soft
  // evidence ranks, it does not overrule.
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
    // A bounded/cancelled layer has not examined all potentially conflicting
    // evidence. Never publish a strong selection from an incomplete solve.
    selected = null;
    confidence = 'unknown';
  } else if (contradictions.length > 0) {
    // Withhold selection entirely. Picking the highest-scoring side of a hard
    // contradiction is precisely the false certainty this layer exists to stop.
    confidence = 'unknown';
  } else if (bucket.hard.length > 0) {
    selected = mergeCompatibleHardClaims(entityId, layer, hardClaims);
    confidence = selected == null ? 'unknown' : 'certain';
  } else if (ranked.length === 1) {
    selected = ranked[0].claim;
    confidence = ranked[0].weight >= 0.75 ? 'probable' : 'possible';
  } else if (ranked.length > 1 && ranked[0].weight > ranked[1].weight) {
    selected = ranked[0].claim;
    confidence = ranked[0].weight >= 0.75 ? 'probable' : 'possible';
  } else if (ranked.length > 1) {
    // A tie between soft candidates is ambiguity, not a coin flip.
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

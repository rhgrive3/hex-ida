/**
 * P7-6 — generic function-discovery fusion.
 *
 * The key rule (§12.1): **evidence producers may be target-specific; evidence
 * fusion is generic.** Nothing in this file knows what a prologue looks like,
 * what a link register is, or how any architecture encodes a call. It sees
 * typed evidence records with addresses and authority classes, and combines
 * them.
 *
 * That is not stylistic. The moment the fusion learns one architecture's
 * conventions, every other architecture's results start depending on how well
 * that one is modelled, and the cross-architecture metamorphic laws stop being
 * meaningful.
 *
 * Start and extent are fused separately and can disagree: a start can be exact
 * while its extent stays unknown, which is the correct answer far more often
 * than a single contiguous body would be.
 */

import { createAnalysisStatus } from '../status.js';
import {
  createDiscoveryEvidence,
  createRegion,
  hasExactStart,
} from './candidates.js';
import { deriveFunctionCandidates } from './fusion-rules.js';
import { isCanonicalDiscoveryProducer } from './producers.js';
import {
  createDiscoveryArtifact,
  discoveryArtifactResourcePreflight,
  normalizeDiscoveryArtifactBudget,
} from './artifact.js';

export const DISCOVERY_ANALYZER_ID = 'phase7.discovery.fusion';
export const DISCOVERY_ANALYZER_VERSION = '2.0.0';

export const DISCOVERY_DEFAULT_BUDGET = Object.freeze({
  maxCandidates: 200000,
  maxEvidencePerCandidate: 64,
});

const ISSUED_CANONICAL_PRODUCER_RUNS = new WeakSet();

export function isFactoryIssuedCanonicalProducerRun(run) {
  return !!run && ISSUED_CANONICAL_PRODUCER_RUNS.has(run);
}

function ownOption(value, key, code) {
  let item;
  try { item = Object.getOwnPropertyDescriptor(value, key); }
  catch { throw new TypeError(code); }
  if (item == null) return undefined;
  if (!Object.hasOwn(item, 'value')) throw new TypeError(code);
  return item.value;
}

function arrayItems(value, code) {
  if (!Array.isArray(value)) throw new TypeError(code);
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor == null || !Object.hasOwn(descriptor, 'value')) throw new TypeError(code);
    items.push(descriptor.value);
  }
  return items;
}

/**
 * A registry of evidence producers.
 *
 * Producers are registered per architecture (or as `generic`). The fusion calls
 * them and never inspects their internals, which is what keeps the boundary
 * one-directional.
 */
export class DiscoveryProducerRegistry {
  constructor() {
    this.producers = new Map();
  }

  register(producer) {
    if (!producer || typeof producer !== 'object' || Array.isArray(producer)) throw new TypeError('discovery-producer-must-implement-produce');
    const produce = ownOption(producer, 'produce', 'discovery-producer-must-implement-produce');
    if (typeof produce !== 'function') throw new TypeError('discovery-producer-must-implement-produce');
    // Registry identity and evidence provenance must be the same canonical
    // string authority. A structured id must not coerce into a real registry
    // key (String(['p1']) === 'p1') while the raw value keeps flowing into
    // evidence provenance.
    const id = ownOption(producer, 'id', 'discovery-producer-id-required');
    if (typeof id !== 'string' || !id) throw new TypeError('discovery-producer-id-required');
    if (this.producers.has(id)) throw new TypeError(`discovery-producer-id-duplicate:${id}`);
    const version = ownOption(producer, 'version', 'discovery-producer-version-invalid');
    if (version != null && (typeof version !== 'string' || !version)) {
      throw new TypeError('discovery-producer-version-invalid');
    }
    const architectureId = ownOption(producer, 'architectureId', 'discovery-producer-architecture-invalid');
    if (architectureId != null && (typeof architectureId !== 'string' || !architectureId)) {
      throw new TypeError('discovery-producer-architecture-invalid');
    }
    this.producers.set(id, Object.freeze({
      id, version, architectureId, produce,
      authorityClass: isCanonicalDiscoveryProducer(producer) ? 'canonical' : 'external',
    }));
    return this;
  }

  /** Producers applicable to one architecture, in deterministic order. */
  for(architectureId) {
    return [...this.producers.values()]
      .filter((producer) => producer.architectureId == null || producer.architectureId === architectureId)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  collect(input, architectureId, options = {}, intervalCounts = new Map()) {
    const artifactBudget = normalizeDiscoveryArtifactBudget(
      ownOption(options, 'artifactBudget', 'discovery-artifact-budget-invalid') ?? {},
    );
    const evidence = [];
    const producerIds = [];
    const producerRuns = [];
    for (const producer of this.for(architectureId)) {
      if (options.signal?.aborted) break;
      const raw = producer.produce(input, options) ?? [];
      const produced = Array.isArray(raw)
        ? raw
        : ownOption(raw, 'evidence', `discovery-producer-result-invalid:${producer.id}`);
      if (!Array.isArray(produced)) throw new TypeError(`discovery-producer-result-invalid:${producer.id}`);
      const declaredStatus = Array.isArray(raw)
        ? null
        : ownOption(raw, 'status', `discovery-producer-status-invalid:${producer.id}`);
      if (declaredStatus != null && (!declaredStatus || typeof declaredStatus !== 'object' || Array.isArray(declaredStatus))) {
        throw new TypeError(`discovery-producer-status-invalid:${producer.id}`);
      }
      const completeness = declaredStatus == null ? 'complete'
        : ownOption(declaredStatus, 'completeness', `discovery-producer-completeness-invalid:${producer.id}`) ?? 'complete';
      if (!['complete', 'bounded', 'partial', 'truncated', 'unsupported'].includes(completeness)) {
        throw new TypeError(`discovery-producer-completeness-invalid:${producer.id}`);
      }
      const stopReason = declaredStatus == null
        ? (completeness === 'complete' ? null : 'evidence-missing')
        : ownOption(declaredStatus, 'stopReason', `discovery-producer-stop-reason-invalid:${producer.id}`)
          ?? (completeness === 'complete' ? null : 'evidence-missing');
      const producerVersion = producer.version ?? '1';
      const authorityClass = producer.authorityClass;
      if (evidence.length + produced.length > artifactBudget.maxTotalEvidence) {
        return {
          evidence: [],
          producerIds,
          producerRuns,
          resourceLimitReason: 'total-evidence',
        };
      }
      for (const item of arrayItems(produced, `discovery-producer-evidence-descriptor-invalid:${producer.id}`)) {
        const canonical = createDiscoveryEvidence(item, {
          producerId: producer.id,
          producerVersion,
          architectureId: producer.architectureId ?? null,
          ...(options.binaryId == null ? {} : { binaryId: options.binaryId }),
          ...(options.sourceHash == null ? {} : { sourceHash: options.sourceHash }),
          ...(options.snapshotId == null ? {} : { snapshotId: options.snapshotId }),
        });
        evidence.push(canonical);
      }
      producerIds.push(producer.id);
      const run = Object.freeze({
        id: producer.id,
        version: producerVersion,
        architectureId: producer.architectureId ?? null,
        completeness: options.signal?.aborted ? 'partial' : completeness,
        stopReason: options.signal?.aborted ? 'cancelled' : stopReason,
        evidenceCount: produced.length,
        intervalCount: intervalCounts.get(producer.id) ?? 0,
        authorityClass,
      });
      if (authorityClass === 'canonical') ISSUED_CANONICAL_PRODUCER_RUNS.add(run);
      producerRuns.push(run);
    }
    return { evidence, producerIds, producerRuns, resourceLimitReason: null };
  }
}

function primitiveInteger(value, code) {
  const type = typeof value;
  if (type !== 'bigint' && type !== 'string' && !(type === 'number' && Number.isSafeInteger(value))) {
    throw new TypeError(code);
  }
  try {
    return BigInt(value);
  } catch {
    throw new TypeError(code);
  }
}

/**
 * Fuses all evidence into candidates.
 *
 * `evidence` is a flat list from `DiscoveryProducerRegistry.collect`, or any
 * caller that produces the same shape.
 */
export function fuseFunctionCandidates(evidence, options = {}) {
  if (!Array.isArray(evidence)) throw new TypeError('discovery-fusion-evidence-invalid');
  // Budget values are analysis-coverage authorities. Only primitive positive
  // safe-integer numbers may define one; structured values must not coerce via
  // the comparison operators' ToNumber (['1'] -> 1, true -> 1).
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('discovery-fusion-options-invalid');
  const rawBudget = ownOption(options, 'budget', 'discovery-fusion-budget-invalid') ?? {};
  if (rawBudget == null || typeof rawBudget !== 'object' || Array.isArray(rawBudget)) throw new TypeError('discovery-fusion-budget-invalid');
  const budgetValue = (value, fallback, name) => {
    if (value == null) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`discovery-fusion-budget-${name}-invalid`);
    return value;
  };
  const budget = {
    maxCandidates: budgetValue(
      ownOption(rawBudget, 'maxCandidates', 'discovery-fusion-budget-maxCandidates-invalid'),
      DISCOVERY_DEFAULT_BUDGET.maxCandidates,
      'maxCandidates',
    ),
    maxEvidencePerCandidate: budgetValue(
      ownOption(rawBudget, 'maxEvidencePerCandidate', 'discovery-fusion-budget-maxEvidencePerCandidate-invalid'),
      DISCOVERY_DEFAULT_BUDGET.maxEvidencePerCandidate,
      'maxEvidencePerCandidate',
    ),
  };
  const artifactBudget = ownOption(options, 'artifactBudget', 'discovery-artifact-budget-invalid') ?? {};
  const status = (completeness, stopReason) => createAnalysisStatus({
    snapshotId: options.snapshotId ?? 'snapshot-unbound',
    analyzerId: DISCOVERY_ANALYZER_ID,
    analyzerVersion: DISCOVERY_ANALYZER_VERSION,
    completeness,
    budgetClass: options.budgetClass ?? null,
    stopReason,
  });

  const producerRuns = options.producerRuns ?? [];
  if (!Array.isArray(producerRuns)) throw new TypeError('discovery-fusion-producer-runs-invalid');
  const byteIntervals = options.byteIntervals ?? [];
  if (!Array.isArray(byteIntervals)) throw new TypeError('discovery-artifact-byte-intervals-invalid');
  const resourcePreflight = discoveryArtifactResourcePreflight({
    evidence,
    candidates: [],
    producerRuns,
    byteIntervals,
  }, artifactBudget);
  if (options.artifactResourceLimitReason != null || !resourcePreflight.ok) {
    const finalStatus = status('truncated', 'budget-exhausted');
    const artifact = createDiscoveryArtifact({
      evidence,
      candidates: [],
      status: finalStatus,
      producerRuns,
      binding: {
        binaryId: options.binaryId ?? null,
        sourceHash: options.sourceHash ?? null,
        snapshotId: options.snapshotId ?? null,
        architectureId: options.architectureId ?? null,
      },
      expectedBinding: options.expectedBinding ?? null,
      byteIntervals,
      artifactBudget,
      resourceLimitReason: options.artifactResourceLimitReason ?? resourcePreflight.reason,
    });
    return { candidates: [], status: finalStatus, artifact };
  }

  const canonicalEvidence = evidence.map((item) => {
    // Preserve the fusion boundary's long-standing numeric error authority:
    // malformed addresses are rejected before any other evidence field can
    // obscure the cause (issue #3101).
    if (item?.start != null) primitiveInteger(item.start, 'discovery-fusion-invalid-start');
    return createDiscoveryEvidence(item);
  });
  const finish = (candidates, finalStatus, artifactEvidence = canonicalEvidence) => {
    const artifact = createDiscoveryArtifact({
      evidence: artifactEvidence,
      candidates,
      status: finalStatus,
      producerRuns,
      binding: {
        binaryId: options.binaryId ?? null,
        sourceHash: options.sourceHash ?? null,
        snapshotId: options.snapshotId ?? null,
        architectureId: options.architectureId ?? null,
      },
      expectedBinding: options.expectedBinding ?? null,
      byteIntervals,
      artifactBudget,
    });
    return { candidates, status: finalStatus, artifact };
  };

  if (options.signal?.aborted) {
    return finish([], status('partial', 'cancelled'));
  }

  const derived = deriveFunctionCandidates(canonicalEvidence, {
    architectureId: options.architectureId ?? null,
    maxEvidencePerCandidate: budget.maxEvidencePerCandidate,
    signal: options.signal,
  });
  if (derived.candidateCount > budget.maxCandidates) {
    return finish([], status('truncated', 'budget-exhausted'), []);
  }
  if (options.signal?.aborted) {
    return finish([], status('partial', 'cancelled'));
  }
  const producerIncomplete = producerRuns.some((run) => run?.completeness !== 'complete' || run?.stopReason != null);
  const finalStatus = derived.evidenceOverflow
    ? status('truncated', 'budget-exhausted')
    : producerIncomplete ? status('partial', 'evidence-missing') : status('complete', null);
  const retainedEvidence = derived.evidenceOverflow
    ? derived.candidates.flatMap((candidate) => candidate.startEvidence)
    : canonicalEvidence;
  return finish(derived.candidates, finalStatus, retainedEvidence);
}

/**
 * Region evidence built from a start and a size. Producers use this so the
 * fusion never has to interpret a raw length.
 */
export function regionFromSize(start, sizeBytes, ownership = 'exclusive') {
  const begin = primitiveInteger(start, 'discovery-region-invalid-start');
  const size = primitiveInteger(sizeBytes, 'discovery-region-invalid-size');
  if (size <= 0n) return null;
  return createRegion({ start: begin, end: begin + size, ownership });
}

export { hasExactStart };

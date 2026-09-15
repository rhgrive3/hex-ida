import { createEvidenceEdge, createEvidenceNode, EvidenceGraph, EVIDENCE_COMPLETENESS } from '../core/evidence/index.js';
import { createEvidenceId, deepFreeze, lossyTypeWitness, stableDigest, stableStringify } from '../core/identity/index.js';
import { createOriginSet } from '../core/identity/origin.js';
import { DebugAdapterError } from '../debug/adapter.js';
import { createRuntimeEvent } from './events.js';

const RELATIONS = Object.freeze(['supports', 'contradicts', 'refines']);
const COMPLETENESS_RANK = Object.freeze({ unsupported: 0, truncated: 1, partial: 2, bounded: 3, complete: 4 });

function required(value, code, message) {
  if (typeof value !== 'string') throw new DebugAdapterError(code, message || code);
  const text = value.trim();
  if (!text) throw new DebugAdapterError(code, message || code);
  return text;
}

function stringArray(value, name) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new DebugAdapterError('runtime-invalid-array', `${name} must be an array`);
  const normalized = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new DebugAdapterError('runtime-invalid-array', `${name} must contain only non-empty strings`);
    const text = item.trim();
    if (!text) throw new DebugAdapterError('runtime-invalid-array', `${name} must contain only non-empty strings`);
    normalized.push(text);
  }
  return Object.freeze([...new Set(normalized)].sort());
}

function optionalSequence(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DebugAdapterError('runtime-invalid-intervention-sequence', 'intervention sequence must be a non-negative safe integer');
  }
  return value;
}

function ownedClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(ownedClone);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (value instanceof Date) return new Date(value.getTime());
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, { value: ownedClone(item), enumerable: true, configurable: true, writable: true });
  }
  return out;
}

// #8868: intervention records are public identity-bearing provenance. Core
// deepFreeze intentionally skips binary backing stores, so detach binary input
// and publish only frozen byte arrays. Cyclic explicit-id records fail closed
// instead of retaining a mutable back-reference into an otherwise frozen record.
function sharedArrayBuffer(value) {
  return typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer;
}

function canonicalizeBinaryLeaf(value) {
  if (value instanceof ArrayBuffer || sharedArrayBuffer(value)) return Object.freeze(Array.from(new Uint8Array(value)));
  if (value instanceof DataView) return Object.freeze(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
  if (ArrayBuffer.isView(value)) return Object.freeze(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
  return null;
}

function canonicalizeInterventionValue(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value;
  const binary = canonicalizeBinaryLeaf(value);
  if (binary !== null) return binary;
  if (seen.has(value)) {
    throw new DebugAdapterError('runtime-invalid-intervention-value', 'intervention values must be acyclic');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) out[index] = canonicalizeInterventionValue(value[index], seen);
      return out;
    }
    if (value instanceof Map) {
      const out = new Map();
      for (const [key, item] of value) out.set(canonicalizeInterventionValue(key, seen), canonicalizeInterventionValue(item, seen));
      return out;
    }
    if (value instanceof Set) {
      const out = new Set();
      for (const item of value) out.add(canonicalizeInterventionValue(item, seen));
      return out;
    }
    if (value instanceof Date || value instanceof RegExp) return value;
    const out = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      Object.defineProperty(out, key, {
        value: canonicalizeInterventionValue(value[key], seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function completeness(value, fallback = 'partial') {
  const normalized = value ?? fallback;
  if (typeof normalized !== 'string') {
    throw new DebugAdapterError('runtime-invalid-completeness', `invalid evidence completeness: ${String(normalized)}`);
  }
  if (!EVIDENCE_COMPLETENESS.includes(normalized)) throw new DebugAdapterError('runtime-invalid-completeness', `invalid evidence completeness: ${normalized}`);
  return normalized;
}

function canonicalConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DebugAdapterError('runtime-invalid-confidence', 'evidence confidence must be a finite number');
  }
  return value;
}

export function conservativeCompleteness(...values) {
  const normalized = values.filter((value) => value != null).map((value) => completeness(value));
  if (!normalized.length) return 'partial';
  return normalized.reduce((worst, value) => COMPLETENESS_RANK[value] < COMPLETENESS_RANK[worst] ? value : worst, normalized[0]);
}

function assertInterventionParents(records, record) {
  for (const parent of record.parentInterventionIds) {
    if (!records.has(parent)) throw new DebugAdapterError('runtime-intervention-parent-missing', `intervention parent not found: ${parent}`);
  }
}

export function createInterventionRecord(input = {}) {
  const runtimeSessionId = required(input.runtimeSessionId, 'runtime-session-id-required', 'intervention requires runtimeSessionId');
  const providerId = required(input.providerId, 'runtime-provider-required', 'intervention requires providerId');
  const kind = required(input.kind, 'runtime-intervention-kind-required', 'intervention kind is required');
  const sequence = optionalSequence(input.sequence);
  const parentInterventionIds = stringArray(input.parentInterventionIds, 'parentInterventionIds');

  const sourceTarget = ownedClone(input.target ?? null);
  const sourceRequestedChange = ownedClone(input.requestedChange ?? null);
  const sourceAcknowledgedResult = ownedClone(input.acknowledgedResult ?? null);
  const sourceIdentity = {
    runtimeSessionId,
    providerId,
    kind,
    target: sourceTarget,
    requestedChange: sourceRequestedChange,
    sequence,
    parentInterventionIds,
  };

  const target = canonicalizeInterventionValue(sourceTarget);
  const requestedChange = canonicalizeInterventionValue(sourceRequestedChange);
  const acknowledgedResult = canonicalizeInterventionValue(sourceAcknowledgedResult);
  const identity = {
    runtimeSessionId,
    providerId,
    kind,
    target,
    requestedChange,
    sequence,
    parentInterventionIds,
  };

  // #8794 requires the type domain to participate in identity, while #8868
  // requires the generated id to commit to the exact canonical snapshot that
  // is actually stored. Persist the source type witness alongside that
  // canonical snapshot and hash both. Full persisted-record replay can then
  // reproduce the same commitment without reintroducing mutable binary views.
  const computedTypeWitness = lossyTypeWitness(sourceIdentity);
  const identityTypeWitness = input.interventionId != null && input.identityTypeWitness != null
    ? ownedClone(input.identityTypeWitness)
    : computedTypeWitness;
  // Validate that a caller-supplied persisted witness is serializable before it
  // becomes part of an authoritative record/collision comparison.
  stableStringify(identityTypeWitness);
  const interventionId = input.interventionId == null
    ? `intervention_${stableDigest({ identity, typed: identityTypeWitness })}`
    : required(input.interventionId, 'runtime-intervention-id-invalid', 'intervention id must be a non-empty string');

  return deepFreeze({
    interventionId,
    runtimeSessionId,
    providerId,
    kind,
    target,
    requestedChange,
    acknowledgedResult,
    sequence,
    parentInterventionIds,
    evidenceIds: stringArray(input.evidenceIds, 'evidenceIds'),
    identityTypeWitness,
  });
}

export class InterventionLedger {
  #records = new Map();
  #sequence = 0;

  validate(input) {
    const record = createInterventionRecord(input);
    assertInterventionParents(this.#records, record);
    return record;
  }

  nextSequence() {
    const sequence = this.#sequence;
    this.#sequence += 1;
    return sequence;
  }

  add(input) {
    const record = createInterventionRecord(input);
    const existing = this.#records.get(record.interventionId);
    if (existing) {
      if (stableStringify([existing, lossyTypeWitness(existing)]) !== stableStringify([record, lossyTypeWitness(record)])) {
        throw new DebugAdapterError(
          'runtime-intervention-id-collision',
          `intervention id is already bound to a different record: ${record.interventionId}`,
          { interventionId: record.interventionId },
        );
      }
      return existing;
    }
    assertInterventionParents(this.#records, record);
    this.#records.set(record.interventionId, record);
    return record;
  }

  get(id) { return this.#records.get(id) || null; }
  all() { return Object.freeze([...this.#records.values()]); }

  ancestry(ids = []) {
    const out = new Map();
    const visit = (id) => {
      const record = this.get(id);
      if (!record || out.has(record.interventionId)) return;
      out.set(record.interventionId, record);
      for (const parent of record.parentInterventionIds) visit(parent);
    };
    for (const id of ids) visit(id);
    return Object.freeze([...out.values()]);
  }
}

function linkableResolution(resolution) {
  return !!resolution && (resolution.state === 'exact' || resolution.state === 'resolved') && Array.isArray(resolution.targetEntityIds) && resolution.targetEntityIds.length > 0;
}

function canonicalIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function resolutionBindingKey(resolution) {
  return resolution == null ? null : stableStringify(resolution);
}

function linkResolutionMatchesEvidence(evidence, resolution) {
  if (!linkableResolution(resolution)) return false;
  if (!canonicalIdentity(resolution.runtimeSessionId) || !canonicalIdentity(resolution.binaryId)) return false;
  if (!resolution.targetEntityIds.every(canonicalIdentity)) return false;

  const stored = evidence?.payload?.resolution;
  const storedBinding = evidence?.payload?.resolutionBinding;
  if (!stored || typeof storedBinding !== 'string' || !storedBinding) return false;
  if (resolutionBindingKey(resolution) !== storedBinding) return false;
  if (resolution.runtimeSessionId !== evidence.payload.runtimeSessionId) return false;
  if (resolution.binaryId !== evidence.binaryId) return false;
  if (stored.runtimeSessionId !== resolution.runtimeSessionId || stored.state !== resolution.state) return false;

  const resolutionTargets = [...new Set(resolution.targetEntityIds)].sort();
  return stableStringify(resolutionTargets) === stableStringify(evidence.targetEntityIds);
}

function resolutionCompleteness(resolution) {
  if (!resolution) return 'partial';
  if (resolution.state === 'exact') return 'complete';
  if (resolution.state === 'resolved') return 'bounded';
  if (resolution.state === 'ambiguous' || resolution.state === 'unresolved') return 'partial';
  if (resolution.state === 'mismatch') return 'unsupported';
  return 'partial';
}

export class RuntimeEvidenceBridge {
  constructor({ graph = null, interventions = null } = {}) {
    this.graph = graph instanceof EvidenceGraph ? graph : new EvidenceGraph();
    this.interventions = interventions instanceof InterventionLedger ? interventions : new InterventionLedger();
  }

  eventToEvidence(eventInput, resolution = null, options = {}) {
    const event = createRuntimeEvent(eventInput);
    resolution = resolution == null ? null : ownedClone(resolution);
    if (resolution && resolution.runtimeSessionId !== event.runtimeSessionId) {
      throw new DebugAdapterError(
        'runtime-resolution-session-mismatch',
        'runtime event and address resolution must belong to the same runtime session',
      );
    }
    const resolutionBinding = resolutionBindingKey(resolution);
    const binaryId = resolution?.binaryId ?? options.binaryId ?? null;
    const targetEntityIds = linkableResolution(resolution) ? resolution.targetEntityIds : [];
    const topLevelInterventions = event.interventionIds.map((interventionId) => {
      const record = this.interventions.get(interventionId);
      if (!record) {
        throw new DebugAdapterError(
          'runtime-intervention-not-found',
          `runtime event intervention not found: ${interventionId}`,
          { interventionId },
        );
      }
      if (record.runtimeSessionId !== event.runtimeSessionId) {
        throw new DebugAdapterError(
          'runtime-intervention-session-mismatch',
          `runtime event intervention belongs to a different session: ${interventionId}`,
          { interventionId },
        );
      }
      return record;
    });
    const interventionRecords = this.interventions.ancestry(
      topLevelInterventions.map((record) => record.interventionId),
    );
    if (interventionRecords.some((record) => record.runtimeSessionId !== event.runtimeSessionId)) {
      throw new DebugAdapterError(
        'runtime-intervention-session-mismatch',
        'runtime event intervention ancestry crosses session boundary',
      );
    }
    const evidenceId = createEvidenceId({
      binaryId,
      kind: 'runtime-event',
      sourceId: event.eventId,
      identity: {
        runtimeSessionId: event.runtimeSessionId,
        providerId: event.providerId,
        moduleBindingKey: event.moduleBindingKey,
        moduleGeneration: event.moduleGeneration,
        resolutionState: resolution?.state ?? 'unresolved',
      },
    });
    const evidence = createEvidenceNode({
      id: evidenceId,
      family: 'RuntimeEvidence',
      binaryId,
      targetEntityIds,
      semanticKind: options.semanticKind ?? event.kind,
      completeness: conservativeCompleteness(event.completeness, resolutionCompleteness(resolution)),
      confidence: options.confidence == null ? null : canonicalConfidence(options.confidence),
      deterministic: false,
      origin: createOriginSet({ parentEntityIds: targetEntityIds }),
      payload: {
        runtimeSessionId: event.runtimeSessionId,
        providerId: event.providerId,
        providerVersion: event.providerVersion,
        sessionEpoch: event.sessionEpoch,
        streamId: event.streamId,
        sequence: event.sequence,
        processKey: event.processKey,
        threadKey: event.threadKey,
        moduleBindingKey: event.moduleBindingKey,
        moduleGeneration: event.moduleGeneration,
        observationMode: event.observationMode,
        eventKind: event.kind,
        eventPayload: event.payload,
        interventionIds: interventionRecords.map((record) => record.interventionId),
        resolutionBinding,
        resolution: resolution ? {
          runtimeSessionId: resolution.runtimeSessionId,
          state: resolution.state,
          method: resolution.method,
          staticAddress: resolution.staticAddress,
          functionMatchId: resolution.functionMatchId,
          evidenceIds: resolution.evidenceIds,
        } : { state: 'unresolved', method: 'no-resolution' },
      },
      createdAt: event.timestamp,
    });
    this.graph.addNode(evidence);
    return evidence;
  }

  linkClaim(claimId, evidenceId, relation, resolution = null) {
    if (typeof relation !== 'string') throw new DebugAdapterError('runtime-invalid-evidence-relation', `invalid runtime evidence relation: ${String(relation)}`);
    const type = relation;
    if (!RELATIONS.includes(type)) throw new DebugAdapterError('runtime-invalid-evidence-relation', `invalid runtime evidence relation: ${type}`);
    resolution = resolution == null ? null : ownedClone(resolution);
    if (!linkableResolution(resolution)) {
      return deepFreeze({ linked: false, reason: resolution?.state === 'mismatch' ? 'identity-mismatch' : 'static-resolution-required', claimId: String(claimId), evidenceId: String(evidenceId), relation: type });
    }
    const claim = this.graph.getNode(claimId);
    const evidence = this.graph.getNode(evidenceId);
    if (!claim || claim.family !== 'Claim') throw new DebugAdapterError('runtime-claim-not-found', `claim not found: ${claimId}`);
    if (!evidence || evidence.family !== 'RuntimeEvidence') throw new DebugAdapterError('runtime-evidence-not-found', `runtime evidence not found: ${evidenceId}`);
    if (!linkResolutionMatchesEvidence(evidence, resolution)) {
      return deepFreeze({ linked: false, reason: 'resolution-evidence-mismatch', claimId: String(claimId), evidenceId: String(evidenceId), relation: type });
    }
    const edge = createEvidenceEdge({ type, from: claim.id, to: evidence.id, metadata: { resolutionState: resolution.state, method: resolution.method ?? null } });
    this.graph.addEdge(edge);
    return deepFreeze({ linked: true, edge });
  }
}

export const RUNTIME_EVIDENCE_RELATIONS = RELATIONS;

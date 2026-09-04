import { createEvidenceEdge, createEvidenceNode, EvidenceGraph, EVIDENCE_COMPLETENESS } from '../core/evidence/index.js';
import { createEvidenceId, deepFreeze, stableDigest, stableStringify } from '../core/identity/index.js';
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
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw new DebugAdapterError('runtime-invalid-array', `${name} must contain only non-empty strings`);
  }
  return Object.freeze([...new Set(value)].sort());
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

function completeness(value, fallback = 'partial') {
  // Completeness is canonical evidence authority. A structured value must not
  // launder into a ranking through String() coercion (String(['complete']).
  const normalized = value ?? fallback;
  if (typeof normalized !== 'string') {
    throw new DebugAdapterError('runtime-invalid-completeness', `invalid evidence completeness: ${String(normalized)}`);
  }
  if (!EVIDENCE_COMPLETENESS.includes(normalized)) throw new DebugAdapterError('runtime-invalid-completeness', `invalid evidence completeness: ${normalized}`);
  return normalized;
}

function canonicalConfidence(value) {
  // Confidence is canonical evidence strength. Only a primitive finite number
  // may define it; numeric strings, Arrays, booleans fail closed.
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

function interventionIdentityKey(record) {
  return stableStringify({
    runtimeSessionId: record.runtimeSessionId,
    providerId: record.providerId,
    kind: record.kind,
    target: record.target,
    requestedChange: record.requestedChange,
    sequence: record.sequence,
    parentInterventionIds: record.parentInterventionIds,
  });
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
  const target = ownedClone(input.target ?? null);
  const requestedChange = ownedClone(input.requestedChange ?? null);
  const acknowledgedResult = ownedClone(input.acknowledgedResult ?? null);
  const identity = {
    runtimeSessionId,
    providerId,
    kind,
    target,
    requestedChange,
    sequence,
    parentInterventionIds,
  };
  const interventionId = input.interventionId == null
    ? `intervention_${stableDigest(identity)}`
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
  });
}

export class InterventionLedger {
  #records = new Map();

  validate(input) {
    const record = createInterventionRecord(input);
    assertInterventionParents(this.#records, record);
    return record;
  }

  add(input) {
    const record = createInterventionRecord(input);
    const existing = this.#records.get(record.interventionId);
    if (existing) {
      if (interventionIdentityKey(existing) !== interventionIdentityKey(record)) {
        throw new DebugAdapterError(
          'runtime-intervention-id-collision',
          `intervention id is already bound to different identity: ${record.interventionId}`,
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
    if (resolution && resolution.runtimeSessionId !== event.runtimeSessionId) {
      throw new DebugAdapterError(
        'runtime-resolution-session-mismatch',
        'runtime event and address resolution must belong to the same runtime session',
      );
    }
    const binaryId = resolution?.binaryId ?? options.binaryId ?? null;
    const targetEntityIds = linkableResolution(resolution) ? resolution.targetEntityIds : [];
    const interventionRecords = this.interventions.ancestry(event.interventionIds);
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
    // Relation edges decide EvidenceGraph semantics; a structured relation must
    // not coerce into a canonical edge type via String().
    if (typeof relation !== 'string') throw new DebugAdapterError('runtime-invalid-evidence-relation', `invalid runtime evidence relation: ${String(relation)}`);
    const type = relation;
    if (!RELATIONS.includes(type)) throw new DebugAdapterError('runtime-invalid-evidence-relation', `invalid runtime evidence relation: ${type}`);
    if (!linkableResolution(resolution)) {
      return deepFreeze({ linked: false, reason: resolution?.state === 'mismatch' ? 'identity-mismatch' : 'static-resolution-required', claimId: String(claimId), evidenceId: String(evidenceId), relation: type });
    }
    const claim = this.graph.getNode(claimId);
    const evidence = this.graph.getNode(evidenceId);
    if (!claim || claim.family !== 'Claim') throw new DebugAdapterError('runtime-claim-not-found', `claim not found: ${claimId}`);
    if (!evidence || evidence.family !== 'RuntimeEvidence') throw new DebugAdapterError('runtime-evidence-not-found', `runtime evidence not found: ${evidenceId}`);
    const edge = createEvidenceEdge({ type, from: claim.id, to: evidence.id, metadata: { resolutionState: resolution.state, method: resolution.method ?? null } });
    this.graph.addEdge(edge);
    return deepFreeze({ linked: true, edge });
  }
}

export const RUNTIME_EVIDENCE_RELATIONS = RELATIONS;
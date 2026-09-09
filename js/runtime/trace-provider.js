import { deepFreeze, stableStringify } from '../core/identity/index.js';
import { DebugAdapterError, boundedInteger } from '../debug/adapter.js';
import { RuntimeProviderSession, createRuntimeProviderDescriptor } from './provider.js';
import { createRuntimeEvent, createRuntimeEventBatch } from './events.js';

const UTF8_ENCODER = new TextEncoder();

function encodedByteLength(value) { return UTF8_ENCODER.encode(value).byteLength; }

function jsonStringByteLength(value, limit = Number.MAX_SAFE_INTEGER) {
  let total = 2;
  const add = (amount) => {
    if (total > limit - amount) return false;
    total += amount;
    return true;
  };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      if (!add(2)) return limit + 1;
      continue;
    }
    if (code <= 0x1f) {
      const escapedLength = code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
      if (!add(escapedLength)) return limit + 1;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (!add(4)) return limit + 1;
        index += 1;
        continue;
      }
      if (!add(6)) return limit + 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      if (!add(6)) return limit + 1;
      continue;
    }
    if (!add(code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3)) return limit + 1;
  }
  return total;
}

function serializedByteArrayUpperBound(byteLength) {
  if (byteLength === 0) return 2;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > Math.floor((Number.MAX_SAFE_INTEGER - 1) / 4)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return byteLength * 4 + 1;
}

const MAX_ADMISSION_NODES = 100_000;
const MAX_ADMISSION_DEPTH = 64;

function admitRecordingGraph(value, maxBytes) {
  let chargedBytes = 0;
  let visitedNodes = 0;
  const active = new WeakSet();

  const rejectByteLimit = () => {
    throw new DebugAdapterError('resource-limit', `trace recording exceeds byte limit (${maxBytes}) during bounded admission`);
  };

  const charge = (amount) => {
    if (!Number.isSafeInteger(amount) || amount < 0 || chargedBytes > maxBytes - amount) rejectByteLimit();
    chargedBytes += amount;
  };

  const chargeJsonString = (value, suffixBytes = 0) => {
    const available = maxBytes - chargedBytes;
    const limit = available - suffixBytes;
    const length = jsonStringByteLength(value, limit);
    if (length > limit) rejectByteLimit();
    charge(length + suffixBytes);
  };

  const visit = (item, depth) => {
    if (depth > MAX_ADMISSION_DEPTH) {
      throw new DebugAdapterError('resource-limit', `trace recording exceeds admission depth (${MAX_ADMISSION_DEPTH})`);
    }
    visitedNodes += 1;
    if (visitedNodes > MAX_ADMISSION_NODES) {
      throw new DebugAdapterError('resource-limit', `trace recording exceeds admission node limit (${MAX_ADMISSION_NODES})`);
    }
    if (item === null) { charge(4); return; }
    const type = typeof item;
    if (type !== 'object') {
      if (type === 'string') chargeJsonString(item);
      else if (type === 'number' || type === 'boolean') charge(encodedByteLength(JSON.stringify(item)));
      else if (type === 'bigint') charge(encodedByteLength(`${item}n`));
      else charge(8);
      return;
    }
    if (active.has(item)) {
      throw new DebugAdapterError('trace-invalid-recording', 'trace recording contains a cyclic value');
    }
    active.add(item);
    try {
      if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
        charge(serializedByteArrayUpperBound(item.byteLength));
        return;
      }
      if (Array.isArray(item)) {
        charge(2);
        for (let index = 0; index < item.length; index += 1) visit(item[index], depth + 1);
        return;
      }
      charge(2);
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        chargeJsonString(key, 1);
        visit(item[key], depth + 1);
      }
    } finally {
      active.delete(item);
    }
  };

  visit(value, 0);
}


function required(value, code, message) {
  if (typeof value !== 'string') throw new DebugAdapterError(code, message || code);
  const text = value.trim();
  if (!text) throw new DebugAdapterError(code, message || code);
  return text;
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

function droppedCount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) {
    throw new DebugAdapterError('trace-invalid-dropped-count', 'trace dropped count must be a non-negative safe integer');
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new DebugAdapterError('trace-invalid-dropped-count', 'trace dropped count must be a non-negative safe integer');
  return n;
}

function droppedEventCount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DebugAdapterError('trace-invalid-dropped-count', 'dropped-events payload count must be a non-negative safe integer');
  }
  return value;
}

function sumDroppedEventCounts(events) {
  let total = 0;
  for (const event of events) {
    if (event.kind !== 'dropped-events') continue;
    const count = droppedEventCount(event.payload?.dropped);
    if (count > Number.MAX_SAFE_INTEGER - total) {
      throw new DebugAdapterError('trace-invalid-dropped-count', 'dropped-events payload counts exceed the safe integer range');
    }
    total += count;
  }
  return total;
}

function isLossEvent(event) {
  return event.completeness === 'truncated' || event.kind === 'gap' || event.kind === 'dropped-events';
}

function collectionField(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new DebugAdapterError('trace-invalid-recording', `trace ${field} must be an array`);
  }
  return value;
}

function normalizeRecording(recording = {}, options = {}) {
  if (!recording || typeof recording !== 'object' || Array.isArray(recording)) throw new DebugAdapterError('trace-invalid-recording', 'trace recording must be an object');
  const maxEvents = boundedInteger(options.maxEvents, 100000, 1, 1000000, 'maxEvents');
  const maxBytes = boundedInteger(options.maxBytes, 64 * 1024 * 1024, 4096, 256 * 1024 * 1024, 'maxBytes');
  const events = recording.events != null
    ? collectionField(recording.events, 'events')
    : recording.trace?.events != null
      ? collectionField(recording.trace.events, 'trace.events')
      : [];
  if (events.length > maxEvents) throw new DebugAdapterError('resource-limit', `trace recording exceeds event limit (${maxEvents})`);
  // Bounded graph admission runs before stableStringify(): jsonSafe() expands
  // every binary view into a per-byte array and can otherwise materialize a huge
  // nested payload before discovering the byte limit (#5908). The walker also
  // fails closed on cycles/deep graphs and bounds the number of nodes visited.
  admitRecordingGraph(recording, maxBytes);
  if (encodedByteLength(stableStringify(recording)) > maxBytes) throw new DebugAdapterError('resource-limit', `trace recording exceeds byte limit (${maxBytes})`);
  const dropped = droppedCount(recording.dropped ?? recording.trace?.dropped ?? 0);
  const truncated = recording.truncated === true || recording.trace?.truncated === true || dropped > 0;
  return deepFreeze({
    recordingId: required(recording.recordingId ?? recording.id ?? `trace:${recording.sourceProvider ?? 'unknown'}`, 'trace-recording-id-required', 'trace recording id is required'),
    schemaVersion: String(recording.schemaVersion ?? recording.version ?? '1'),
    sourceProvider: required(recording.sourceProvider ?? recording.providerId ?? recording.backend ?? 'unknown', 'trace-source-provider-invalid', 'trace source provider must be a non-empty string'),
    sourceProviderVersion: required(recording.sourceProviderVersion ?? recording.providerVersion ?? 'unknown', 'trace-source-provider-version-invalid', 'trace source provider version must be a non-empty string'),
    binaryId: recording.binaryId ?? recording.binaryHash ?? null,
    sliceId: recording.sliceId ?? recording.sliceIdentity ?? null,
    architecture: recording.architecture ?? null,
    platform: recording.platform ?? null,
    processKey: recording.processKey ?? null,
    modules: ownedClone(collectionField(recording.modules, 'modules')),
    events: ownedClone(events),
    interventions: ownedClone(collectionField(recording.interventions, 'interventions')),
    dropped,
    completeness: truncated ? 'truncated' : required(recording.completeness ?? 'bounded', 'trace-invalid-completeness', 'trace completeness must be a non-empty string'),
    sourceProvenance: ownedClone(recording.sourceProvenance ?? recording.provenance ?? null),
  });
}

function normalizedEventFromRecord(record, context, index) {
  const protocolEnvelope = record && record.type === 'event' && typeof record.event === 'string';
  const source = protocolEnvelope
    ? (record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data : {})
    : (record && record.type === 'event' && record.event ? record.event : record);
  const rawKind = protocolEnvelope ? record.event : (source?.kind ?? source?.type ?? 'trace-marker');
  const rawType = typeof rawKind === 'string' ? rawKind : 'trace-marker';
  const kindMap = { branch: 'basic-block', trace: 'trace-marker', warning: 'provider-warning', error: 'provider-error', 'stream-truncated': 'gap' };
  const known = new Set(['session-open','session-close','process-start','process-exit','thread-start','thread-exit','module-load','module-unload','paused','resumed','breakpoint-hit','watchpoint-hit','exception','signal','call','return','basic-block','memory-read','memory-write','register-snapshot','instrumentation-observation','instrumentation-intervention','emulator-checkpoint','trace-marker','gap','dropped-events','provider-warning','provider-error']);
  const kind = known.has(rawType) ? rawType : (kindMap[rawType] || 'trace-marker');
  const payload = protocolEnvelope ? (record.data ?? {}) : (source?.payload ?? source ?? {});
  if (kind === 'dropped-events') droppedEventCount(payload?.dropped);
  const envelopeValue = (key) => protocolEnvelope && record[key] != null ? record[key] : source?.[key];
  const truncated = record?.truncated === true || source?.truncated === true || rawType === 'stream-truncated';
  return createRuntimeEvent({
    ...context,
    sessionEpoch: envelopeValue('epoch') ?? context.sessionEpoch,
    eventId: envelopeValue('eventId'),
    streamId: envelopeValue('streamId') ?? envelopeValue('threadKey') ?? 'trace',
    sequence: envelopeValue('sequence') ?? index,
    providerEventId: envelopeValue('providerEventId') ?? envelopeValue('id'),
    timestamp: envelopeValue('timestamp'),
    processKey: envelopeValue('processKey') ?? context.processKey,
    threadKey: envelopeValue('threadKey'),
    moduleBindingKey: envelopeValue('moduleBindingKey'),
    moduleGeneration: envelopeValue('moduleGeneration'),
    kind,
    payload,
    observationMode: envelopeValue('observationMode') ?? 'observed',
    completeness: envelopeValue('completeness') ?? (truncated ? 'truncated' : context.sourceCompleteness),
    predecessorIds: envelopeValue('predecessorIds'),
    interventionIds: envelopeValue('interventionIds'),
  });
}

class TraceProviderSession extends RuntimeProviderSession {
  newEpoch() {
    if (this.closed) return super.newEpoch();
    throw new DebugAdapterError('runtime-epoch-unsupported', 'trace provider sessions use an immutable event epoch');
  }
}

export class TraceProvider {
  constructor(recording, options = {}) {
    this.recording = normalizeRecording(recording, options);
    this.options = options;
    this.activeSession = null;
    this._descriptor = createRuntimeProviderDescriptor({
      id: options.id ?? `trace:${this.recording.sourceProvider}`,
      version: options.version ?? '1',
      kind: 'trace',
      facets: ['trace'],
      capabilities: { import: true, replay: true, liveMutation: false },
    });
  }

  descriptor() { return this._descriptor; }

  async openSession(request = {}, options = {}) {
    if (this.activeSession && !this.activeSession.closed) throw new DebugAdapterError('runtime-session-active', 'trace provider already has an open session');
    const binaryId = this.recording.binaryId ?? request.binaryId ?? request.binaryHash;
    if (!binaryId) throw new DebugAdapterError('trace-binary-identity-required', 'trace provider requires source binary identity for a canonical runtime session');
    let session;
    session = new TraceProviderSession({
      provider: this,
      request: {
        ...request,
        binaryId,
        sliceId: this.recording.sliceId ?? request.sliceId,
        architecture: this.recording.architecture ?? request.architecture,
        platform: this.recording.platform ?? request.platform,
        processKey: this.recording.processKey ?? request.processKey,
        targetIdentity: request.targetIdentity ?? { recordingId: this.recording.recordingId, processKey: this.recording.processKey ?? null },
        sessionNonce: request.sessionNonce ?? this.recording.recordingId,
      },
      close: async () => { if (this.activeSession === session) this.activeSession = null; },
    });

    for (let i = 0; i < this.recording.modules.length; i++) {
      const module = this.recording.modules[i] || {};
      if (module.runtimeBase == null && module.base == null) continue;
      if (module.runtimeSize == null && module.size == null) continue;
      // Presence of unverified identity evidence is not identity proof. An
      // imported trace is external input: only canonical non-empty string
      // evidence IDs count toward proven static identity, and `unresolved`
      // must not be promoted to `resolved` by array length alone.
      const rawEvidenceIds = Array.isArray(module.identityEvidenceIds) ? module.identityEvidenceIds : [];
      const identityEvidenceIds = rawEvidenceIds.filter((id) => typeof id === 'string' && id.trim().length > 0);
      const hasCanonicalIdentityEvidence = identityEvidenceIds.length > 0 && identityEvidenceIds.length === rawEvidenceIds.length;
      const hasProvenStaticIdentity = module.binaryId != null
        && (module.identityState === 'exact' || (module.identityState === 'resolved' && hasCanonicalIdentityEvidence) || hasCanonicalIdentityEvidence);
      session.modules.load({
        bindingKey: module.bindingKey ?? module.moduleKey ?? module.id ?? module.uuid ?? module.name ?? `trace-module:${i}`,
        runtimeBase: module.runtimeBase ?? module.base,
        runtimeSize: module.runtimeSize ?? module.size,
        staticBase: module.staticBase ?? module.imageBase ?? null,
        pathHint: module.pathHint ?? module.path ?? module.name ?? null,
        binaryId: hasProvenStaticIdentity ? module.binaryId : null,
        sliceId: hasProvenStaticIdentity ? (module.sliceId ?? null) : null,
        imageId: hasProvenStaticIdentity ? (module.imageId ?? null) : null,
        buildIdentity: module.buildIdentity ?? module.uuid ?? null,
        identityState: hasProvenStaticIdentity ? (module.identityState ?? 'resolved') : 'unresolved',
        identityEvidenceIds,
        loadedSequence: module.loadedSequence,
      });
    }

    const context = {
      runtimeSessionId: session.runtimeSessionId,
      providerId: this._descriptor.id,
      providerVersion: this._descriptor.version,
      sessionEpoch: session.epoch,
      processKey: this.recording.processKey,
      sourceCompleteness: this.recording.completeness,
    };
    const normalized = this.recording.events.map((event, index) => normalizedEventFromRecord(event, context, index));
    const explicitDropped = sumDroppedEventCounts(normalized);
    const hasExplicitDrop = normalized.some((event) => event.kind === 'gap' || event.kind === 'dropped-events');
    const hasExplicitDroppedCount = normalized.some((event) => event.kind === 'dropped-events');
    if (this.recording.dropped > 0 && hasExplicitDroppedCount && explicitDropped !== this.recording.dropped) {
      throw new DebugAdapterError('trace-invalid-dropped-count', `recording dropped count (${this.recording.dropped}) disagrees with explicit dropped events total (${explicitDropped})`);
    }
    if (this.recording.dropped > 0 && !hasExplicitDrop) {
      normalized.unshift(createRuntimeEvent({
        ...context,
        kind: 'dropped-events',
        payload: { dropped: this.recording.dropped, source: 'trace-recording' },
        completeness: 'truncated',
      }));
    }
    const canonicalDropped = hasExplicitDroppedCount ? explicitDropped : this.recording.dropped;
    const hasDroppedEventCount = normalized.some((event) => event.kind === 'dropped-events');
    const hasExplicitLoss = normalized.some(isLossEvent);
    session.normalizedEvents = Object.freeze(normalized);
    session.sourceCompleteness = hasExplicitLoss ? 'truncated' : this.recording.completeness;
    session.facets = Object.freeze({ trace: this.#createTraceFacet(session, Object.freeze({
      dropped: canonicalDropped,
      hasDroppedEventCount,
    })) });
    session.setState('ready');
    this.activeSession = session;
    return session;
  }

  #createTraceFacet(session, lossAuthority) {
    return Object.freeze({
      source: deepFreeze({
        recordingId: this.recording.recordingId,
        schemaVersion: this.recording.schemaVersion,
        providerId: this.recording.sourceProvider,
        providerVersion: this.recording.sourceProviderVersion,
        provenance: this.recording.sourceProvenance,
      }),
      async *events(options = {}) {
        const batchSize = boundedInteger(options.batchSize, 256, 1, 4096, 'batchSize');
        const signal = options.signal;
        let implicitDroppedPending = lossAuthority.dropped > 0 && !lossAuthority.hasDroppedEventCount;
        for (let i = 0; i < session.normalizedEvents.length; i += batchSize) {
          if (signal?.aborted) throw new DebugAdapterError('cancelled', 'trace event stream cancelled');
          const events = session.normalizedEvents.slice(i, i + batchSize);
          const loss = events.some(isLossEvent);
          let dropped = sumDroppedEventCounts(events);
          if (implicitDroppedPending && loss) {
            dropped = lossAuthority.dropped;
            implicitDroppedPending = false;
          }
          yield createRuntimeEventBatch({
            runtimeSessionId: session.runtimeSessionId,
            providerId: session.providerId,
            sessionEpoch: session.epoch,
            events,
            completeness: loss ? 'truncated' : session.sourceCompleteness,
            dropped,
          });
        }
      },
      replay: async () => createRuntimeEventBatch({
        runtimeSessionId: session.runtimeSessionId,
        providerId: session.providerId,
        sessionEpoch: session.epoch,
        events: session.normalizedEvents,
        completeness: session.sourceCompleteness,
        dropped: lossAuthority.dropped,
      }),
      resolveAddress: (runtimeAddress, resolutionOptions = {}) => session.modules.resolve(runtimeAddress, resolutionOptions),
    });
  }
}

export function createTraceProvider(recording, options = {}) { return new TraceProvider(recording, options); }

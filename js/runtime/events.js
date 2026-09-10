import { EVIDENCE_COMPLETENESS } from '../core/evidence/index.js';
import { deepFreeze, jsonSafe, stableDigest, stableStringify } from '../core/identity/index.js';
import { DebugAdapterError } from '../debug/adapter.js';

export const RUNTIME_OBSERVATION_MODES = Object.freeze(['observed', 'intervened', 'synthetic']);
export const RUNTIME_EVENT_KINDS = Object.freeze([
  'session-open', 'session-close',
  'process-start', 'process-exit',
  'thread-start', 'thread-exit',
  'module-load', 'module-unload',
  'paused', 'resumed',
  'breakpoint-hit', 'watchpoint-hit',
  'exception', 'signal',
  'call', 'return', 'basic-block',
  'memory-read', 'memory-write', 'register-snapshot',
  'instrumentation-observation', 'instrumentation-intervention',
  'emulator-checkpoint', 'trace-marker',
  'gap', 'dropped-events', 'provider-warning', 'provider-error',
]);

const COMPLETENESS_RANK = Object.freeze({ unsupported: 0, truncated: 1, partial: 2, bounded: 3, complete: 4 });
const UTF8_ENCODER = new TextEncoder();


function encodedByteLength(value) { return UTF8_ENCODER.encode(value).byteLength; }

const MAX_EVENT_ADMISSION_DEPTH = 64;

function jsonStringByteLength(value, limit) {
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

function runtimeEventMaterialFits(values, maxBytes) {
  let chargedBytes = 0;
  const active = new WeakSet();
  const charge = (amount) => {
    if (!Number.isSafeInteger(amount) || amount < 0 || chargedBytes > maxBytes - amount) return false;
    chargedBytes += amount;
    return true;
  };
  const chargeString = (value) => {
    const remaining = maxBytes - chargedBytes;
    const length = jsonStringByteLength(value, remaining);
    return length <= remaining && charge(length);
  };
  const visitBytes = (view) => {
    if (!charge(2)) return false;
    for (let index = 0; index < view.length; index += 1) {
      if (index > 0 && !charge(1)) return false;
      const text = String(view[index]);
      if (!charge(text.length)) return false;
    }
    return true;
  };
  const visit = (value, depth, arrayElement = false) => {
    if (depth > MAX_EVENT_ADMISSION_DEPTH) return false;
    if (value === null) return charge(4);
    const type = typeof value;
    if (type === 'undefined' || type === 'function' || type === 'symbol') return arrayElement ? charge(4) : true;
    if (type === 'string') return chargeString(value);
    if (type === 'boolean') return charge(value ? 4 : 5);
    if (type === 'number') {
      if (!Number.isFinite(value)) return arrayElement ? charge(4) : true;
      return charge(String(value).length);
    }
    if (type === 'bigint') return chargeString(value.toString());
    if (type !== 'object') return true;
    if (active.has(value)) return false;
    active.add(value);
    try {
      if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) return true;
        return chargeString(value.toISOString());
      }
      if (value instanceof ArrayBuffer) return visitBytes(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) return visitBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      if (Array.isArray(value)) {
        if (!charge(2)) return false;
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0 && !charge(1)) return false;
          if (!visit(value[index], depth + 1, true)) return false;
        }
        return true;
      }
      if (value instanceof Map) {
        if (!charge(10)) return false;
        let index = 0;
        for (const [key, entryValue] of value) {
          if (index++ > 0 && !charge(1)) return false;
          if (!visit(key, depth + 1, true) || !visit(entryValue, depth + 1, true)) return false;
        }
        return true;
      }
      if (value instanceof Set) {
        if (!charge(10)) return false;
        let index = 0;
        for (const entryValue of value) {
          if (index++ > 0 && !charge(1)) return false;
          if (!visit(entryValue, depth + 1, true)) return false;
        }
        return true;
      }
      if (!charge(2)) return false;
      let index = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        // Even values jsonSafe() later omits still cost raw traversal work.
        // Charge one byte-equivalent per property so malformed/irrelevant
        // metadata cannot defeat the bounded preflight with omitted values.
        if (!charge(1)) return false;
        const entryValue = value[key];
        const entryType = typeof entryValue;
        if (entryType === 'undefined' || entryType === 'function' || entryType === 'symbol'
          || (entryType === 'number' && !Number.isFinite(entryValue))) continue;
        if (index++ > 0 && !charge(1)) return false;
        if (!chargeString(key) || !charge(1) || !visit(entryValue, depth + 1)) return false;
      }
      return true;
    } finally {
      active.delete(value);
    }
  };

  for (const value of values) {
    if (!visit(value, 0)) return false;
  }
  return true;
}

function required(value, code, message) {
  if (typeof value !== 'string') throw new DebugAdapterError(code, message || code);
  const text = value.trim();
  if (!text) throw new DebugAdapterError(code, message || code);
  return text;
}

function safeInteger(value, fallback, name, { min = 0 } = {}) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new DebugAdapterError('runtime-invalid-event-integer', `${name} must be a safe integer >= ${min}`);
  }
  return value;
}

function optionalText(value) { return value == null ? null : String(value); }

function optionalIdentity(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) throw new DebugAdapterError('runtime-invalid-event-identity', `${name} must be a non-empty string`);
  return value;
}

function arrayOfStrings(value, name) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new DebugAdapterError('runtime-invalid-event-array', `${name} must be an array`);
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) throw new DebugAdapterError('runtime-invalid-event-array', `${name} must contain only non-empty strings`);
  }
  return Object.freeze([...new Set(value)]);
}

function normalizeCompleteness(value, fallback = 'partial') {
  const completeness = value == null ? fallback : value;
  if (typeof completeness !== 'string' || !EVIDENCE_COMPLETENESS.includes(completeness)) {
    throw new DebugAdapterError('runtime-invalid-completeness', `invalid runtime completeness type: ${typeof completeness}`);
  }
  return completeness;
}

function normalizeKind(value) {
  const kind = required(value, 'runtime-event-kind-required', 'runtime event kind is required');
  if (!RUNTIME_EVENT_KINDS.includes(kind)) throw new DebugAdapterError('runtime-invalid-event-kind', `invalid runtime event kind: ${kind}`);
  return kind;
}

function normalizeMode(value) {
  const mode = value == null ? 'observed' : value;
  if (typeof mode !== 'string' || !RUNTIME_OBSERVATION_MODES.includes(mode)) {
    throw new DebugAdapterError('runtime-invalid-observation-mode', `invalid runtime observation mode type: ${typeof mode}`);
  }
  return mode;
}

function dedupeIdentity(input) {
  if (input.providerEventId != null) return `provider:${input.providerEventId}`;
  if (input.streamId != null && input.sequence != null) return `stream:${input.streamId}:${input.sequence}`;
  return null;
}

export function createRuntimeEvent(input = {}, options = {}) {
  const rawPayload = input.payload ?? {};
  const rawPredecessorIds = input.predecessorIds;
  const rawInterventionIds = input.interventionIds;
  if (options.maxBytes != null && !runtimeEventMaterialFits([rawPayload, rawPredecessorIds, rawInterventionIds], options.maxBytes)) {
    throw new DebugAdapterError('runtime-event-resource-limit', `runtime event exceeds pre-normalization byte budget (${options.maxBytes})`);
  }
  const runtimeSessionId = required(input.runtimeSessionId, 'runtime-session-id-required', 'runtime event requires runtimeSessionId');
  const providerId = required(input.providerId, 'runtime-provider-required', 'runtime event requires providerId');
  const providerVersion = input.providerVersion ?? '1';
  if (typeof providerVersion !== 'string') throw new DebugAdapterError('runtime-invalid-provider-version', 'providerVersion must be a string');
  const sessionEpoch = safeInteger(input.sessionEpoch, 1, 'sessionEpoch', { min: 1 });
  const sequence = input.sequence == null ? null : safeInteger(input.sequence, null, 'sequence');
  const moduleGeneration = input.moduleGeneration == null ? null : safeInteger(input.moduleGeneration, null, 'moduleGeneration', { min: 1 });
  const kind = normalizeKind(input.kind);
  const observationMode = normalizeMode(input.observationMode);
  const completeness = normalizeCompleteness(input.completeness, kind === 'gap' || kind === 'dropped-events' ? 'truncated' : 'partial');
  const payload = jsonSafe(rawPayload);
  const identity = {
    runtimeSessionId,
    providerId,
    providerVersion,
    sessionEpoch,
    streamId: optionalIdentity(input.streamId, 'streamId'),
    sequence,
    providerEventId: optionalIdentity(input.providerEventId, 'providerEventId'),
    kind,
    processKey: optionalText(input.processKey),
    threadKey: optionalText(input.threadKey),
    moduleBindingKey: optionalText(input.moduleBindingKey),
    moduleGeneration,
    payload,
  };
  const eventId = input.eventId == null
    ? `runtimeevent_${stableDigest(identity)}`
    : required(input.eventId, 'runtime-event-id-invalid', 'runtime event id must be a non-empty string');
  return deepFreeze({
    eventId,
    runtimeSessionId,
    providerId,
    providerVersion,
    sessionEpoch,
    streamId: optionalIdentity(input.streamId, 'streamId'),
    sequence,
    predecessorIds: arrayOfStrings(rawPredecessorIds, 'predecessorIds'),
    providerEventId: optionalIdentity(input.providerEventId, 'providerEventId'),
    timestamp: input.timestamp == null ? null : String(input.timestamp),
    processKey: optionalText(input.processKey),
    threadKey: optionalText(input.threadKey),
    moduleBindingKey: optionalText(input.moduleBindingKey),
    moduleGeneration,
    kind,
    payload,
    observationMode,
    completeness,
    interventionIds: arrayOfStrings(rawInterventionIds, 'interventionIds'),
  });
}

export function normalizeLegacyRuntimeEvent(input, context = {}, options = {}) {
  const protocolEnvelope = input && input.type === 'event' && typeof input.event === 'string';
  const source = protocolEnvelope
    ? (input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? input.data : {})
    : (input && input.type === 'event' && input.event ? input.event : input);
  if (!source || typeof source !== 'object') throw new DebugAdapterError('runtime-invalid-event', 'legacy runtime event must be an object');
  const rawLegacyType = protocolEnvelope ? input.event : (source.kind ?? source.type ?? 'trace-marker');
  const legacyType = typeof rawLegacyType === 'string' ? rawLegacyType : 'trace-marker';
  const kindMap = {
    branch: 'basic-block',
    trace: 'trace-marker',
    warning: 'provider-warning',
    error: 'provider-error',
    'stream-truncated': 'gap',
  };
  const kind = RUNTIME_EVENT_KINDS.includes(legacyType) ? legacyType : (kindMap[legacyType] || 'trace-marker');
  const truncated = input?.truncated === true || source.truncated === true || legacyType === 'stream-truncated';
  const envelopeValue = (key) => protocolEnvelope && input[key] != null ? input[key] : source[key];
  return createRuntimeEvent({
    runtimeSessionId: context.runtimeSessionId,
    providerId: context.providerId,
    providerVersion: context.providerVersion,
    sessionEpoch: envelopeValue('epoch') ?? context.sessionEpoch ?? 1,
    streamId: envelopeValue('streamId') ?? context.streamId,
    sequence: envelopeValue('sequence'),
    providerEventId: envelopeValue('providerEventId') ?? envelopeValue('id'),
    timestamp: envelopeValue('timestamp'),
    processKey: envelopeValue('processKey') ?? context.processKey,
    threadKey: envelopeValue('threadKey'),
    moduleBindingKey: envelopeValue('moduleBindingKey'),
    moduleGeneration: envelopeValue('moduleGeneration'),
    kind,
    payload: protocolEnvelope ? (input.data ?? {}) : (source.payload ?? source),
    observationMode: envelopeValue('observationMode') ?? context.observationMode ?? 'observed',
    completeness: envelopeValue('completeness') ?? (truncated ? 'truncated' : context.completeness ?? 'partial'),
    predecessorIds: envelopeValue('predecessorIds'),
    interventionIds: envelopeValue('interventionIds'),
  }, options);
}

export function createRuntimeEventBatch(input = {}) {
  const rawEvents = input.events == null ? [] : input.events;
  if (!Array.isArray(rawEvents)) throw new DebugAdapterError('runtime-invalid-event-array', 'events must be an array');
  const events = rawEvents.map((event) => createRuntimeEvent(event));
  const dropped = safeInteger(input.dropped, 0, 'dropped');
  const runtimeSessionId = required(input.runtimeSessionId ?? events[0]?.runtimeSessionId, 'runtime-session-id-required', 'runtime event batch requires runtimeSessionId');
  const providerId = required(input.providerId ?? events[0]?.providerId, 'runtime-provider-required', 'runtime event batch requires providerId');
  const sessionEpoch = safeInteger(input.sessionEpoch ?? events[0]?.sessionEpoch, 1, 'sessionEpoch', { min: 1 });

  for (const event of events) {
    if (event.runtimeSessionId !== runtimeSessionId || event.providerId !== providerId || event.sessionEpoch !== sessionEpoch) {
      throw new DebugAdapterError('runtime-event-batch-identity-mismatch', 'All events in a batch must match batch runtimeSessionId, providerId, and sessionEpoch');
    }
  }

  const hasLoss = dropped > 0 || events.some((event) => event.kind === 'gap' || event.kind === 'dropped-events' || event.completeness === 'truncated');
  const requested = normalizeCompleteness(input.completeness, hasLoss ? 'truncated' : 'partial');
  let strongestAllowed = hasLoss ? 'truncated' : 'complete';
  for (const event of events) {
    if (COMPLETENESS_RANK[event.completeness] < COMPLETENESS_RANK[strongestAllowed]) strongestAllowed = event.completeness;
  }
  if (COMPLETENESS_RANK[requested] > COMPLETENESS_RANK[strongestAllowed]) {
    throw new DebugAdapterError('runtime-completeness-upgrade', `event batch cannot upgrade ${strongestAllowed} source evidence to ${requested}`);
  }
  return deepFreeze({
    runtimeSessionId,
    providerId,
    sessionEpoch,
    events: Object.freeze(events),
    completeness: requested,
    dropped,
  });
}

export class RuntimeEventNormalizer {
  #queue = [];
  #seen = new Set();
  #dropped = 0;

  constructor(context = {}, options = {}) {
    this.context = { ...context };
    this.maxEvents = safeInteger(options.maxEvents, 4096, 'maxEvents', { min: 1 });
    this.maxBytes = safeInteger(options.maxBytes, 4 * 1024 * 1024, 'maxBytes', { min: 1024 });
    this.maxDedupeEntries = safeInteger(options.maxDedupeEntries, Math.max(8192, this.maxEvents * 2), 'maxDedupeEntries', { min: 16 });
    this.queuedBytes = 0;
  }

  push(input) {
    const hasDirectIdentity = input && typeof input === 'object'
      && ['runtimeSessionId', 'providerId', 'sessionEpoch'].some((key) => Object.hasOwn(input, key));
    const remainingBytes = Math.max(0, this.maxBytes - this.queuedBytes);
    let event;
    try {
      event = hasDirectIdentity
        ? createRuntimeEvent(input, { maxBytes:remainingBytes })
        : normalizeLegacyRuntimeEvent(input, this.context, { maxBytes:remainingBytes });
    } catch (error) {
      if (error?.code !== 'runtime-event-resource-limit') throw error;
      this.#dropped++;
      return null;
    }
    const contextRuntimeSessionId = required(this.context.runtimeSessionId, 'runtime-session-id-required', 'runtime event batch requires runtimeSessionId');
    const contextProviderId = required(this.context.providerId, 'runtime-provider-required', 'runtime event batch requires providerId');
    const contextEpoch = safeInteger(this.context.sessionEpoch, event.sessionEpoch, 'sessionEpoch', { min: 1 });
    if (event.runtimeSessionId !== contextRuntimeSessionId || event.providerId !== contextProviderId || event.sessionEpoch !== contextEpoch) return null;
    const dedupe = dedupeIdentity(event);
    const scoped = dedupe ? `${event.sessionEpoch}:${dedupe}` : null;
    if (scoped && this.#seen.has(scoped)) return null;
    const bytes = encodedByteLength(stableStringify(event));
    if (this.#queue.length >= this.maxEvents || this.queuedBytes + bytes > this.maxBytes) {
      this.#dropped++;
      return null;
    }
    if (scoped) {
      if (this.#seen.size >= this.maxDedupeEntries) {
        const first = this.#seen.values().next().value;
        if (first !== undefined) this.#seen.delete(first);
      }
      this.#seen.add(scoped);
    }
    this.#queue.push(event);
    this.queuedBytes += bytes;
    return event;
  }

  flush() {
    const events = this.#queue;
    let queuedBytes = this.queuedBytes;
    let dropped = this.#dropped;
    this.#queue = [];
    this.queuedBytes = 0;
    this.#dropped = 0;
    if (dropped > 0) {
      while (true) {
        const marker = createRuntimeEvent({
          ...this.context,
          kind: 'dropped-events',
          payload: { dropped },
          observationMode: 'observed',
          completeness: 'truncated',
        });
        const markerBytes = encodedByteLength(stableStringify(marker));
        if (events.length + 1 <= this.maxEvents && queuedBytes + markerBytes <= this.maxBytes) {
          events.unshift(marker);
          break;
        }
        if (events.length === 0) break;
        const evicted = events.pop();
        queuedBytes -= encodedByteLength(stableStringify(evicted));
        const dedupe = dedupeIdentity(evicted);
        if (dedupe) this.#seen.delete(`${evicted.sessionEpoch}:${dedupe}`);
        dropped++;
      }
    }
    return createRuntimeEventBatch({
      runtimeSessionId: this.context.runtimeSessionId,
      providerId: this.context.providerId,
      sessionEpoch: this.context.sessionEpoch ?? 1,
      events,
      completeness: dropped > 0 ? 'truncated' : (events.length ? 'partial' : 'bounded'),
      dropped,
    });
  }

  resetEpoch(epoch) {
    this.context.sessionEpoch = safeInteger(epoch, null, 'sessionEpoch', { min: 1 });
    this.#queue = [];
    this.queuedBytes = 0;
    this.#dropped = 0;
    this.#seen.clear();
  }
}

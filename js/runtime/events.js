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
const RUNTIME_EVENT_ADMISSION_REJECTED = Symbol('runtime-event-admission-rejected');

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

function createRuntimeEventAdmission(maxBytes) {
  let chargedBytes = 0;
  const active = new WeakSet();
  const reject = () => RUNTIME_EVENT_ADMISSION_REJECTED;
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
  // Reject impossible sequence cardinalities before allocating/copying a
  // snapshot. Each sequence has a fixed base cost, at least elementCost per
  // member, and one separator byte after the first member.
  const canFitSequence = (length, baseCost, elementCost) => {
    if (!Number.isSafeInteger(length) || length < 0) return false;
    const remaining = maxBytes - chargedBytes;
    if (remaining < baseCost) return false;
    if (length === 0) return true;
    return length <= Math.floor((remaining - baseCost + 1) / (elementCost + 1));
  };
  const visitBytes = (view) => {
    if (!canFitSequence(view.length, 2, 1)) return reject();
    if (!charge(2)) return reject();
    const snapshot = new Uint8Array(view.length);
    for (let index = 0; index < view.length; index += 1) {
      if (index > 0 && !charge(1)) return reject();
      const byte = view[index];
      const text = String(byte);
      if (!charge(text.length)) return reject();
      snapshot[index] = byte;
    }
    return snapshot;
  };
  const visit = (value, depth, arrayElement = false) => {
    if (depth > MAX_EVENT_ADMISSION_DEPTH) return reject();
    if (value === null) return charge(4) ? null : reject();
    const type = typeof value;
    if (type === 'undefined' || type === 'function' || type === 'symbol') {
      return !arrayElement || charge(4) ? value : reject();
    }
    if (type === 'string') return chargeString(value) ? value : reject();
    if (type === 'boolean') return charge(value ? 4 : 5) ? value : reject();
    if (type === 'number') {
      if (!Number.isFinite(value)) return !arrayElement || charge(4) ? value : reject();
      return charge(String(value).length) ? value : reject();
    }
    if (type === 'bigint') return chargeString(value.toString()) ? value : reject();
    if (type !== 'object') return value;
    if (active.has(value)) return reject();
    active.add(value);
    try {
      if (value instanceof Date) {
        const time = Date.prototype.getTime.call(value);
        if (!Number.isFinite(time)) return new Date(NaN);
        const iso = Date.prototype.toISOString.call(value);
        return chargeString(iso) ? new Date(time) : reject();
      }
      if (value instanceof ArrayBuffer) return visitBytes(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) return visitBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      if (Array.isArray(value)) {
        const length = value.length;
        if (!canFitSequence(length, 2, 1)) return reject();
        if (!charge(2)) return reject();
        const snapshot = new Array(length);
        for (let index = 0; index < length; index += 1) {
          if (index > 0 && !charge(1)) return reject();
          const entryValue = value[index];
          const entrySnapshot = visit(entryValue, depth + 1, true);
          if (entrySnapshot === RUNTIME_EVENT_ADMISSION_REJECTED) return reject();
          snapshot[index] = entrySnapshot;
        }
        return snapshot;
      }
      if (value instanceof Map) {
        if (!canFitSequence(value.size, 10, 2)) return reject();
        if (!charge(10)) return reject();
        const snapshot = new Map();
        let index = 0;
        for (const [key, entryValue] of value) {
          if (index++ > 0 && !charge(1)) return reject();
          const keySnapshot = visit(key, depth + 1, true);
          if (keySnapshot === RUNTIME_EVENT_ADMISSION_REJECTED) return reject();
          const valueSnapshot = visit(entryValue, depth + 1, true);
          if (valueSnapshot === RUNTIME_EVENT_ADMISSION_REJECTED) return reject();
          snapshot.set(keySnapshot, valueSnapshot);
        }
        return snapshot;
      }
      if (value instanceof Set) {
        if (!canFitSequence(value.size, 10, 1)) return reject();
        if (!charge(10)) return reject();
        const snapshot = new Set();
        let index = 0;
        for (const entryValue of value) {
          if (index++ > 0 && !charge(1)) return reject();
          const entrySnapshot = visit(entryValue, depth + 1, true);
          if (entrySnapshot === RUNTIME_EVENT_ADMISSION_REJECTED) return reject();
          snapshot.add(entrySnapshot);
        }
        return snapshot;
      }
      if (!charge(2)) return reject();
      const snapshot = {};
      let index = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        // Even values jsonSafe() later omits still cost raw traversal work.
        // Charge one byte-equivalent per property so malformed/irrelevant
        // metadata cannot defeat the bounded preflight with omitted values.
        if (!charge(1)) return reject();
        const entryValue = value[key];
        const entryType = typeof entryValue;
        let entrySnapshot = entryValue;
        if (entryType !== 'undefined' && entryType !== 'function' && entryType !== 'symbol'
          && !(entryType === 'number' && !Number.isFinite(entryValue))) {
          if (index++ > 0 && !charge(1)) return reject();
          if (!chargeString(key) || !charge(1)) return reject();
          entrySnapshot = visit(entryValue, depth + 1);
          if (entrySnapshot === RUNTIME_EVENT_ADMISSION_REJECTED) return reject();
        }
        Object.defineProperty(snapshot, key, {
          value:entrySnapshot,
          enumerable:true,
          configurable:true,
          writable:true,
        });
      }
      return snapshot;
    } finally {
      active.delete(value);
    }
  };

  return (value) => {
    const snapshot = visit(value, 0);
    return snapshot === RUNTIME_EVENT_ADMISSION_REJECTED
      ? { ok:false, snapshot:null }
      : { ok:true, snapshot };
  };
}

function admitRuntimeEventMaterial(admit, value, maxBytes, { snapshot = false } = {}) {
  if (!admit) return value;
  const result = admit(value);
  if (!result.ok) {
    throw new DebugAdapterError('runtime-event-resource-limit', `runtime event exceeds pre-normalization byte budget (${maxBytes})`);
  }
  return snapshot ? result.snapshot : value;
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
  const admit = options.maxBytes == null ? null : createRuntimeEventAdmission(options.maxBytes);
  const admitted = (value) => admitRuntimeEventMaterial(admit, value, options.maxBytes);
  const admittedSnapshot = (value) => admitRuntimeEventMaterial(admit, value, options.maxBytes, { snapshot:true });
  const admittedOptionalText = (value, name) => {
    const raw = admitted(value);
    if (admit && raw != null && typeof raw !== 'string') {
      throw new DebugAdapterError('runtime-invalid-event-text', `${name} must be a string`);
    }
    return optionalText(raw);
  };

  const rawRuntimeSessionId = admitted(input.runtimeSessionId);
  const runtimeSessionId = required(rawRuntimeSessionId, 'runtime-session-id-required', 'runtime event requires runtimeSessionId');
  const rawProviderId = admitted(input.providerId);
  const providerId = required(rawProviderId, 'runtime-provider-required', 'runtime event requires providerId');
  const providerVersion = admitted(input.providerVersion ?? '1');
  if (typeof providerVersion !== 'string') throw new DebugAdapterError('runtime-invalid-provider-version', 'providerVersion must be a string');
  const rawSessionEpoch = admitted(input.sessionEpoch);
  const sessionEpoch = safeInteger(rawSessionEpoch, 1, 'sessionEpoch', { min: 1 });
  const rawSequence = admitted(input.sequence);
  const sequence = rawSequence == null ? null : safeInteger(rawSequence, null, 'sequence');
  const rawModuleGeneration = admitted(input.moduleGeneration);
  const moduleGeneration = rawModuleGeneration == null ? null : safeInteger(rawModuleGeneration, null, 'moduleGeneration', { min: 1 });
  const kind = normalizeKind(admitted(input.kind));
  const observationMode = normalizeMode(admitted(input.observationMode));
  const completeness = normalizeCompleteness(admitted(input.completeness), kind === 'gap' || kind === 'dropped-events' ? 'truncated' : 'partial');
  const rawPayload = admittedSnapshot(input.payload ?? {});
  const payload = jsonSafe(rawPayload);
  const streamId = optionalIdentity(admitted(input.streamId), 'streamId');
  const providerEventId = optionalIdentity(admitted(input.providerEventId), 'providerEventId');
  const processKey = admittedOptionalText(input.processKey, 'processKey');
  const threadKey = admittedOptionalText(input.threadKey, 'threadKey');
  const moduleBindingKey = admittedOptionalText(input.moduleBindingKey, 'moduleBindingKey');
  const identity = {
    runtimeSessionId,
    providerId,
    providerVersion,
    sessionEpoch,
    streamId,
    sequence,
    providerEventId,
    kind,
    processKey,
    threadKey,
    moduleBindingKey,
    moduleGeneration,
    payload,
  };
  const rawEventId = admitted(input.eventId);
  const eventId = rawEventId == null
    ? `runtimeevent_${stableDigest(identity)}`
    : required(rawEventId, 'runtime-event-id-invalid', 'runtime event id must be a non-empty string');
  const predecessorIds = arrayOfStrings(admittedSnapshot(input.predecessorIds), 'predecessorIds');
  const timestamp = admittedOptionalText(input.timestamp, 'timestamp');
  const interventionIds = arrayOfStrings(admittedSnapshot(input.interventionIds), 'interventionIds');
  return deepFreeze({
    eventId,
    runtimeSessionId,
    providerId,
    providerVersion,
    sessionEpoch,
    streamId,
    sequence,
    predecessorIds,
    providerEventId,
    timestamp,
    processKey,
    threadKey,
    moduleBindingKey,
    moduleGeneration,
    kind,
    payload,
    observationMode,
    completeness,
    interventionIds,
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
    /* #5680: the batch must never claim stronger completeness than its
       weakest queued event. createRuntimeEventBatch() rejects upgrades, so
       a successfully accepted truncated/unsupported source event must
       demote the requested completeness instead of failing the flush. */
    let requested = dropped > 0 ? 'truncated' : (events.length ? 'partial' : 'bounded');
    for (const event of events) {
      if (COMPLETENESS_RANK[event.completeness] < COMPLETENESS_RANK[requested]) {
        requested = event.completeness;
      }
    }
    return createRuntimeEventBatch({
      runtimeSessionId: this.context.runtimeSessionId,
      providerId: this.context.providerId,
      sessionEpoch: this.context.sessionEpoch ?? 1,
      events,
      completeness: requested,
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
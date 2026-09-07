/** Query-local identity and resource authority; no persistent analysis cache. */
export const IDENTITY_FIELDS = Object.freeze([
  'queryId', 'snapshotId', 'binaryId', 'functionId', 'architecture', 'addressSpace', 'semanticsVersion',
]);
// Read bounded schema fields, not arbitrary caller getters or coercion hooks.
// AbortSignal/lifecycle callbacks below are deliberate observer interfaces.
function dataField(object, key) {
  if (object == null) return undefined;
  if (typeof object !== 'object' || Array.isArray(object)) throw new TypeError('data record required');
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value') || !descriptor && key in object) {
    throw new TypeError(`data field required: ${key}`);
  }
  return descriptor?.value;
}
export function memoryIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('memory identity required');
  const result = {};
  for (const key of IDENTITY_FIELDS) {
    const field = dataField(value, key);
    if (typeof field !== 'string' || !field.trim() || field.length > 1024) {
      throw new TypeError(`identity.${key} must be a bounded nonempty string`);
    }
    result[key] = field;
  }
  return Object.freeze(result);
}
export function sameMemoryIdentity(a, b) {
  try {
    if (!a || !b) return false;
    for (const key of IDENTITY_FIELDS) {
      const left = dataField(a,key), right = dataField(b,key);
      if (typeof left !== 'string' || !left.trim() || left.length > 1024 || left !== right) return false;
    }
    return true;
  } catch { return false; }
}
export function boundedLimit(value, fallback, maximum, name) {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > maximum) {
    throw new TypeError(`${name} must be an integer in [0, ${maximum}]`);
  }
  return n;
}
export class QueryFailure extends Error {
  constructor(reason) { super(reason); this.name = 'QueryFailure'; this.reason = reason; }
}
export const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
export function createQueryGuard(options, ceilings) {
  // Capture observer references before running caller code. An async caller
  // cannot later remove the signal, change identity authority or extend limits.
  const identity = memoryIdentity(dataField(options,'identity'));
  const now = dataField(options,'now') ?? monotonicNow;
  const signal = dataField(options,'signal');
  const isCancelled = dataField(options,'isCancelled');
  const getCurrentIdentity = dataField(options,'getCurrentIdentity');
  const duration = boundedLimit(dataField(options,'timeoutMs'), 250, 5000, 'timeoutMs');
  const suppliedLimits = dataField(options,'limits');
  const limits = {}, counts = {};
  for (const [key, maximum] of Object.entries(ceilings)) {
    limits[key] = boundedLimit(dataField(suppliedLimits,key), maximum, maximum, key);
    counts[key] = 0;
  }
  let reason = null;
  const fail = (code) => { reason ||= code; throw new QueryFailure(reason); };
  function sample() {
    try {
      if (typeof now !== 'function') fail('invalid-clock');
      return now();
    } catch { fail('invalid-clock'); }
  }
  const realStarted = monotonicNow(), started = sample();
  if (typeof started !== 'number' || !Number.isFinite(started)) fail('invalid-clock');
  let last = started;
  function elapsed(validate = false) {
    const sampled = sample();
    if (typeof sampled !== 'number' || !Number.isFinite(sampled) || sampled < last) {
      if (validate) fail('invalid-clock');
    } else last = sampled;
    // A deterministic caller clock cannot extend the real wall allowance.
    return Math.max(last - started, monotonicNow() - realStarted);
  }
  function signalCheck() {
    try { if (signal?.aborted) fail('cancelled'); }
    catch { fail('cancelled'); }
  }
  function check(current = identity) {
    if (reason) throw new QueryFailure(reason);
    signalCheck();
    const time = elapsed(true);
    if (!sameMemoryIdentity(identity, current)) fail('stale-identity');
    if (getCurrentIdentity != null) {
      let currentIdentity;
      try {
        if (typeof getCurrentIdentity !== 'function') fail('stale-identity');
        currentIdentity = getCurrentIdentity();
      } catch { fail('stale-identity'); }
      if (!sameMemoryIdentity(identity,currentIdentity)) fail('stale-identity');
    }
    if (isCancelled != null) {
      try { if (typeof isCancelled !== 'function' || isCancelled()) fail('cancelled'); }
      catch { fail('cancelled'); }
    }
    // This is deliberately after EVERY caller callback, including the clock.
    signalCheck();
    if (time >= duration || monotonicNow() - realStarted >= duration) fail('deadline');
  }
  function take(key, amount = 1) {
    check();
    if (!Number.isSafeInteger(amount) || amount < 0 || !Object.hasOwn(limits, key)) throw new TypeError('invalid resource charge');
    if (amount > limits[key] - counts[key]) fail(`budget:${key}`);
    counts[key] += amount;
  }
  return Object.freeze({ identity, limits: Object.freeze(limits), check, take, fail,
    metrics: () => {
      if (!reason) { try { elapsed(); } catch { /* Retain the sticky failure; diagnostics must remain observable. */ } }
      return Object.freeze({ ...counts, wallClock: Math.max(last-started,monotonicNow()-realStarted) });
    },
    remainingMilliseconds: () => { check(); return Math.max(0, duration - Math.max(last - started,monotonicNow() - realStarted)); },
    reason: () => reason,
  });
}

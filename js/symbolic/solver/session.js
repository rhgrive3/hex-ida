/**
 * js/symbolic/solver/session.js
 *
 * Solver lifecycle boundary. A timeout/cancel/stale/disposed computation is
 * invalidated before its provider result can cross the verification boundary.
 * Providers may still finish late, but their result is deliberately dropped.
 */

import { SOLVER_STATUS, createSolverResult } from './result.js';

export const SESSION_STATE = Object.freeze({
  ACTIVE: 'active',
  CANCELLED: 'cancelled',
  DISPOSED: 'disposed',
  TERMINATED: 'terminated',
});

function defaultAbortReason() {
  if (typeof DOMException === 'function') return new DOMException('This operation was aborted', 'AbortError');
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function makeAbortController() {
  if (typeof AbortController === 'function') return new AbortController();
  let aborted = false;
  let reason;
  const listeners = new Map();
  const signal = {
    get aborted() { return aborted; },
    get reason() { return reason; },
    throwIfAborted() { if (aborted) throw reason; },
    addEventListener(type, listener, options = undefined) {
      if (type !== 'abort' || listener == null || aborted) return;
      if (!listeners.has(listener)) listeners.set(listener, Boolean(options && typeof options === 'object' && options.once));
    },
    removeEventListener(type, listener) { if (type === 'abort') listeners.delete(listener); },
  };
  return {
    signal,
    abort(abortReason = undefined) {
      if (aborted) return;
      aborted = true;
      reason = abortReason === undefined ? defaultAbortReason() : abortReason;
      try {
        for (const [listener, once] of listeners) {
          if (once) listeners.delete(listener);
          try {
            if (typeof listener === 'function') listener.call(signal);
            else if (typeof listener?.handleEvent === 'function') listener.handleEvent.call(listener);
          } catch { /* AbortSignal listener failures are isolated */ }
        }
      } finally {
        listeners.clear();
      }
    },
  };
}

const DEFAULT_SESSION_TIMEOUT_MS = 5000;

function isValidTimeoutMs(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safeOptionData(value, name) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an options object`);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { throw new TypeError(`${name} must be plain data`); }
  const snapshot = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new TypeError(`${name} cannot contain symbol keys`);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError(`${name}.${key} cannot be an accessor`);
    }
    if (!descriptor.enumerable) throw new TypeError(`${name}.${key} must be enumerable data`);
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function queryHashHint(query) {
  if (query == null || typeof query !== 'object') return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(query, 'queryHash');
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function providerResultData(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('provider result must be a plain object');
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { throw new TypeError('provider result is unreadable'); }
  const snapshot = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new TypeError('provider result contains a symbol field');
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError(`provider result field '${key}' is an accessor`);
    }
    if (!descriptor.enumerable) throw new TypeError(`provider result field '${key}' is not enumerable`);
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function providerDataField(value, key) {
  if (value == null || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeReason(value, fallback) {
  return value == null || value === '' ? fallback : String(value);
}

export class SolverSession {
  constructor(backend, options = {}) {
    const capturedOptions = safeOptionData(options, 'session options');
    if (Object.hasOwn(capturedOptions, 'timeoutMs') && capturedOptions.timeoutMs !== undefined &&
        !isValidTimeoutMs(capturedOptions.timeoutMs)) {
      throw new TypeError('timeoutMs must be a primitive non-negative safe integer');
    }
    if (capturedOptions.timeoutMs === undefined) delete capturedOptions.timeoutMs;
    this.backend = backend;
    this.options = Object.freeze(capturedOptions);
    this.state = SESSION_STATE.ACTIVE;
    this.currentQueryToken = 0;
    this._inFlight = new Map();
    this._terminationReason = null;
  }

  isDisposed() { return this.state === SESSION_STATE.DISPOSED; }
  isCancelled() { return this.state === SESSION_STATE.CANCELLED; }
  isTerminated() { return this.state === SESSION_STATE.TERMINATED; }

  _result(status, reason, lifecycle = {}, queryHash = null) {
    return createSolverResult({
      status,
      reason,
      backend: this.backend?.id || 'unknown',
      backendVersion: this.backend?.version || '0.0.0',
      queryHash,
      lifecycle: { publishable: false, ...lifecycle },
    });
  }

  _invalidatePreviousQueries() {
    for (const record of [...this._inFlight.values()]) {
      record.stale = true;
      try { record.controller.abort(); } catch { /* best effort */ }
      record.settle(this._result(SOLVER_STATUS.CANCELLED, 'stale-query-token-discarded', {
        stale: true,
        cancelled: true,
        late: true,
      }, record.queryHash));
      try { this._onStale(record.token); } catch { /* provider cleanup is best effort */ }
    }
  }

  async check(query, options = {}) {
    if (this.isDisposed()) return this._result(SOLVER_STATUS.INVALID_QUERY, 'session-already-disposed', { disposed: true }, queryHashHint(query));
    if (this.isCancelled()) return this._result(SOLVER_STATUS.CANCELLED, 'session-was-cancelled', { cancelled: true }, queryHashHint(query));
    if (this.isTerminated()) return this._result(SOLVER_STATUS.INVALID_QUERY, `session-terminated:${this._terminationReason || 'provider'}`, { disposed: true }, queryHashHint(query));
    const optionValues = safeOptionData(options, 'query options');
    const externalSignal = optionValues.signal;
    if (externalSignal != null && (
      typeof externalSignal !== 'object' ||
      typeof externalSignal.addEventListener !== 'function' ||
      typeof externalSignal.removeEventListener !== 'function'
    )) {
      throw new TypeError('external signal must be AbortSignal-compatible');
    }
    if (externalSignal?.aborted) {
      return this._result(SOLVER_STATUS.CANCELLED, 'query-signal-already-aborted', { cancelled: true }, queryHashHint(query));
    }

    const requestedTimeoutMs = optionValues.timeoutMs;
    if (requestedTimeoutMs !== undefined && !isValidTimeoutMs(requestedTimeoutMs)) {
      return this._result(SOLVER_STATUS.INVALID_QUERY,
        'invalid-budget:timeoutMs must be a primitive non-negative safe integer', {}, null);
    }
    const timeoutMs = requestedTimeoutMs === undefined
      ? (this.options.timeoutMs === undefined ? DEFAULT_SESSION_TIMEOUT_MS : this.options.timeoutMs)
      : requestedTimeoutMs;
    const queryHash = queryHashHint(query);

    // Input validation above has no lifecycle side effects. Only a validated
    // query budget may invalidate an earlier in-flight request or consume a token.
    this._invalidatePreviousQueries();
    const token = ++this.currentQueryToken;
    const controller = makeAbortController();
    const record = {
      token,
      queryHash,
      controller,
      stale: false,
      timedOut: false,
      cancelled: false,
      disposed: false,
      settled: false,
      timer: null,
      resolve: null,
      settle: null,
      removeExternalAbort: null,
    };
    const promise = new Promise((resolve) => { record.resolve = resolve; });

    const settle = (rawResult) => {
      if (record.settled) return;
      let result;
      const rawStatus = providerDataField(rawResult, 'status');
      const rawReason = providerDataField(rawResult, 'reason');
      if (record.timedOut) {
        result = this._result(SOLVER_STATUS.TIMEOUT,
          safeReason(rawReason, `query execution timed out after ${timeoutMs}ms`),
          { timedOut: true, late: rawStatus === SOLVER_STATUS.SAT || rawStatus === SOLVER_STATUS.UNSAT },
          record.queryHash);
      } else if (record.cancelled || record.disposed || record.stale || token !== this.currentQueryToken) {
        const stale = record.stale || token !== this.currentQueryToken;
        result = this._result(SOLVER_STATUS.CANCELLED,
          record.disposed ? 'session-disposed-during-execution' : stale
            ? 'stale-query-token-discarded'
            : 'session-cancelled-during-execution',
          { cancelled: true, stale, disposed: record.disposed,
            late: rawStatus === SOLVER_STATUS.SAT || rawStatus === SOLVER_STATUS.UNSAT },
          record.queryHash);
      } else {
        try {
          const data = providerResultData(rawResult);
          if (!Object.values(SOLVER_STATUS).includes(data.status)) {
            result = this._result(SOLVER_STATUS.PROVIDER_FAILURE, 'provider-returned-invalid-result', {}, record.queryHash);
          } else {
            result = createSolverResult(data);
          }
        } catch {
          result = this._result(SOLVER_STATUS.PROVIDER_FAILURE, 'provider-result-normalization-failed', {}, record.queryHash);
        }
      }

      record.settled = true;
      if (record.timer) clearTimeout(record.timer);
      if (record.removeExternalAbort) {
        try { record.removeExternalAbort(); } catch { /* listener cleanup is best effort */ }
      }
      this._inFlight.delete(token);
      record.resolve(result);
    };
    record.settle = settle;

    if (externalSignal) {
      const onAbort = () => {
        if (record.settled) return;
        record.cancelled = true;
        this.currentQueryToken++;
        this.state = SESSION_STATE.CANCELLED;
        try { controller.abort(); } catch { /* best effort */ }
        Promise.resolve(this._onCancel()).catch(() => {});
        settle(this._result(SOLVER_STATUS.CANCELLED, 'query-signal-aborted', { cancelled: true }, record.queryHash));
      };
      record.removeExternalAbort = () => externalSignal.removeEventListener('abort', onAbort);
      try {
        externalSignal.addEventListener('abort', onAbort, { once: true });
      } catch {
        try { record.removeExternalAbort(); } catch { /* best effort */ }
        record.removeExternalAbort = null;
        throw new TypeError('external signal must be AbortSignal-compatible');
      }
      if (externalSignal.aborted) onAbort();
      if (record.settled) return promise;
    }

    this._inFlight.set(token, record);

    if (timeoutMs > 0) {
      record.timer = setTimeout(() => {
        if (record.settled) return;
        record.timedOut = true;
        this.currentQueryToken++;
        this.state = SESSION_STATE.TERMINATED;
        this._terminationReason = 'timeout';
        try { controller.abort(); } catch { /* best effort */ }
        Promise.resolve(this._onTimeout(token)).catch(() => {});
        settle(this._result(SOLVER_STATUS.TIMEOUT, `query execution timed out after ${timeoutMs}ms`,
          { timedOut: true }, record.queryHash));
      }, timeoutMs);
    }

    Promise.resolve()
      .then(() => record.settled ? undefined : this._executeCheck(query,
        { ...optionValues, timeoutMs, signal: controller.signal }, token, controller.signal))
      .then((result) => { if (!record.settled) settle(result); })
      .catch((error) => {
        if (!record.settled) settle(this._result(SOLVER_STATUS.PROVIDER_FAILURE, error?.message || 'provider-failure', {}, record.queryHash));
      });

    return promise;
  }

  async cancel() {
    if (this.state === SESSION_STATE.CANCELLED || this.state === SESSION_STATE.DISPOSED) return;
    if (this.state === SESSION_STATE.TERMINATED) return;
    this.state = SESSION_STATE.CANCELLED;
    this.currentQueryToken++;
    for (const record of [...this._inFlight.values()]) {
      record.cancelled = true;
      try { record.controller.abort(); } catch { /* best effort */ }
      record.settle(this._result(SOLVER_STATUS.CANCELLED, 'session-cancelled-during-execution',
        { cancelled: true }, record.queryHash));
    }
    await this._onCancel();
  }

  async dispose() {
    if (this.state === SESSION_STATE.DISPOSED) return;
    const wasTerminated = this.state === SESSION_STATE.TERMINATED;
    this.state = SESSION_STATE.DISPOSED;
    this.currentQueryToken++;
    for (const record of [...this._inFlight.values()]) {
      record.disposed = true;
      try { record.controller.abort(); } catch { /* best effort */ }
      record.settle(this._result(SOLVER_STATUS.CANCELLED, 'session-disposed-during-execution',
        { disposed: true, cancelled: true }, record.queryHash));
    }
    await this._onDispose(wasTerminated);
  }

  async _onCancel() {}
  async _onTimeout() {}
  async _onStale() {}
  async _onDispose() {}

  async _executeCheck() {
    throw new Error('_executeCheck must be implemented by solver session subclass');
  }
}

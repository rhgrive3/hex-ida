/**
 * js/symbolic/solver/session.js
 *
 * Solver lifecycle boundary. A timeout/cancel/stale/disposed computation is
 * invalidated before its provider result can cross the verification boundary.
 * Providers may still finish late, but their result is deliberately dropped.
 */

import { SOLVER_STATUS, createSolverResult } from './result.js';
import { validateVerificationQuery } from '../verify/query.js';

export const SESSION_STATE = Object.freeze({
  ACTIVE: 'active',
  CANCELLED: 'cancelled',
  DISPOSED: 'disposed',
  TERMINATED: 'terminated',
});

function makeAbortController() {
  if (typeof AbortController === 'function') return new AbortController();
  let aborted = false;
  const listeners = new Set();
  return {
    signal: {
      get aborted() { return aborted; },
      addEventListener(type, listener) { if (type === 'abort') listeners.add(listener); },
      removeEventListener(type, listener) { if (type === 'abort') listeners.delete(listener); },
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const listener of listeners) listener();
      listeners.clear();
    },
  };
}

function safeReason(value, fallback) {
  return value == null || value === '' ? fallback : String(value);
}

function requireNonNegativeSafeInteger(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a primitive non-negative safe integer`);
  }
  return value;
}

export class SolverSession {
  constructor(backend, options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, 'timeoutMs')) requireNonNegativeSafeInteger(options.timeoutMs, 'timeoutMs');
    this.backend = backend;
    this.options = Object.freeze({ ...options });
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
    let trustedQueryHash = query?.queryHash || null;
    if (this.backend?.requiresCanonicalQueryIdentity) {
      const identity = validateVerificationQuery(query, { maxExprNodes: this.backend.maxExprNodes || 100000 });
      if (!identity.valid) {
        return this._result(identity.limitExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY, identity.reason, {
          budgetExceeded: identity.limitExceeded === true,
        }, null);
      }
      trustedQueryHash = identity.recomputedHash;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'timeoutMs')) {
      try { requireNonNegativeSafeInteger(options.timeoutMs, 'timeoutMs'); }
      catch (error) { return this._result(SOLVER_STATUS.INVALID_QUERY, `invalid-budget:${error.message}`, {}, null); }
    }
    if (this.isDisposed()) return this._result(SOLVER_STATUS.INVALID_QUERY, 'session-already-disposed', { disposed: true }, trustedQueryHash);
    if (this.isCancelled()) return this._result(SOLVER_STATUS.CANCELLED, 'session-was-cancelled', { cancelled: true }, trustedQueryHash);
    if (this.isTerminated()) return this._result(SOLVER_STATUS.INVALID_QUERY, `session-terminated:${this._terminationReason || 'provider'}`, { disposed: true }, trustedQueryHash);
    if (options.signal?.aborted) return this._result(SOLVER_STATUS.CANCELLED, 'query-signal-already-aborted', { cancelled: true }, trustedQueryHash);

    this._invalidatePreviousQueries();
    const token = ++this.currentQueryToken;
    const controller = makeAbortController();
    const sessionTimeoutMs = Object.prototype.hasOwnProperty.call(this.options, 'timeoutMs') ? this.options.timeoutMs : 5000;
    const requestedTimeoutMs = options.timeoutMs;
    const timeoutMs = requestedTimeoutMs == null
      ? sessionTimeoutMs
      : requestedTimeoutMs;
    const record = {
      token,
      queryHash: trustedQueryHash,
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
      record.settled = true;
      if (record.timer) clearTimeout(record.timer);
      if (record.removeExternalAbort) record.removeExternalAbort();
      this._inFlight.delete(token);

      let result = rawResult;
      if (!result || typeof result !== 'object' || !Object.values(SOLVER_STATUS).includes(result.status)) {
        result = this._result(SOLVER_STATUS.PROVIDER_FAILURE, 'provider-returned-invalid-result', {}, record.queryHash);
      }

      if (record.timedOut) {
        result = this._result(SOLVER_STATUS.TIMEOUT, safeReason(result.reason, 'query timed out'), {
          timedOut: true,
          late: rawResult?.status === SOLVER_STATUS.SAT || rawResult?.status === SOLVER_STATUS.UNSAT,
        }, record.queryHash);
      } else if (record.cancelled || record.disposed || record.stale || token !== this.currentQueryToken) {
        result = this._result(
          SOLVER_STATUS.CANCELLED,
          record.disposed ? 'session-disposed-during-execution' : record.stale || token !== this.currentQueryToken
            ? 'stale-query-token-discarded'
            : 'session-cancelled-during-execution',
          {
            cancelled: true,
            stale: record.stale || token !== this.currentQueryToken,
            disposed: record.disposed,
            late: rawResult?.status === SOLVER_STATUS.SAT || rawResult?.status === SOLVER_STATUS.UNSAT,
          },
          record.queryHash,
        );
      } else {
        const finalIdentity = this.backend?.requiresCanonicalQueryIdentity
          ? validateVerificationQuery(query, { maxExprNodes: this.backend.maxExprNodes || 100000 })
          : null;
        if (finalIdentity && (!finalIdentity.valid || finalIdentity.recomputedHash !== record.queryHash)) {
          result = this._result(
            finalIdentity.limitExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY,
            `query-identity-changed-during-execution:${finalIdentity.reason || 'hash-mismatch'}`,
            { budgetExceeded: finalIdentity.limitExceeded === true },
            null,
          );
        } else {
          result = createSolverResult({
            ...result,
            lifecycle: { ...(result.lifecycle || {}), publishable: result.lifecycle?.publishable !== false },
          });
        }
      }
      record.resolve(result);
    };
    record.settle = settle;
    this._inFlight.set(token, record);

    if (options.signal?.addEventListener) {
      const onAbort = () => {
        record.cancelled = true;
        this.currentQueryToken++;
        this.state = SESSION_STATE.CANCELLED;
        try { controller.abort(); } catch { /* best effort */ }
        Promise.resolve(this._onCancel()).catch(() => {});
        settle(this._result(SOLVER_STATUS.CANCELLED, 'query-signal-aborted', { cancelled: true }, record.queryHash));
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      record.removeExternalAbort = () => options.signal.removeEventListener?.('abort', onAbort);
    }

    if (timeoutMs > 0) {
      record.timer = setTimeout(() => {
        if (record.settled) return;
        record.timedOut = true;
        this.currentQueryToken++;
        this.state = SESSION_STATE.TERMINATED;
        this._terminationReason = 'timeout';
        try { controller.abort(); } catch { /* best effort */ }
        Promise.resolve(this._onTimeout(token)).catch(() => {});
        settle(this._result(SOLVER_STATUS.TIMEOUT, `query execution timed out after ${timeoutMs}ms`, { timedOut: true }, record.queryHash));
      }, timeoutMs);
    }

    Promise.resolve()
      // Pass the normalized effective deadline to providers as well as owning
      // the host timer. CPU-bound compilation can then fail closed even before
      // the event loop has an opportunity to deliver the timer callback.
      .then(() => this._executeCheck(query, { ...options, timeoutMs, signal: controller.signal }, token, controller.signal))
      .then((result) => { if (!record.settled) settle(result); })
      .catch((error) => {
        if (!record.settled) settle(this._result(SOLVER_STATUS.PROVIDER_FAILURE, error?.message || 'provider-failure', {}, record.queryHash));
      });

    return promise;
  }

  async cancel() {
    if (this.state === SESSION_STATE.CANCELLED || this.state === SESSION_STATE.DISPOSED) return;
    // A terminated session has already performed its hard cleanup. Calling
    // cancel again must not touch or reuse the dead provider/worker.
    if (this.state === SESSION_STATE.TERMINATED) return;
    this.state = SESSION_STATE.CANCELLED;
    this.currentQueryToken++;
    for (const record of [...this._inFlight.values()]) {
      record.cancelled = true;
      try { record.controller.abort(); } catch { /* best effort */ }
      record.settle(this._result(SOLVER_STATUS.CANCELLED, 'session-cancelled-during-execution', { cancelled: true }, record.queryHash));
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
      record.settle(this._result(SOLVER_STATUS.CANCELLED, 'session-disposed-during-execution', { disposed: true, cancelled: true }, record.queryHash));
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

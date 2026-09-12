/**
 * Dedicated Worker transport for the browser-safe exhaustive exact backend.
 * The host owns timeout/lifecycle and terminates stale work so late results
 * cannot re-enter the proof boundary.
 */

import { validateSatModel } from '../verify/validate-model.js';
import { validateVerificationQuery } from '../verify/query.js';
import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { positiveFiniteBudget } from './budget.js';
import { collectSymbols, ExhaustiveBvBackend } from './exhaustive-backend.js';
import { validateExactModelBindings } from './model-boundary.js';
import { SOLVER_STATUS, createSolverResult, isValidSolverResult } from './result.js';
import { SolverSession } from './session.js';
import { isCanonicalRequestId } from './worker-protocol.js';

export const WORKER_BACKEND_ID = 'hex-exhaustive-bv-worker';
export const WORKER_BACKEND_VERSION = '1.0.0';

function defaultWorkerFactory() {
  if (typeof globalThis.Worker !== 'function') throw new Error('solver-worker-unavailable');
  return new globalThis.Worker(new URL('./worker-entry.js', import.meta.url), { type: 'module' });
}

class WorkerSolverSession extends SolverSession {
  constructor(backend, options = {}) {
    super(backend, options);
    this.requestSequence = 0;
    this.pending = new Map();
    this.worker = null;
    this.terminated = false;
    this._createWorker();
  }

  _createWorker() {
    try {
      this.worker = this.backend.workerFactory();
      this._attachWorker(this.worker);
      this.terminated = false;
      this.initializationError = null;
    } catch (error) {
      this.initializationError = error;
      this.worker = null;
    }
  }

  _attachWorker(worker) {
    const onMessage = (event) => {
      const message = event?.data ?? event;
      if (!message || message.type !== 'solver-result') return;
      if (!isCanonicalRequestId(message.requestId)) return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);

      // Existing legacy { queryHash } fixtures may omit the optional token,
      // but canonical VerificationQuery requests must carry the exact
      // host-minted token. A supplied token is always an identity assertion.
      const tokenMatches = (pending.legacyEnvelope && message.token === undefined) ||
        message.token === pending.token;
      const identityOk = tokenMatches && isValidSolverResult(message.result, {
        query: { queryHash: pending.queryHash },
        backend: this.backend,
      });
      if (!identityOk) {
        pending.resolve(createSolverResult({
          status: SOLVER_STATUS.PROVIDER_FAILURE,
          reason: 'solver-worker-result-identity-mismatch',
          backend: this.backend.id,
          backendVersion: this.backend.version,
          queryHash: pending.queryHash,
          lifecycle: { publishable: false },
        }));
        return;
      }

      if (message.result.status === SOLVER_STATUS.SAT) {
        const bindings = validateExactModelBindings(pending.symbols, message.result.model);
        const semantic = bindings.valid ? validateSatModel(pending.query, message.result.model) : bindings;
        if (!semantic.valid) {
          pending.resolve(createSolverResult({
            status: SOLVER_STATUS.PROVIDER_FAILURE,
            reason: `solver-worker-model-validation-failed:${semantic.reason}`,
            backend: this.backend.id,
            backendVersion: this.backend.version,
            queryHash: pending.queryHash,
            lifecycle: { publishable: false },
          }));
          return;
        }
      }

      try {
        pending.resolve(createSolverResult(message.result));
      } catch {
        pending.resolve(createSolverResult({
          status: SOLVER_STATUS.PROVIDER_FAILURE,
          reason: 'solver-worker-result-snapshot-failed',
          backend: this.backend.id,
          backendVersion: this.backend.version,
          queryHash: pending.queryHash,
          lifecycle: { publishable: false },
        }));
      }
    };
    const onError = (event) => {
      const reason = event?.message || 'solver-worker-failure';
      for (const pending of this.pending.values()) {
        pending.resolve(createSolverResult({
          status: SOLVER_STATUS.PROVIDER_FAILURE,
          reason,
          backend: this.backend.id,
          backendVersion: this.backend.version,
          queryHash: pending.queryHash,
          lifecycle: { publishable: false },
        }));
      }
      this.pending.clear();
    };
    if (typeof worker.addEventListener === 'function') {
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      this.removeWorkerListeners = () => {
        worker.removeEventListener?.('message', onMessage);
        worker.removeEventListener?.('error', onError);
      };
    } else {
      worker.onmessage = onMessage;
      worker.onerror = onError;
      this.removeWorkerListeners = () => {
        worker.onmessage = null;
        worker.onerror = null;
      };
    }
  }

  async _executeCheck(query, options = {}, token, signal) {
    let querySnapshot;
    try {
      querySnapshot = structuredClone(query);
    } catch (error) {
      return createSolverResult({
        status: SOLVER_STATUS.INVALID_QUERY,
        reason: `solver-worker-query-clone-failed:${error?.message || 'uncloneable-query'}`,
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: null,
        lifecycle: { publishable: false },
      });
    }

    // The narrow worker keeps the legacy { queryHash } transport envelope used
    // by existing host fixtures. Canonical VerificationQuery objects receive
    // the same content/hash check as the tiered worker before crossing the
    // structured-clone boundary.
    const legacyEnvelope = query && typeof query === 'object' &&
      Object.keys(query).length === 1 && typeof query.queryHash === 'string';
    let queryValidation = null;
    let symbols = [];
    if (!legacyEnvelope) {
      queryValidation = validateVerificationQuery(query, { maxExprNodes: this.backend.maxExprNodes });
      if (!queryValidation.valid) {
        return createSolverResult({
          status: queryValidation.limitExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY,
          reason: queryValidation.reason,
          backend: this.backend.id,
          backendVersion: this.backend.version,
          queryHash: null,
          lifecycle: { budgetExceeded: queryValidation.limitExceeded === true, publishable: false },
        });
      }
      // Recompute from the cloned value so caller-side mutation cannot change
      // the meaning after the host began this request.
      const clonedValidation = validateVerificationQuery(querySnapshot, { maxExprNodes: this.backend.maxExprNodes });
      if (!clonedValidation.valid || clonedValidation.recomputedHash !== queryValidation.recomputedHash) {
        return createSolverResult({
          status: SOLVER_STATUS.INVALID_QUERY,
          reason: 'solver-worker-cloned-query-identity-mismatch',
          backend: this.backend.id,
          backendVersion: this.backend.version,
          queryHash: null,
          lifecycle: { publishable: false },
        });
      }
      const expressions = [
        ...(Array.isArray(querySnapshot.constraints) ? querySnapshot.constraints : []),
        ...(querySnapshot.assertion ? [querySnapshot.assertion] : []),
      ];
      try {
        const collected = collectSymbols(expressions, {
          maxExprNodes: this.backend.maxExprNodes,
          maxExprDepth: this.backend.maxExprDepth,
        });
        symbols = collected.symbols;
      } catch {
        // The provider performs the authoritative query validation. Keeping an
        // empty witness set here makes any unexpected SAT model fail closed.
        symbols = [];
      }
    }

    if (!this.worker) {
      return createSolverResult({
        status: SOLVER_STATUS.PROVIDER_FAILURE,
        reason: this.initializationError?.message || 'solver-worker-unavailable',
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: querySnapshot?.queryHash || null,
        lifecycle: { publishable: false },
      });
    }
    if (signal?.aborted) {
      return createSolverResult({
        status: SOLVER_STATUS.CANCELLED,
        reason: 'solver-worker-aborted',
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: querySnapshot?.queryHash || null,
        lifecycle: { cancelled: true, publishable: false },
      });
    }

    const requestId = String(++this.requestSequence);
    const workerOptions = {
      maxBvWidth: options.maxBvWidth ?? this.options.maxBvWidth ?? this.backend.maxBvWidth,
      maxAssignments: options.maxAssignments ?? this.options.maxAssignments ?? this.backend.maxAssignments,
      maxConstraints: options.maxConstraints ?? this.options.maxConstraints ?? this.backend.maxConstraints,
      maxExprNodes: options.maxExprNodes ?? this.options.maxExprNodes ?? this.backend.maxExprNodes,
      maxExprDepth: options.maxExprDepth ?? this.options.maxExprDepth ?? this.backend.maxExprDepth,
      yieldEvery: options.yieldEvery ?? this.options.yieldEvery ?? this.backend.yieldEvery,
      timeoutMs: 0,
    };
    return new Promise((resolve) => {
      const pending = {
        resolve,
        token,
        queryHash: querySnapshot?.queryHash || null,
        query: querySnapshot,
        symbols,
        legacyEnvelope,
      };
      this.pending.set(requestId, pending);
      try {
        this.worker.postMessage({ type: 'solver-check', requestId, query: querySnapshot, options: workerOptions, token });
      } catch (error) {
        this.pending.delete(requestId);
        resolve(createSolverResult({
          status: SOLVER_STATUS.PROVIDER_FAILURE,
          reason: error?.message || 'solver-worker-post-failed',
          backend: this.backend.id,
          backendVersion: this.backend.version,
          queryHash: querySnapshot?.queryHash || null,
          lifecycle: { publishable: false },
        }));
      }
    });
  }

  _terminateWorker() {
    if (this.terminated) return;
    this.terminated = true;
    this.removeWorkerListeners?.();
    for (const pending of this.pending.values()) {
      pending.resolve(createSolverResult({
        status: SOLVER_STATUS.CANCELLED,
        reason: 'solver-worker-terminated',
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: pending.queryHash,
        lifecycle: { cancelled: true, disposed: true, late: true, publishable: false },
      }));
    }
    this.pending.clear();
    try { this.worker?.terminate?.(); } catch { /* idempotent best effort */ }
    this.worker = null;
  }

  async _onCancel() {
    try { this.worker?.postMessage?.({ type: 'solver-cancel' }); } catch { /* termination is authoritative */ }
    this._terminateWorker();
  }

  async _onStale() {
    // A stale request may still be computing inside the old worker. Terminate
    // that worker and create a fresh one before the replacement query starts.
    this._terminateWorker();
    if (this.state === 'active') this._createWorker();
  }

  async _onTimeout() {
    this._terminateWorker();
  }

  async _onDispose() {
    this._terminateWorker();
  }
}

export class WorkerSolverBackend extends SolverBackend {
  constructor({
    id = WORKER_BACKEND_ID,
    version = WORKER_BACKEND_VERSION,
    maxBvWidth = 8,
    maxAssignments = 1 << 20,
    maxConstraints = 4096,
    maxExprNodes = 100000,
    maxExprDepth = 1024,
    yieldEvery = 4096,
    workerFactory = defaultWorkerFactory,
  } = {}) {
    super({ id, version, proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: false, isWasm: false });
    this.maxBvWidth = positiveFiniteBudget(maxBvWidth, 8);
    this.maxAssignments = positiveFiniteBudget(maxAssignments, 1 << 20);
    this.maxConstraints = positiveFiniteBudget(maxConstraints, 4096);
    this.maxExprNodes = positiveFiniteBudget(maxExprNodes, 100000);
    this.maxExprDepth = positiveFiniteBudget(maxExprDepth, 1024);
    this.yieldEvery = positiveFiniteBudget(yieldEvery, 4096);
    this.workerFactory = workerFactory;
  }

  baseCapabilities() {
    return {
      ...new ExhaustiveBvBackend({
        maxBvWidth: this.maxBvWidth,
        maxAssignments: this.maxAssignments,
        maxConstraints: this.maxConstraints,
        maxExprNodes: this.maxExprNodes,
        maxExprDepth: this.maxExprDepth,
        yieldEvery: this.yieldEvery,
      }).baseCapabilities(),
      executionIsolation: 'dedicated-worker',
      memoryBudgetClass: 'measured-only',
    };
  }

  createSession(options = {}) {
    return new WorkerSolverSession(this, {
      maxBvWidth: this.maxBvWidth,
      maxAssignments: this.maxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      yieldEvery: this.yieldEvery,
      ...options,
    });
  }
}

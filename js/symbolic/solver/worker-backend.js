/**
 * Dedicated Worker transport for the browser-safe exhaustive exact backend.
 * The host owns the timeout and lifecycle; the worker is terminated on
 * timeout/cancel/dispose so a late provider result cannot re-enter Hex.
 */

import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { effectivePositiveSafeInteger, requirePositiveSafeInteger } from './limits.js';
import { ExhaustiveBvBackend } from './exhaustive-backend.js';
import { TieredBvBackend, classifyTieredQuery } from './tiered-backend.js';
import { validateVerificationQuery } from '../verify/query.js';
import { validateSatModel } from '../verify/validate-model.js';
import { validateExactModelBindings } from './model-boundary.js';
import { SOLVER_STATUS, createSolverResult, isValidSolverResult } from './result.js';
import { SolverSession } from './session.js';
import { isCanonicalRequestId, WORKER_BACKEND_ID, WORKER_BACKEND_VERSION } from './worker-protocol.js';

export { WORKER_BACKEND_ID, WORKER_BACKEND_VERSION } from './worker-protocol.js';

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
    } catch (error) {
      this.initializationError = error;
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
      if (message.token !== pending.token || !isValidSolverResult(message.result, {
        query: pending.query,
        backend: this.backend,
      })) {
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
        const binding = validateExactModelBindings(pending.symbols, message.result.model);
        const semantic = binding.valid ? validateSatModel(pending.query, message.result.model) : binding;
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
    if (!this.worker) {
      return createSolverResult({
        status: SOLVER_STATUS.PROVIDER_FAILURE,
        reason: this.initializationError?.message || 'solver-worker-unavailable',
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: query?.queryHash || null,
        lifecycle: { publishable: false },
      });
    }
    if (signal?.aborted) {
      return createSolverResult({
        status: SOLVER_STATUS.CANCELLED,
        reason: 'solver-worker-aborted',
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: query?.queryHash || null,
        lifecycle: { cancelled: true, publishable: false },
      });
    }

    const names = ['maxBvWidth', 'maxAssignments', 'exhaustiveMaxBvWidth', 'maxConstraints', 'maxExprNodes', 'maxExprDepth',
      'maxVariables', 'maxClauses', 'maxDecisions', 'maxPropagations', 'yieldEvery'];
    let workerOptions;
    try {
      workerOptions = Object.fromEntries(names.map((name) => [name,
        effectivePositiveSafeInteger(options, name, this.options[name], this.backend[name])]));
    } catch (error) {
      return createSolverResult({ status: SOLVER_STATUS.INVALID_QUERY,
        reason: `invalid-budget:${error.message}`, backend: this.backend.id, backendVersion: this.backend.version,
        queryHash: null, lifecycle: { publishable: false } });
    }
    workerOptions.exhaustiveMaxAssignments = workerOptions.maxAssignments;
    workerOptions.timeoutMs = 0;
    const queryValidation = validateVerificationQuery(query, { maxExprNodes: workerOptions.maxExprNodes, maxExprDepth: workerOptions.maxExprDepth });
    if (!queryValidation.valid) return createSolverResult({ status: queryValidation.limitExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY,
      reason: queryValidation.reason, backend: this.backend.id, backendVersion: this.backend.version,
      queryHash: null, lifecycle: { budgetExceeded: queryValidation.limitExceeded === true, publishable: false } });
    let querySnapshot;
    try { querySnapshot = structuredClone(query); }
    catch (error) { return createSolverResult({ status: SOLVER_STATUS.INVALID_QUERY,
      reason: `solver-worker-query-clone-failed:${error?.message || 'uncloneable-query'}`,
      backend: this.backend.id, backendVersion: this.backend.version, queryHash: null,
      lifecycle: { publishable: false } }); }
    const snapshotValidation = validateVerificationQuery(querySnapshot, {
      maxExprNodes: workerOptions.maxExprNodes, maxExprDepth: workerOptions.maxExprDepth,
    });
    if (!snapshotValidation.valid || snapshotValidation.recomputedHash !== queryValidation.recomputedHash) {
      return createSolverResult({ status: SOLVER_STATUS.INVALID_QUERY,
        reason: 'solver-worker-cloned-query-identity-mismatch', backend: this.backend.id,
        backendVersion: this.backend.version, queryHash: null, lifecycle: { publishable: false } });
    }
    const routeInfo = classifyTieredQuery(querySnapshot, {
      maxBvWidth: workerOptions.maxBvWidth,
      maxExprNodes: workerOptions.maxExprNodes,
      maxExprDepth: workerOptions.maxExprDepth,
      maxConstraints: workerOptions.maxConstraints,
      exhaustiveMaxBvWidth: workerOptions.exhaustiveMaxBvWidth,
      exhaustiveMaxAssignments: workerOptions.maxAssignments,
    });
    if (!routeInfo.supported) return createSolverResult({ status: routeInfo.status || SOLVER_STATUS.UNSUPPORTED,
      reason: routeInfo.reason, backend: this.backend.id, backendVersion: this.backend.version,
      queryHash: routeInfo.status === SOLVER_STATUS.INVALID_QUERY ? null : querySnapshot.queryHash,
      lifecycle: { budgetExceeded: routeInfo.status === SOLVER_STATUS.RESOURCE_LIMIT, publishable: false } });
    const requestId = String(++this.requestSequence);
    return new Promise((resolve) => {
      const pending = { resolve, token, query: querySnapshot, queryHash: querySnapshot.queryHash,
        symbols: routeInfo.analysis.symbols };
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
          queryHash: querySnapshot.queryHash,
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
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('worker backend options must be a data object');
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const captured = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable) {
        throw new TypeError('worker backend options must be enumerable own data');
      }
      captured[key] = descriptors[key].value;
    }
    const option = (name, fallback) => Object.hasOwn(captured, name) ? captured[name] : fallback;
    const id = option('id', WORKER_BACKEND_ID);
    const version = option('version', WORKER_BACKEND_VERSION);
    const workerFactory = option('workerFactory', defaultWorkerFactory);
    if (typeof workerFactory !== 'function') throw new TypeError('workerFactory must be a function');
    const maxBvWidth = requirePositiveSafeInteger(option('maxBvWidth', 8), 'maxBvWidth');
    const maxAssignments = requirePositiveSafeInteger(option('maxAssignments', 1 << 20), 'maxAssignments');
    const maxConstraints = requirePositiveSafeInteger(option('maxConstraints', 4096), 'maxConstraints');
    const maxExprNodes = requirePositiveSafeInteger(option('maxExprNodes', 100000), 'maxExprNodes');
    const maxExprDepth = requirePositiveSafeInteger(option('maxExprDepth', 1024), 'maxExprDepth');
    const maxClauses = requirePositiveSafeInteger(option('maxClauses', 1600000), 'maxClauses');
    const maxVariables = requirePositiveSafeInteger(option('maxVariables', 400000), 'maxVariables');
    const maxDecisions = requirePositiveSafeInteger(option('maxDecisions', 500000), 'maxDecisions');
    const maxPropagations = requirePositiveSafeInteger(option('maxPropagations', 8000000), 'maxPropagations');
    const yieldEvery = requirePositiveSafeInteger(option('yieldEvery', 8192), 'yieldEvery');
    const exhaustiveMaxBvWidth = requirePositiveSafeInteger(option('exhaustiveMaxBvWidth', Math.min(8, maxBvWidth)), 'exhaustiveMaxBvWidth');
    if (exhaustiveMaxBvWidth > maxBvWidth) throw new TypeError('exhaustiveMaxBvWidth cannot exceed maxBvWidth');
    super({ id, version, proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: false, isWasm: false });
    Object.assign(this, { maxBvWidth, maxAssignments, maxConstraints, maxExprNodes, maxExprDepth,
      maxClauses, maxVariables, maxDecisions, maxPropagations, yieldEvery, exhaustiveMaxBvWidth, workerFactory });
  }

  baseCapabilities() {
    const provider = this.maxBvWidth <= 8
      ? new ExhaustiveBvBackend({
          maxBvWidth: this.maxBvWidth,
          maxAssignments: this.maxAssignments,
          maxConstraints: this.maxConstraints,
          maxExprNodes: this.maxExprNodes,
          maxExprDepth: this.maxExprDepth,
          yieldEvery: this.yieldEvery,
        })
      : new TieredBvBackend({
          maxBvWidth: this.maxBvWidth,
          exhaustiveMaxAssignments: this.maxAssignments,
          maxConstraints: this.maxConstraints,
          maxExprNodes: this.maxExprNodes,
          maxExprDepth: this.maxExprDepth,
          maxVariables: this.maxVariables,
          maxClauses: this.maxClauses,
          maxDecisions: this.maxDecisions,
          maxPropagations: this.maxPropagations,
          yieldEvery: this.yieldEvery,
        });
    return {
      ...provider.baseCapabilities(),
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
      maxVariables: this.maxVariables,
      maxClauses: this.maxClauses,
      maxDecisions: this.maxDecisions,
      maxPropagations: this.maxPropagations,
      yieldEvery: this.yieldEvery,
      exhaustiveMaxBvWidth: this.exhaustiveMaxBvWidth,
      ...options,
    });
  }
}

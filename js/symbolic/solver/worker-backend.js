/**
 * Dedicated Worker transport for the browser-safe tiered exact backend.
 * The host owns the timeout and lifecycle; the worker is terminated on
 * timeout/cancel/dispose so a late provider result cannot re-enter Hex.
 */

import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { validateVerificationQuery } from '../verify/query.js';
import { validateSatModel } from '../verify/validate-model.js';
import { effectivePositiveSafeInteger, requirePositiveSafeInteger } from './limits.js';
import { validateExactModelBindings } from './model-boundary.js';
import { SOLVER_STATUS, createSolverResult, isValidSolverResult } from './result.js';
import { SolverSession } from './session.js';
import { TieredBvBackend, classifyTieredQuery } from './tiered-backend.js';

export const WORKER_BACKEND_ID = 'hex-tiered-qfbv-worker';
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
    } catch (error) {
      this.initializationError = error;
    }
  }

  _attachWorker(worker) {
    const onMessage = (event) => {
      const message = event?.data ?? event;
      if (!message || message.type !== 'solver-result') return;
      const pending = this.pending.get(String(message.requestId));
      if (!pending) return;
      this.pending.delete(String(message.requestId));
      if (message.token !== pending.token || !isValidSolverResult(message.result, {
        query: { queryHash: pending.queryHash },
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
        const bindingValidation = validateExactModelBindings(pending.symbols, message.result.model);
        const semanticValidation = bindingValidation.valid ? validateSatModel(pending.query, message.result.model) : bindingValidation;
        if (!semanticValidation.valid) {
          pending.resolve(createSolverResult({
            status: SOLVER_STATUS.PROVIDER_FAILURE,
            reason: `solver-worker-model-validation-failed:${semanticValidation.reason}`,
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
    let workerOptions;
    try {
      workerOptions = {
        maxBvWidth: effectivePositiveSafeInteger(options, 'maxBvWidth', this.options.maxBvWidth, this.backend.maxBvWidth),
        exhaustiveMaxBvWidth: effectivePositiveSafeInteger(options, 'exhaustiveMaxBvWidth', this.options.exhaustiveMaxBvWidth, this.backend.exhaustiveMaxBvWidth),
        exhaustiveMaxAssignments: effectivePositiveSafeInteger(options, 'exhaustiveMaxAssignments', this.options.exhaustiveMaxAssignments, this.backend.exhaustiveMaxAssignments),
        maxConstraints: effectivePositiveSafeInteger(options, 'maxConstraints', this.options.maxConstraints, this.backend.maxConstraints),
        maxExprNodes: effectivePositiveSafeInteger(options, 'maxExprNodes', this.options.maxExprNodes, this.backend.maxExprNodes),
        maxExprDepth: effectivePositiveSafeInteger(options, 'maxExprDepth', this.options.maxExprDepth, this.backend.maxExprDepth),
        maxVariables: effectivePositiveSafeInteger(options, 'maxVariables', this.options.maxVariables, this.backend.maxVariables),
        maxClauses: effectivePositiveSafeInteger(options, 'maxClauses', this.options.maxClauses, this.backend.maxClauses),
        maxDecisions: effectivePositiveSafeInteger(options, 'maxDecisions', this.options.maxDecisions, this.backend.maxDecisions),
        maxPropagations: effectivePositiveSafeInteger(options, 'maxPropagations', this.options.maxPropagations, this.backend.maxPropagations),
        yieldEvery: effectivePositiveSafeInteger(options, 'yieldEvery', this.options.yieldEvery, this.backend.yieldEvery),
        timeoutMs: 0,
      };
    } catch (error) {
      return createSolverResult({ status: SOLVER_STATUS.INVALID_QUERY, reason: `invalid-budget:${error.message}`, backend: this.backend.id, backendVersion: this.backend.version, queryHash: null, lifecycle: { publishable: false } });
    }
    const route = classifyTieredQuery(query, workerOptions);
    if (!route.supported) {
      return createSolverResult({
        status: route.status || SOLVER_STATUS.UNSUPPORTED,
        reason: route.reason,
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: query?.queryHash || null,
        lifecycle: { budgetExceeded: route.status === SOLVER_STATUS.RESOURCE_LIMIT, publishable: false },
      });
    }
    const queryValidation = validateVerificationQuery(query, { maxExprNodes: workerOptions.maxExprNodes });
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

    let querySnapshot;
    try {
      querySnapshot = structuredClone(query);
    } catch (error) {
      return createSolverResult({ status: SOLVER_STATUS.INVALID_QUERY, reason: `solver-worker-query-clone-failed:${error?.message || 'uncloneable-query'}`, backend: this.backend.id, backendVersion: this.backend.version, queryHash: null, lifecycle: { publishable: false } });
    }
    const clonedValidation = validateVerificationQuery(querySnapshot, { maxExprNodes: workerOptions.maxExprNodes });
    if (!clonedValidation.valid || clonedValidation.recomputedHash !== queryValidation.recomputedHash) {
      return createSolverResult({ status: SOLVER_STATUS.INVALID_QUERY, reason: 'solver-worker-cloned-query-identity-mismatch', backend: this.backend.id, backendVersion: this.backend.version, queryHash: null, lifecycle: { publishable: false } });
    }
    const requestId = String(++this.requestSequence);
    return new Promise((resolve) => {
      const pending = { resolve, token, queryHash: querySnapshot.queryHash, query: querySnapshot, symbols: route.collected.symbols };
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
          queryHash: query?.queryHash || null,
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
    const id = options.id ?? WORKER_BACKEND_ID;
    const version = options.version ?? WORKER_BACKEND_VERSION;
    const workerFactory = options.workerFactory ?? defaultWorkerFactory;
    super({ id, version, proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: false, isWasm: false, requiresCanonicalQueryIdentity: true });
    const value = (name, fallback) => Object.prototype.hasOwnProperty.call(options, name) ? options[name] : fallback;
    this.maxBvWidth = requirePositiveSafeInteger(value('maxBvWidth', 64), 'maxBvWidth');
    this.exhaustiveMaxBvWidth = requirePositiveSafeInteger(value('exhaustiveMaxBvWidth', 8), 'exhaustiveMaxBvWidth');
    this.exhaustiveMaxAssignments = requirePositiveSafeInteger(value('exhaustiveMaxAssignments', 1 << 20), 'exhaustiveMaxAssignments');
    this.maxConstraints = requirePositiveSafeInteger(value('maxConstraints', 4096), 'maxConstraints');
    this.maxExprNodes = requirePositiveSafeInteger(value('maxExprNodes', 100000), 'maxExprNodes');
    this.maxExprDepth = requirePositiveSafeInteger(value('maxExprDepth', 1024), 'maxExprDepth');
    this.maxVariables = requirePositiveSafeInteger(value('maxVariables', 400000), 'maxVariables');
    this.maxClauses = requirePositiveSafeInteger(value('maxClauses', 1600000), 'maxClauses');
    this.maxDecisions = requirePositiveSafeInteger(value('maxDecisions', 500000), 'maxDecisions');
    this.maxPropagations = requirePositiveSafeInteger(value('maxPropagations', 8000000), 'maxPropagations');
    this.yieldEvery = requirePositiveSafeInteger(value('yieldEvery', 8192), 'yieldEvery');
    if (this.exhaustiveMaxBvWidth > this.maxBvWidth) throw new TypeError('exhaustiveMaxBvWidth cannot exceed maxBvWidth');
    this.workerFactory = workerFactory;
  }

  baseCapabilities() {
    return {
      ...new TieredBvBackend({
        maxBvWidth: this.maxBvWidth,
        exhaustiveMaxBvWidth: this.exhaustiveMaxBvWidth,
        exhaustiveMaxAssignments: this.exhaustiveMaxAssignments,
        maxConstraints: this.maxConstraints,
        maxExprNodes: this.maxExprNodes,
        maxExprDepth: this.maxExprDepth,
        maxVariables: this.maxVariables,
        maxClauses: this.maxClauses,
        maxDecisions: this.maxDecisions,
        maxPropagations: this.maxPropagations,
        yieldEvery: this.yieldEvery,
      }).baseCapabilities(),
      executionIsolation: 'dedicated-worker',
      memoryBudgetClass: 'measured-only',
    };
  }

  createSession(options = {}) {
    return new WorkerSolverSession(this, {
      maxBvWidth: this.maxBvWidth,
      exhaustiveMaxBvWidth: this.exhaustiveMaxBvWidth,
      exhaustiveMaxAssignments: this.exhaustiveMaxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      maxVariables: this.maxVariables,
      maxClauses: this.maxClauses,
      maxDecisions: this.maxDecisions,
      maxPropagations: this.maxPropagations,
      yieldEvery: this.yieldEvery,
      ...options,
    });
  }
}

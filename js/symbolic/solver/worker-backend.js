/**
* Dedicated Worker transport for the browser-safe exact tiered backend.
* The host owns lifecycle and validates every identity crossing the worker boundary.
*/
import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { computeCanonicalQueryHash, validateVerificationQuery } from '../verify/query.js';
import { validateSatModel } from '../verify/validate-model.js';
import { effectivePositiveSafeInteger, requirePositiveSafeInteger } from './limits.js';
import { validateExactModelBindings } from './model-boundary.js';
import { analyzeSolverExpressions } from './query-analysis.js';
import { SOLVER_STATUS, createSolverResult, isValidSolverResult } from './result.js';
import { SolverSession } from './session.js';
import { TieredBvBackend, classifyTieredQuery } from './tiered-backend.js';
import { isCanonicalRequestId } from './worker-protocol.js';
// Keep the deployed public identity stable even though the implementation now
// routes narrow queries to the exhaustive oracle and wider QF_BV to bit-blast.
export const WORKER_BACKEND_ID = 'hex-exhaustive-bv-worker';
export const WORKER_BACKEND_VERSION = '1.0.0';
function defaultWorkerFactory() {
if (typeof globalThis.Worker !== 'function') throw new Error('solver-worker-unavailable');
return new globalThis.Worker(new URL('./worker-entry.js', import.meta.url), { type: 'module' });
}
function querySymbols(query, options) {
const expressions = [...query.constraints, ...(query.assertion ? [query.assertion] : [])];
return analyzeSolverExpressions(expressions, {
maxExprNodes: options.maxExprNodes,
maxExprDepth: options.maxExprDepth,
});
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
_failure(reason, queryHash = null) {
return createSolverResult({
status: SOLVER_STATUS.PROVIDER_FAILURE,
reason,
backend: this.backend.id,
backendVersion: this.backend.version,
queryHash,
lifecycle: { publishable: false },
});
}
_attachWorker(worker) {
const onMessage = (event) => {
const message = event?.data ?? event;
if (!message || message.type !== 'solver-result' || !isCanonicalRequestId(message.requestId)) return;
const pending = this.pending.get(message.requestId);
if (!pending) return;
this.pending.delete(message.requestId);
if (message.token !== pending.token || !isValidSolverResult(message.result, {
query: pending.query,
backend: this.backend,
})) {
pending.resolve(this._failure('solver-worker-result-identity-mismatch', pending.queryHash));
return;
}
if (message.result.status === SOLVER_STATUS.SAT) {
const binding = validateExactModelBindings(pending.symbols, message.result.model);
const semantic = binding.valid ? validateSatModel(pending.query, message.result.model) : binding;
if (!semantic.valid) {
pending.resolve(this._failure(`solver-worker-model-validation-failed:${semantic.reason}`, pending.queryHash));
return;
}
}
try {
pending.resolve(createSolverResult({ ...message.result, queryHash: pending.queryHash }));
} catch {
pending.resolve(this._failure('solver-worker-result-snapshot-failed', pending.queryHash));
}
};
const onError = (event) => {
const reason = event?.message || 'solver-worker-failure';
for (const pending of this.pending.values()) pending.resolve(this._failure(reason, pending.queryHash));
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
maxAssignments: effectivePositiveSafeInteger(options, 'maxAssignments', this.options.maxAssignments, this.backend.maxAssignments),
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
return createSolverResult({
status: SOLVER_STATUS.INVALID_QUERY,
reason: `invalid-budget:${error.message}`,
backend: this.backend.id,
backendVersion: this.backend.version,
queryHash: null,
lifecycle: { publishable: false },
});
}
const route = classifyTieredQuery(query, workerOptions);
if (!route.supported) {
return createSolverResult({
status: route.status || SOLVER_STATUS.UNSUPPORTED,
reason: route.reason,
backend: this.backend.id,
backendVersion: this.backend.version,
queryHash: route.status === SOLVER_STATUS.INVALID_QUERY ? null : query?.queryHash || null,
lifecycle: { budgetExceeded: route.status === SOLVER_STATUS.RESOURCE_LIMIT, publishable: false },
});
}
const validation = validateVerificationQuery(query, {
maxExprNodes: workerOptions.maxExprNodes,
maxExprDepth: workerOptions.maxExprDepth,
});
if (!validation.valid) {
return createSolverResult({
status: validation.limitExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY,
reason: validation.reason,
backend: this.backend.id,
backendVersion: this.backend.version,
queryHash: null,
lifecycle: { budgetExceeded: validation.limitExceeded === true, publishable: false },
});
}
const analysis = querySymbols(query, workerOptions);
if (analysis.limitExceeded || analysis.depthExceeded || analysis.unsupportedReason) {
const status = analysis.limitExceeded || analysis.depthExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.UNSUPPORTED;
return createSolverResult({
status,
reason: analysis.limitExceeded ? 'expression-node-budget-exceeded'
: analysis.depthExceeded ? 'expression-depth-budget-exceeded'
: analysis.unsupportedReason,
backend: this.backend.id,
backendVersion: this.backend.version,
queryHash: status === SOLVER_STATUS.UNSUPPORTED ? query.queryHash : query.queryHash,
lifecycle: { budgetExceeded: status === SOLVER_STATUS.RESOURCE_LIMIT, publishable: false },
});
}
if (!this.worker) return this._failure(this.initializationError?.message || 'solver-worker-unavailable', query.queryHash);
if (signal?.aborted) {
return createSolverResult({
status: SOLVER_STATUS.CANCELLED,
reason: 'solver-worker-aborted',
backend: this.backend.id,
backendVersion: this.backend.version,
queryHash: query.queryHash,
lifecycle: { cancelled: true, publishable: false },
});
}
let querySnapshot;
try { querySnapshot = structuredClone(query); }
catch (error) {
return createSolverResult({
status: SOLVER_STATUS.INVALID_QUERY,
reason: `solver-worker-query-clone-failed:${error?.message || 'uncloneable-query'}`,
backend: this.backend.id,
backendVersion: this.backend.version,
queryHash: null,
lifecycle: { publishable: false },
});
}
const clonedValidation = validateVerificationQuery(querySnapshot, {
maxExprNodes: workerOptions.maxExprNodes,
maxExprDepth: workerOptions.maxExprDepth,
});
let clonedHash = null;
let sourceHash = null;
if (clonedValidation.valid && validation.valid) {
try { clonedHash = computeCanonicalQueryHash(querySnapshot); sourceHash = computeCanonicalQueryHash(query); } catch { /* invalid below */ }
}
if (!clonedValidation.valid || clonedHash == null || clonedHash !== sourceHash) {
return createSolverResult({
status: SOLVER_STATUS.INVALID_QUERY,
reason: 'solver-worker-cloned-query-identity-mismatch',
backend: this.backend.id,
backendVersion: this.backend.version,
queryHash: null,
lifecycle: { publishable: false },
});
}
const requestId = String(++this.requestSequence);
return new Promise((resolve) => {
const pending = { resolve, token, queryHash: querySnapshot.queryHash, query: querySnapshot, symbols: analysis.symbols };
this.pending.set(requestId, pending);
try {
this.worker.postMessage({ type: 'solver-check', requestId, query: querySnapshot, options: workerOptions, token });
} catch (error) {
this.pending.delete(requestId);
resolve(this._failure(error?.message || 'solver-worker-post-failed', querySnapshot.queryHash));
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
try { this.worker?.terminate?.(); } catch { /* termination is authoritative */ }
this.worker = null;
}
async _onCancel() {
try { this.worker?.postMessage?.({ type: 'solver-cancel' }); } catch { /* termination is authoritative */ }
this._terminateWorker();
}
async _onStale() {
this._terminateWorker();
if (this.state === 'active') this._createWorker();
}
async _onTimeout() { this._terminateWorker(); }
async _onDispose() { this._terminateWorker(); }
}
export class WorkerSolverBackend extends SolverBackend {
constructor(options = {}) {
const value = (name, fallback) => Object.prototype.hasOwnProperty.call(options, name) ? options[name] : fallback;
const maxAssignments = value('exhaustiveMaxAssignments', value('maxAssignments', 1 << 20));
super({
id: options.id ?? WORKER_BACKEND_ID,
version: options.version ?? WORKER_BACKEND_VERSION,
proofAuthority: PROOF_AUTHORITY.EXACT,
isRemote: false,
isWasm: false,
requiresCanonicalQueryIdentity: true,
});
this.maxBvWidth = requirePositiveSafeInteger(value('maxBvWidth', 8), 'maxBvWidth');
this.exhaustiveMaxBvWidth = requirePositiveSafeInteger(value('exhaustiveMaxBvWidth', 8), 'exhaustiveMaxBvWidth');
this.exhaustiveMaxAssignments = requirePositiveSafeInteger(maxAssignments, 'exhaustiveMaxAssignments');
this.maxAssignments = this.exhaustiveMaxAssignments;
this.maxConstraints = requirePositiveSafeInteger(value('maxConstraints', 4096), 'maxConstraints');
this.maxExprNodes = requirePositiveSafeInteger(value('maxExprNodes', 100000), 'maxExprNodes');
this.maxExprDepth = requirePositiveSafeInteger(value('maxExprDepth', 1024), 'maxExprDepth');
this.maxVariables = requirePositiveSafeInteger(value('maxVariables', 400000), 'maxVariables');
this.maxClauses = requirePositiveSafeInteger(value('maxClauses', 1600000), 'maxClauses');
this.maxDecisions = requirePositiveSafeInteger(value('maxDecisions', 500000), 'maxDecisions');
this.maxPropagations = requirePositiveSafeInteger(value('maxPropagations', 8000000), 'maxPropagations');
this.yieldEvery = requirePositiveSafeInteger(value('yieldEvery', 8192), 'yieldEvery');
if (this.exhaustiveMaxBvWidth > this.maxBvWidth) throw new TypeError('exhaustiveMaxBvWidth cannot exceed maxBvWidth');
this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
}
baseCapabilities() {
const provider = new TieredBvBackend({
maxBvWidth: this.maxBvWidth,
exhaustiveMaxBvWidth: this.exhaustiveMaxBvWidth,
exhaustiveMaxAssignments: this.exhaustiveMaxAssignments,
maxAssignments: this.maxAssignments,
maxConstraints: this.maxConstraints,
maxExprNodes: this.maxExprNodes,
maxExprDepth: this.maxExprDepth,
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
exhaustiveMaxBvWidth: this.exhaustiveMaxBvWidth,
exhaustiveMaxAssignments: this.exhaustiveMaxAssignments,
maxAssignments: this.maxAssignments,
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

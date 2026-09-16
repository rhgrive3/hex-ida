/**
* js/symbolic/solver/result.js
*
* Strict 9-status taxonomy and validation for SolverResult.
* Ensures timeouts, resource limits, and unsupported features are never
* conflated with UNSAT or proved results.
*/
import { isVerificationQuery } from '../verify/query.js';
export const SOLVER_STATUS = Object.freeze({
SAT: 'sat',
UNSAT: 'unsat',
UNKNOWN: 'unknown',
TIMEOUT: 'timeout',
RESOURCE_LIMIT: 'resource-limit',
UNSUPPORTED: 'unsupported',
CANCELLED: 'cancelled',
PROVIDER_FAILURE: 'provider-failure',
INVALID_QUERY: 'invalid-query',
});
export function isSat(result) {
return result?.status === SOLVER_STATUS.SAT;
}
export function isUnsat(result) {
return result?.status === SOLVER_STATUS.UNSAT;
}
export function isSolverFailure(result) {
/*
* Fail closed (#5820): only the two success statuses of the strict 9-status
* taxonomy are not failures. An unknown truthy status (malformed backend
* result, provider-invented status, typo) must not pass as a success side;
* that matches isValidSolverResult(), which rejects unknown statuses too.
*/
const status = result?.status;
return status !== SOLVER_STATUS.SAT && status !== SOLVER_STATUS.UNSAT;
}
const MODEL_IMMUTABLE = 'SolverResult model is an immutable published snapshot';
class ImmutableSolverModelMap extends Map {
set() { throw new TypeError(MODEL_IMMUTABLE); }
delete() { throw new TypeError(MODEL_IMMUTABLE); }
clear() { throw new TypeError(MODEL_IMMUTABLE); }
}
function isPlainModelObject(value) {
const proto = Object.getPrototypeOf(value);
return proto === Object.prototype || proto === null;
}
const MAX_MODEL_DEPTH = 512;
const MAX_MODEL_NODES = 200_000;
class SolverModelLimitError extends Error {
constructor(code) {
super(`solver model exceeded ${code}`);
this.name = 'SolverModelLimitError';
this.limitCode = code;
}
}
function stackOverflowError(error) {
return error instanceof RangeError && /maximum call stack|stack size|call stack/i.test(String(error?.message));
}
function immutableModelValue(value, depth, counter, ancestors) {
if (value === null || typeof value !== 'object') return value;
if (depth > MAX_MODEL_DEPTH) throw new SolverModelLimitError('model-depth-limit');
counter.nodes += 1;
if (counter.nodes > MAX_MODEL_NODES) throw new SolverModelLimitError('model-node-limit');
if (ancestors.has(value)) throw new TypeError('provider-model-cycle');
ancestors.add(value);
try {
if (value instanceof Map) {
const copy = new ImmutableSolverModelMap();
for (const [key, entryValue] of value) {
if (key !== null && typeof key === 'object') throw new TypeError('provider-model-object-map-key');
Map.prototype.set.call(copy, key, immutableModelValue(entryValue, depth + 1, counter, ancestors));
}
return Object.freeze(copy);
}
if (Array.isArray(value)) {
const copy = [];
for (const element of value) copy.push(immutableModelValue(element, depth + 1, counter, ancestors));
return Object.freeze(copy);
}
if (isPlainModelObject(value)) {
const copy = {};
for (const key of Object.keys(value)) {
Object.defineProperty(copy, key, {
value: immutableModelValue(value[key], depth + 1, counter, ancestors),
enumerable: true,
writable: false,
configurable: false,
});
}
return Object.freeze(copy);
}
throw new TypeError('provider-model-unsupported-object');
} finally {
ancestors.delete(value);
}
}
function normalizeSolverModel(model) {
try {
return { ok: true, value: immutableModelValue(model, 0, { nodes: 0 }, new WeakSet()) };
} catch (error) {
if (error instanceof SolverModelLimitError || stackOverflowError(error)) {
return { ok: false, reason: error instanceof SolverModelLimitError ? error.limitCode : 'model-stack-limit' };
}
throw error;
}
}
function readonlyMap(entries) {
const target = new Map(entries);
Object.freeze(target);
let snapshot;
snapshot = new Proxy(target, {
get(map, property) {
if (property === 'set' || property === 'delete' || property === 'clear') {
return () => { throw new TypeError('SolverResult snapshot map is read-only'); };
}
if (property === 'forEach') {
return (callback, thisArg) => map.forEach((value, key) => callback.call(thisArg, value, key, snapshot));
}
const value = Reflect.get(map, property, map);
return typeof value === 'function' ? value.bind(map) : value;
},
set() { return false; },
defineProperty() { return false; },
deleteProperty() { return false; },
});
return Object.freeze(snapshot);
}
function immutableSnapshot(value, path = new WeakSet(), depth = 0) {
if (value == null || typeof value !== 'object') return value;
if (depth > 256) throw new TypeError('createSolverResult: nested content exceeds immutable snapshot depth');
if (path.has(value)) throw new TypeError('createSolverResult: cyclic nested content');
path.add(value);
let snapshot;
if (value instanceof Map) {
snapshot = readonlyMap([...value].map(([key, child]) => [
immutableSnapshot(key, path, depth + 1),
immutableSnapshot(child, path, depth + 1),
]));
} else if (value instanceof Set) {
snapshot = Object.freeze([...value].map((child) => immutableSnapshot(child, path, depth + 1)));
} else if (ArrayBuffer.isView(value)) {
snapshot = Object.freeze(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
} else if (value instanceof ArrayBuffer) {
snapshot = Object.freeze(Array.from(new Uint8Array(value)));
} else if (value instanceof Date) {
snapshot = Object.freeze({ iso: value.toISOString() });
} else if (Array.isArray(value)) {
snapshot = Object.freeze(value.map((child) => immutableSnapshot(child, path, depth + 1)));
} else {
snapshot = {};
for (const key of Object.keys(value)) {
Object.defineProperty(snapshot, key, {
value: immutableSnapshot(value[key], path, depth + 1),
enumerable: true,
configurable: false,
writable: false,
});
}
Object.freeze(snapshot);
}
path.delete(value);
return snapshot;
}
/** Return a structured-clone-safe mutable envelope for Worker transport. */
export function solverResultToTransport(result) {
const copy = (value, path = new WeakSet()) => {
if (value == null || typeof value !== 'object') return value;
if (path.has(value)) throw new TypeError('solverResultToTransport: cyclic content');
path.add(value);
let output;
if (value instanceof Map) output = new Map([...value].map(([key, child]) => [copy(key, path), copy(child, path)]));
else if (Array.isArray(value)) output = value.map((child) => copy(child, path));
else {
output = {};
for (const key of Object.keys(value)) output[key] = copy(value[key], path);
}
path.delete(value);
return output;
};
return copy(result);
}
function requireIdentityString(value, field) {
// Exact typed identity (#4685): a solver result's backend/backendVersion must be
// primitive strings. Storing String(structuredValue) laundered ['exact-solver']
// into 'exact-solver', so a malformed provider result could satisfy exact
// backend identity. Reject instead of coercing.
if (typeof value !== 'string' || value.length === 0) {
throw new TypeError(`createSolverResult: ${field} must be a non-empty primitive string`);
}
return value;
}
function requireQueryHash(value) {
if (value == null || value === '') return null;
if (typeof value !== 'string') {
throw new TypeError('createSolverResult: queryHash must be null or a primitive string');
}
return value;
}
export function createSolverResult({
status,
model = null,
reason = null,
stats = {},
backend = 'unknown',
backendVersion = '0.0.0',
queryHash = null,
lifecycle = {},
}) {
if (!Object.values(SOLVER_STATUS).includes(status)) {
throw new TypeError(`createSolverResult: invalid solver status '${status}'`);
}
const normalizedBackend = requireIdentityString(backend, 'backend');
const normalizedBackendVersion = requireIdentityString(backendVersion, 'backendVersion');
const normalizedQueryHash = requireQueryHash(queryHash);
// Model is only permitted when status is SAT; publish an owned immutable snapshot (#3986).
// Provider-controlled model canonicalization is itself a bounded authority
// boundary (#8975): over-deep/over-wide models are RESOURCE_LIMIT, never SAT.
let modelLimitReason = null;
let normalizedModel = null;
if (status === SOLVER_STATUS.SAT && model && typeof model === 'object') {
const normalized = normalizeSolverModel(model);
if (normalized.ok) normalizedModel = normalized.value;
else {
modelLimitReason = normalized.reason;
status = SOLVER_STATUS.RESOURCE_LIMIT;
}
}
const normalizedLifecycle = Object.freeze({
timedOut: lifecycle?.timedOut === true,
cancelled: lifecycle?.cancelled === true,
stale: lifecycle?.stale === true,
disposed: lifecycle?.disposed === true,
budgetExceeded: lifecycle?.budgetExceeded === true || modelLimitReason != null,
late: lifecycle?.late === true,
publishable: (status === SOLVER_STATUS.SAT || status === SOLVER_STATUS.UNSAT) &&
lifecycle?.publishable !== false &&
lifecycle?.timedOut !== true &&
lifecycle?.cancelled !== true &&
lifecycle?.stale !== true &&
lifecycle?.disposed !== true &&
lifecycle?.budgetExceeded !== true &&
modelLimitReason == null,
});
return Object.freeze({
status,
model: normalizedModel,
reason: reason ? String(reason) : (modelLimitReason ? `provider-model-${modelLimitReason}` : null),
stats: immutableSnapshot({
...stats,
solveTimeMs: Number(stats.solveTimeMs) || 0,
nodesEvaluated: Number(stats.nodesEvaluated) || 0,
memoryBytesDelta: Number(stats.memoryBytesDelta) || 0,
}),
backend: normalizedBackend,
backendVersion: normalizedBackendVersion,
queryHash: normalizedQueryHash,
lifecycle: normalizedLifecycle,
});
}
export function isValidSolverResult(result, { query = null, backend = null } = {}) {
if (!result || typeof result !== 'object' || !Object.values(SOLVER_STATUS).includes(result.status)) return false;
if (backend) {
// Compare exact typed identity; never String()-coerce either side (#4685).
if (typeof result.backend !== 'string' || typeof result.backendVersion !== 'string') return false;
if (result.backend !== backend.id || result.backendVersion !== backend.version) return false;
}
if (query?.queryHash) {
// Query identity is verified against recomputed canonical content, not an
// echoed caller string, so copying one forged hash into query and result
// cannot validate (#3963). Identity is compared as a primitive string only (#4685).
if (!isVerificationQuery(query)) return false;
if (typeof query.queryHash !== 'string' || result.queryHash !== query.queryHash) return false;
}
if (result.lifecycle?.publishable === false && (result.status === SOLVER_STATUS.SAT || result.status === SOLVER_STATUS.UNSAT)) return false;
if (result.status !== SOLVER_STATUS.SAT && result.model != null) return false;
return true;
}

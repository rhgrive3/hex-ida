/**
 * js/symbolic/solver/result.js
 *
 * Strict 9-status taxonomy and validation for SolverResult.
 * Ensures timeouts, resource limits, and unsupported features are never
 * conflated with UNSAT or proved results.
 */

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
  if (!result || !result.status) return true;
  return (
    result.status === SOLVER_STATUS.UNKNOWN ||
    result.status === SOLVER_STATUS.TIMEOUT ||
    result.status === SOLVER_STATUS.RESOURCE_LIMIT ||
    result.status === SOLVER_STATUS.UNSUPPORTED ||
    result.status === SOLVER_STATUS.CANCELLED ||
    result.status === SOLVER_STATUS.PROVIDER_FAILURE ||
    result.status === SOLVER_STATUS.INVALID_QUERY
  );
}

function readonlyMap(entries) {
  const target = new Map(entries);
  Object.freeze(target);
  let snapshot;
  snapshot = new Proxy(target, {
    get(map, property) {
      if (property === 'set' || property === 'delete' || property === 'clear') {
        return () => { throw new TypeError('SolverResult model is read-only'); };
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

  // Model is only permitted when status is SAT
  let normalizedModel = null;
  if (status === SOLVER_STATUS.SAT && model) {
    if (model instanceof Map || typeof model === 'object') normalizedModel = immutableSnapshot(model);
  }

  const normalizedLifecycle = Object.freeze({
    timedOut: lifecycle?.timedOut === true,
    cancelled: lifecycle?.cancelled === true,
    stale: lifecycle?.stale === true,
    disposed: lifecycle?.disposed === true,
    budgetExceeded: lifecycle?.budgetExceeded === true,
    late: lifecycle?.late === true,
    publishable: (status === SOLVER_STATUS.SAT || status === SOLVER_STATUS.UNSAT) &&
      lifecycle?.publishable !== false &&
      lifecycle?.timedOut !== true &&
      lifecycle?.cancelled !== true &&
      lifecycle?.stale !== true &&
      lifecycle?.disposed !== true &&
      lifecycle?.budgetExceeded !== true,
  });

  return Object.freeze({
    status,
    model: normalizedModel,
    reason: reason ? String(reason) : null,
    stats: immutableSnapshot({
      ...stats,
      solveTimeMs: Number(stats.solveTimeMs) || 0,
      nodesEvaluated: Number(stats.nodesEvaluated) || 0,
      memoryBytesDelta: Number(stats.memoryBytesDelta) || 0,
    }),
    backend: String(backend),
    backendVersion: String(backendVersion),
    queryHash: queryHash ? String(queryHash) : null,
    lifecycle: normalizedLifecycle,
  });
}

export function isValidSolverResult(result, { query = null, backend = null } = {}) {
  if (!result || typeof result !== 'object' || !Object.values(SOLVER_STATUS).includes(result.status)) return false;
  if (backend) {
    if (result.backend !== String(backend.id) || result.backendVersion !== String(backend.version)) return false;
  }
  if (query?.queryHash && result.queryHash !== String(query.queryHash)) return false;
  if (result.lifecycle?.publishable === false && (result.status === SOLVER_STATUS.SAT || result.status === SOLVER_STATUS.UNSAT)) return false;
  if (result.status !== SOLVER_STATUS.SAT && result.model != null) return false;
  return true;
}

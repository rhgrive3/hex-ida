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

function immutableModelValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map) {
    const copy = new ImmutableSolverModelMap();
    for (const [key, entryValue] of value) Map.prototype.set.call(copy, key, immutableModelValue(entryValue));
    return Object.freeze(copy);
  }
  if (Array.isArray(value)) return Object.freeze(value.map(immutableModelValue));
  if (isPlainModelObject(value)) {
    const copy = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        value: immutableModelValue(value[key]),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(copy);
  }
  return Object.freeze(value);
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

  // Model is only permitted when status is SAT; publish an owned immutable snapshot (#3986)
  let normalizedModel = null;
  if (status === SOLVER_STATUS.SAT && model && typeof model === 'object') {
    normalizedModel = immutableModelValue(model);
  }

  const normalizedLifecycle = Object.freeze({
    timedOut: lifecycle?.timedOut === true,
    cancelled: lifecycle?.cancelled === true,
    stale: lifecycle?.stale === true,
    disposed: lifecycle?.disposed === true,
    budgetExceeded: lifecycle?.budgetExceeded === true,
    late: lifecycle?.late === true,
    publishable: lifecycle?.publishable !== false &&
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
    stats: Object.freeze({
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

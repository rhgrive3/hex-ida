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

function requireIdentityString(value, field) {
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

  // Model is only permitted when status is SAT
  let normalizedModel = null;
  if (status === SOLVER_STATUS.SAT && model) {
    if (model instanceof Map) {
      normalizedModel = new Map(model);
    } else if (typeof model === 'object') {
      normalizedModel = { ...model };
    }
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
    backend: normalizedBackend,
    backendVersion: normalizedBackendVersion,
    queryHash: normalizedQueryHash,
    lifecycle: normalizedLifecycle,
  });
}

export function isValidSolverResult(result, { query = null, backend = null } = {}) {
  if (!result || typeof result !== 'object' || !Object.values(SOLVER_STATUS).includes(result.status)) return false;
  if (backend) {
    if (typeof result.backend !== 'string' || typeof result.backendVersion !== 'string') return false;
    if (result.backend !== backend.id || result.backendVersion !== backend.version) return false;
  }
  if (query?.queryHash) {
    if (typeof query.queryHash !== 'string' || result.queryHash !== query.queryHash) return false;
  }
  if (result.lifecycle?.publishable === false && (result.status === SOLVER_STATUS.SAT || result.status === SOLVER_STATUS.UNSAT)) return false;
  if (result.status !== SOLVER_STATUS.SAT && result.model != null) return false;
  return true;
}

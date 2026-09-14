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

// A provider-controlled SAT model is canonicalized (recursively deep-copied and
// frozen) before it is published. That canonicalization is itself a work
// boundary: an attacker-supplied model can be deep enough to overflow the
// stack or wide enough to exhaust the heap during the copy, before any
// authoritative boundary rejects it (#8975). Legitimate models from the
// exhaustive backend are flat symbol→scalar assignments (depth ≤ 2), so these
// budgets sit far above any real result and far below the reporter's
// demonstrated crash points.
const MAX_MODEL_DEPTH = 512;
const MAX_MODEL_NODES = 200_000;

class SolverModelLimitError extends Error {
  constructor(code) {
    super(`solver model exceeded ${code}`);
    this.name = 'SolverModelLimitError';
    this.limitCode = code;
  }
}

function stackOverflowError(err) {
  return err instanceof RangeError && /maximum call stack|stack size|call stack/i.test(String(err && err.message));
}

function immutableModelValue(value, depth, counter) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_MODEL_DEPTH) throw new SolverModelLimitError('model-depth-limit');
  counter.nodes += 1;
  if (counter.nodes > MAX_MODEL_NODES) throw new SolverModelLimitError('model-node-limit');
  if (value instanceof Map) {
    const copy = new ImmutableSolverModelMap();
    for (const [key, entryValue] of value) Map.prototype.set.call(copy, key, immutableModelValue(entryValue, depth + 1, counter));
    return Object.freeze(copy);
  }
  if (Array.isArray(value)) return Object.freeze(value.map((element) => immutableModelValue(element, depth + 1, counter)));
  if (isPlainModelObject(value)) {
    const copy = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        value: immutableModelValue(value[key], depth + 1, counter),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(copy);
  }
  return Object.freeze(value);
}

function normalizeSolverModel(model) {
  try {
    return { ok: true, value: immutableModelValue(model, 0, { nodes: 0 }) };
  } catch (err) {
    // Exceeding an explicit budget, or overflowing the stack during an
    // un-budgeted copy, is a resource exhaustion at the canonicalization
    // boundary — never a proved SAT answer. Fail closed to a resource-limit
    // result instead of throwing out of createSolverResult (#8975).
    if (err instanceof SolverModelLimitError || stackOverflowError(err)) {
      return { ok: false, reason: err instanceof SolverModelLimitError ? err.limitCode : 'model-stack-limit' };
    }
    // A structurally hostile model (throwing getter, proxy trap) is a provider
    // failure; let it propagate so the caller can resolve the lifecycle rather
    // than strand it.
    throw err;
  }
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

  // Model is only permitted when status is SAT; publish an owned immutable snapshot (#3986).
  // A provider model whose canonicalization would exceed the depth/node budget is not a
  // proved answer — demote it to a deterministic RESOURCE_LIMIT result instead of throwing
  // out of the canonicalization boundary (#8975).
  let modelLimitReason = null;
  let normalizedModel = null;
  if (status === SOLVER_STATUS.SAT && model && typeof model === 'object') {
    const normalized = normalizeSolverModel(model);
    if (normalized.ok) {
      normalizedModel = normalized.value;
    } else {
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
    publishable: lifecycle?.publishable !== false &&
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
  if (query?.queryHash) {
    // Query identity is verified against recomputed canonical content, not an
    // echoed caller string, so copying one forged hash into query and result
    // cannot validate (#3963).
    if (!isVerificationQuery(query)) return false;
    if (result.queryHash !== String(query.queryHash)) return false;
  }
  if (result.lifecycle?.publishable === false && (result.status === SOLVER_STATUS.SAT || result.status === SOLVER_STATUS.UNSAT)) return false;
  if (result.status !== SOLVER_STATUS.SAT && result.model != null) return false;
  return true;
}

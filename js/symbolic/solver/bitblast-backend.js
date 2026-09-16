/** Exact dependency-free QF_BV backend using Tseitin CNF + deterministic DPLL. */
import { SORT_KIND } from '../expr/kinds.js';
import { validateSatModel } from '../verify/validate-model.js';
import { validateVerificationQuery } from '../verify/query.js';
import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { CnfBuilder } from './bitblast-cnf.js';
import { deadlineFrom, LimitError, monotonicNow } from './bitblast-cnf-base.js';
import { extractModel, solveCnf } from './bitblast-dpll.js';
import { effectivePositiveSafeInteger, requirePositiveSafeInteger } from './limits.js';
import { validateExactModelBindings } from './model-boundary.js';
import { analyzeSolverExpressions } from './query-analysis.js';
import { SOLVER_STATUS, createSolverResult } from './result.js';
import { SolverSession } from './session.js';

export const BITBLAST_BACKEND_ID = 'hex-bitblast-qfbv';
export const BITBLAST_BACKEND_VERSION = '1.0.0';

const DEFAULT_LIMITS = Object.freeze({
  maxBvWidth: 64,
  maxConstraints: 4096,
  maxExprNodes: 100000,
  maxExprDepth: 1024,
  maxVariables: 400000,
  maxClauses: 1600000,
  maxDecisions: 500000,
  maxPropagations: 8000000,
  yieldEvery: 8192,
});

class BitBlastSolverSession extends SolverSession {
  async _executeCheck(query, options = {}, _token, signal) {
    const startedAt = monotonicNow();
    const resultBase = { backend: this.backend.id, backendVersion: this.backend.version, queryHash: query?.queryHash || null };
    let limits;
    try {
      limits = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((name) => [
        name,
        effectivePositiveSafeInteger(options, name, this.options[name], this.backend[name]),
      ]));
    } catch (error) {
      return createSolverResult({ ...resultBase, queryHash: null, status: SOLVER_STATUS.INVALID_QUERY, reason: `invalid-budget:${error.message}`, lifecycle: { publishable: false } });
    }
    const queryValidation = validateVerificationQuery(query, { maxExprNodes: limits.maxExprNodes });
    if (!queryValidation.valid) {
      return createSolverResult({
        ...resultBase,
        queryHash: null,
        status: queryValidation.limitExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY,
        reason: queryValidation.reason,
        lifecycle: { budgetExceeded: queryValidation.limitExceeded === true, publishable: false },
      });
    }
    const constraints = query.constraints;
    const expressions = [...constraints, ...(query.assertion ? [query.assertion] : [])];
    if (constraints.length > limits.maxConstraints) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'constraint-budget-exceeded', lifecycle: { budgetExceeded: true, publishable: false } });
    }
    const collected = analyzeSolverExpressions(expressions, {
      maxExprNodes: limits.maxExprNodes,
      maxExprDepth: limits.maxExprDepth,
    });
    if (collected.limitExceeded) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'expression-node-budget-exceeded', lifecycle: { budgetExceeded: true, publishable: false } });
    }
    if (collected.depthExceeded) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'expression-depth-budget-exceeded', lifecycle: { budgetExceeded: true, publishable: false } });
    }
    if (collected.unsupportedReason) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.UNSUPPORTED, reason: collected.unsupportedReason, lifecycle: { publishable: false } });
    }
    if (constraints.some((constraint) => constraint?.sort?.kind !== SORT_KIND.BOOL) ||
        (query.assertion && query.assertion.sort?.kind !== SORT_KIND.BOOL)) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.UNSUPPORTED, reason: 'non-boolean-query-predicate', lifecycle: { publishable: false } });
    }
    if (collected.maxBvWidth > limits.maxBvWidth) {
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.UNSUPPORTED, reason: `bitvector-width-exceeds-${limits.maxBvWidth}`, lifecycle: { publishable: false } });
    }

    const deadline = deadlineFrom(options);
    let builder;
    try {
      builder = new CnfBuilder(limits, signal, deadline);
      for (const predicate of expressions) builder.addClause([builder.compile(predicate).literal]);
    } catch (error) {
      if (!(error instanceof LimitError)) throw error;
      const status = error.reason === 'cancelled' ? SOLVER_STATUS.CANCELLED
        : error.reason === 'timeout' ? SOLVER_STATUS.TIMEOUT
          : error.reason.startsWith('unsupported-') ? SOLVER_STATUS.UNSUPPORTED
            : SOLVER_STATUS.RESOURCE_LIMIT;
      return createSolverResult({
        ...resultBase,
        status,
        reason: error.reason,
        stats: { solveTimeMs: monotonicNow() - startedAt },
        lifecycle: { cancelled: status === SOLVER_STATUS.CANCELLED, timedOut: status === SOLVER_STATUS.TIMEOUT, budgetExceeded: status === SOLVER_STATUS.RESOURCE_LIMIT, publishable: false },
      });
    }

    const solved = await solveCnf(builder, { signal, deadline, limits });
    const stats = {
      solveTimeMs: monotonicNow() - startedAt,
      nodesEvaluated: solved.decisions,
      cnfVariables: builder.variableCount,
      cnfClauses: builder.clauses.length,
      decisions: solved.decisions,
      propagations: solved.propagations,
      engine: 'tseitin-cnf+dpll',
    };
    if (solved.status === 'sat') {
      const model = extractModel(collected.symbols, builder, solved.assignment);
      const bindingValidation = validateExactModelBindings(collected.symbols, model);
      if (!bindingValidation.valid) {
        return createSolverResult({ ...resultBase, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: `exact-model-binding-validation-failed:${bindingValidation.reason}`, stats, lifecycle: { publishable: false } });
      }
      const validation = validateSatModel(query, model);
      if (!validation.valid) {
        return createSolverResult({ ...resultBase, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: `independent-model-validation-failed:${validation.reason}`, stats, lifecycle: { publishable: false } });
      }
      return createSolverResult({ ...resultBase, status: SOLVER_STATUS.SAT, model, stats });
    }
    if (solved.status === 'unsat') return createSolverResult({ ...resultBase, status: SOLVER_STATUS.UNSAT, stats });
    const status = solved.status === 'cancelled' ? SOLVER_STATUS.CANCELLED
      : solved.status === 'timeout' ? SOLVER_STATUS.TIMEOUT
        : SOLVER_STATUS.RESOURCE_LIMIT;
    return createSolverResult({
      ...resultBase,
      status,
      reason: solved.status,
      stats,
      lifecycle: { cancelled: status === SOLVER_STATUS.CANCELLED, timedOut: status === SOLVER_STATUS.TIMEOUT, budgetExceeded: status === SOLVER_STATUS.RESOURCE_LIMIT, publishable: false },
    });
  }
}

export class BitBlastBvBackend extends SolverBackend {
  constructor(options = {}) {
    super({
      id: options.id || BITBLAST_BACKEND_ID,
      version: options.version || BITBLAST_BACKEND_VERSION,
      proofAuthority: PROOF_AUTHORITY.EXACT,
      isRemote: false,
      isWasm: false,
      requiresCanonicalQueryIdentity: true,
    });
    for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
      this[key] = requirePositiveSafeInteger(
        Object.prototype.hasOwnProperty.call(options, key) ? options[key] : fallback,
        key,
      );
    }
  }

  baseCapabilities() {
    return {
      ...super.baseCapabilities(),
      supportedSorts: ['bool', 'bv'],
      supportedLogic: 'QF_BV',
      maxBvWidth: this.maxBvWidth,
      supportsIncremental: false,
      supportsCancellation: true,
      supportsModelExtraction: true,
      sessionReuseAfterTimeout: false,
      exactProofs: true,
      executionIsolation: 'caller-selected',
      memoryBudgetClass: 'measured-only',
      algorithm: 'bitblast-tseitin-dpll',
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      maxVariables: this.maxVariables,
      maxClauses: this.maxClauses,
      maxDecisions: this.maxDecisions,
      maxPropagations: this.maxPropagations,
    };
  }

  createSession(options = {}) {
    return new BitBlastSolverSession(this, {
      ...Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((key) => [key, this[key]])),
      ...options,
    });
  }
}

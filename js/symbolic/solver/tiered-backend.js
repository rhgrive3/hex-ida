/** Exact QF_BV router: exhaustive oracle for small domains, bit-blast otherwise. */
import { SORT_KIND } from '../expr/kinds.js';
import { validateVerificationQuery } from '../verify/query.js';
import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { BitBlastBvBackend } from './bitblast-backend.js';
import { ExhaustiveBvBackend } from './exhaustive-backend.js';
import { requirePositiveSafeInteger } from './limits.js';
import { analyzeSolverExpressions } from './query-analysis.js';
import { SOLVER_STATUS, createSolverResult } from './result.js';
import { SolverSession } from './session.js';

export const TIERED_BACKEND_ID = 'hex-tiered-qfbv';
export const TIERED_BACKEND_VERSION = '1.0.0';

function domainSize(symbols, ceiling) {
  let size = 1n;
  const max = BigInt(ceiling);
  for (const symbol of symbols) {
    size *= symbol.sort.kind === SORT_KIND.BOOL ? 2n : 1n << BigInt(symbol.sort.width);
    if (size > max) break;
  }
  return size;
}

export function classifyTieredQuery(query, options = {}) {
  const maxBvWidth = options.maxBvWidth ?? 64;
  const maxExprNodes = options.maxExprNodes ?? 100000;
  const maxExprDepth = options.maxExprDepth ?? 1024;
  const maxConstraints = options.maxConstraints ?? 4096;
  const exhaustiveMaxBvWidth = options.exhaustiveMaxBvWidth ?? 8;
  const exhaustiveMaxAssignments = options.exhaustiveMaxAssignments ?? (1 << 20);
  try {
    for (const [name, value] of Object.entries({ maxBvWidth, maxExprNodes, maxExprDepth, maxConstraints, exhaustiveMaxBvWidth, exhaustiveMaxAssignments })) {
      requirePositiveSafeInteger(value, name);
    }
  } catch (error) {
    return Object.freeze({ supported: false, status: SOLVER_STATUS.INVALID_QUERY, reason: `invalid-budget:${error.message}`, tier: null });
  }
  const validation = validateVerificationQuery(query, { maxExprNodes, maxExprDepth });
  if (!validation.valid) return Object.freeze({ supported: false, status: validation.limitExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY, reason: validation.reason, tier: null });
  if (query.constraints.length > maxConstraints) return Object.freeze({ supported: false, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'constraint-budget-exceeded', tier: null });
  const expressions = [...query.constraints, ...(query.assertion ? [query.assertion] : [])];
  const analysis = analyzeSolverExpressions(expressions, { maxExprNodes, maxExprDepth });
  if (analysis.limitExceeded || analysis.depthExceeded) return Object.freeze({ supported: false, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: analysis.limitExceeded ? 'expression-node-budget-exceeded' : 'expression-depth-budget-exceeded', tier: null });
  if (analysis.unsupportedReason) return Object.freeze({ supported: false, status: SOLVER_STATUS.UNSUPPORTED, reason: analysis.unsupportedReason, tier: null });
  if (analysis.maxBvWidth > maxBvWidth) return Object.freeze({ supported: false, status: SOLVER_STATUS.UNSUPPORTED, reason: `bitvector-width-exceeds-${maxBvWidth}`, tier: null });
  const size = domainSize(analysis.symbols, exhaustiveMaxAssignments);
  const exhaustive = analysis.maxBvWidth <= exhaustiveMaxBvWidth && size <= BigInt(exhaustiveMaxAssignments);
  return Object.freeze({ supported: true, tier: exhaustive ? 'exhaustive-oracle' : 'bitblast-qfbv', reason: exhaustive ? 'bounded-domain-within-exhaustive-oracle' : 'wide-or-large-domain-qfbv', maxBvWidth: analysis.maxBvWidth, exhaustiveDomainSize: size.toString() });
}

function rebindResult(result, backend, tier) {
  return createSolverResult({
    status: result.status,
    model: result.model,
    reason: result.reason,
    stats: { ...(result.stats || {}), tier, routedBackend: result.backend },
    backend: backend.id,
    backendVersion: backend.version,
    queryHash: result.queryHash,
    lifecycle: result.lifecycle,
  });
}

class TieredSolverSession extends SolverSession {
  async _executeCheck(query, options = {}, _token, signal) {
    const maxBvWidth = Math.min(options.maxBvWidth ?? this.backend.maxBvWidth, this.backend.maxBvWidth);
    const maxExprNodes = Math.min(options.maxExprNodes ?? this.backend.maxExprNodes, this.backend.maxExprNodes);
    const maxExprDepth = Math.min(options.maxExprDepth ?? this.backend.maxExprDepth, this.backend.maxExprDepth);
    const maxConstraints = Math.min(options.maxConstraints ?? this.backend.maxConstraints, this.backend.maxConstraints);
    const exhaustiveMaxBvWidth = Math.min(options.exhaustiveMaxBvWidth ?? this.backend.exhaustiveMaxBvWidth, this.backend.exhaustiveMaxBvWidth);
    const exhaustiveMaxAssignments = Math.min(options.exhaustiveMaxAssignments ?? this.backend.exhaustiveMaxAssignments, this.backend.exhaustiveMaxAssignments);
    const route = classifyTieredQuery(query, { maxBvWidth, maxExprNodes, maxExprDepth, maxConstraints, exhaustiveMaxBvWidth, exhaustiveMaxAssignments });
    if (!route.supported) return createSolverResult({
      status: route.status || SOLVER_STATUS.UNSUPPORTED,
      reason: route.reason,
      backend: this.backend.id,
      backendVersion: this.backend.version,
      queryHash: route.status === SOLVER_STATUS.INVALID_QUERY ? null : query?.queryHash || null,
      lifecycle: { budgetExceeded: route.status === SOLVER_STATUS.RESOURCE_LIMIT, publishable: false },
    });
    const child = route.tier === 'exhaustive-oracle' ? this.backend.exhaustiveBackend : this.backend.bitblastBackend;
    const session = child.createSession({ timeoutMs: 0 });
    try {
      const childOptions = { ...options, signal, timeoutMs: 0, maxBvWidth, maxExprNodes, maxConstraints };
      if (route.tier === 'exhaustive-oracle') childOptions.maxAssignments = exhaustiveMaxAssignments;
      else childOptions.maxExprDepth = maxExprDepth;
      const result = await session.check(query, childOptions);
      return rebindResult(result, this.backend, route.tier);
    } finally {
      await session.dispose();
    }
  }
}

export class TieredBvBackend extends SolverBackend {
  constructor(options = {}) {
    super({ id: options.id || TIERED_BACKEND_ID, version: options.version || TIERED_BACKEND_VERSION, proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: false, isWasm: false });
    this.maxBvWidth = requirePositiveSafeInteger(options.maxBvWidth ?? 64, 'maxBvWidth');
    this.maxConstraints = requirePositiveSafeInteger(options.maxConstraints ?? 4096, 'maxConstraints');
    this.maxExprNodes = requirePositiveSafeInteger(options.maxExprNodes ?? 100000, 'maxExprNodes');
    this.maxExprDepth = requirePositiveSafeInteger(options.maxExprDepth ?? 1024, 'maxExprDepth');
    this.exhaustiveMaxBvWidth = requirePositiveSafeInteger(options.exhaustiveMaxBvWidth ?? 8, 'exhaustiveMaxBvWidth');
    this.exhaustiveMaxAssignments = requirePositiveSafeInteger(options.exhaustiveMaxAssignments ?? (1 << 20), 'exhaustiveMaxAssignments');
    this.exhaustiveBackend = options.exhaustiveBackend || new ExhaustiveBvBackend({ maxBvWidth: this.exhaustiveMaxBvWidth, maxAssignments: this.exhaustiveMaxAssignments, maxConstraints: this.maxConstraints, maxExprNodes: this.maxExprNodes });
    this.bitblastBackend = options.bitblastBackend || new BitBlastBvBackend({ maxBvWidth: this.maxBvWidth, maxConstraints: this.maxConstraints, maxExprNodes: this.maxExprNodes, maxExprDepth: this.maxExprDepth });
  }
  baseCapabilities() {
    return { ...super.baseCapabilities(), supportedSorts: ['bool', 'bv'], supportedLogic: 'QF_BV', maxBvWidth: this.maxBvWidth,
      supportsIncremental: false, supportsCancellation: true, supportsModelExtraction: true, sessionReuseAfterTimeout: false,
      exactProofs: true, executionIsolation: 'caller-selected', memoryBudgetClass: 'measured-only', algorithm: 'tiered-exhaustive+bitblast',
      maxAssignments: this.exhaustiveMaxAssignments, maxConstraints: this.maxConstraints, maxExprNodes: this.maxExprNodes, maxExprDepth: this.maxExprDepth };
  }
  createSession(options = {}) { return new TieredSolverSession(this, options); }
}

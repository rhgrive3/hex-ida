/**
 * Production exact QF_BV capability router for HEX-SYM-01.
 *
 * <=8-bit feasible finite domains retain the existing exhaustive backend as an
 * exact floor. Wider/larger QF_BV queries route to the exact bit-blast backend.
 * Where both exact providers are eligible, their proof status must agree.
 */

import { stableDigest } from '../../core/identity/index.js';
import { SORT_KIND } from '../expr/kinds.js';
import { validateSatModel } from '../verify/validate-model.js';
import { validateVerificationQuery } from '../verify/query.js';
import { isExactProofBackend, PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { BitBlastBvBackend } from './bitblast-backend.js';
import { collectSymbols, ExhaustiveBvBackend } from './exhaustive-backend.js';
import { effectivePositiveSafeInteger, requirePositiveSafeInteger } from './limits.js';
import { validateExactModelBindings } from './model-boundary.js';
import { SOLVER_STATUS, createSolverResult, isValidSolverResult } from './result.js';
import { SolverSession } from './session.js';

export const TIERED_BACKEND_ID = 'hex-tiered-qfbv';
export const TIERED_BACKEND_VERSION = '1.0.0';

function monotonicNow() {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

function queryExpressions(query) {
  return [
    ...(Array.isArray(query?.constraints) ? query.constraints : []),
    ...(query?.assertion ? [query.assertion] : []),
  ];
}

function exhaustiveDomainSize(symbols, limit) {
  let size = 1n;
  const ceiling = BigInt(limit);
  for (const symbol of symbols) {
    size *= symbol.sort.kind === SORT_KIND.BOOL ? 2n : 1n << BigInt(symbol.sort.width);
    if (size > ceiling) return size;
  }
  return size;
}

function isDefinite(result) {
  return result?.status === SOLVER_STATUS.SAT || result?.status === SOLVER_STATUS.UNSAT;
}

function snapshotContract(backend, role) {
  if (!isExactProofBackend(backend)) {
    throw new TypeError(`${role} backend must satisfy the branded exact-proof contract`);
  }
  const capabilities = backend.capabilities();
  const maxBvWidth = requirePositiveSafeInteger(capabilities.maxBvWidth, `${role}.maxBvWidth`);
  const optionalLimit = (name) => Object.prototype.hasOwnProperty.call(capabilities, name)
    ? requirePositiveSafeInteger(capabilities[name], `${role}.${name}`)
    : null;
  const snapshot = Object.freeze({
    role,
    backend,
    id: backend.id,
    version: backend.version,
    fingerprint: backend.capabilityFingerprint(),
    capabilitiesDigest: stableDigest(capabilities),
    createSession: backend.createSession,
    capabilitiesMethod: backend.capabilities,
    fingerprintMethod: backend.capabilityFingerprint,
    maxBvWidth,
    maxAssignments: optionalLimit('maxAssignments'),
    maxConstraints: optionalLimit('maxConstraints'),
    maxExprNodes: optionalLimit('maxExprNodes'),
    maxExprDepth: optionalLimit('maxExprDepth'),
  });
  if (!Array.isArray(capabilities.supportedSorts) ||
      !capabilities.supportedSorts.includes(SORT_KIND.BOOL) ||
      !capabilities.supportedSorts.includes(SORT_KIND.BV)) {
    throw new TypeError(`${role} backend must support Bool and BV`);
  }
  return snapshot;
}

function contractStillMatches(contract) {
  try {
    const backend = contract.backend;
    return isExactProofBackend(backend) &&
      backend.id === contract.id &&
      backend.version === contract.version &&
      backend.createSession === contract.createSession &&
      backend.capabilities === contract.capabilitiesMethod &&
      backend.capabilityFingerprint === contract.fingerprintMethod &&
      backend.capabilityFingerprint() === contract.fingerprint &&
      stableDigest(backend.capabilities()) === contract.capabilitiesDigest;
  } catch {
    return false;
  }
}

function backendEligibility(contract, query, route) {
  if (!contractStillMatches(contract)) return { eligible: false, reason: 'provider-contract-changed' };
  if (route.maxBvWidth > contract.maxBvWidth) return { eligible: false, reason: `bitvector-width-exceeds-${contract.maxBvWidth}` };
  if (contract.maxConstraints != null && query.constraints.length > contract.maxConstraints) {
    return { eligible: false, reason: 'constraint-budget-exceeded' };
  }
  if (contract.maxExprNodes != null && route.collected.nodeCount > contract.maxExprNodes) {
    return { eligible: false, reason: 'expression-node-budget-exceeded' };
  }
  if (contract.maxExprDepth != null && route.collected.maxDepth > contract.maxExprDepth) {
    return { eligible: false, reason: 'expression-depth-budget-exceeded' };
  }
  if (contract.maxAssignments != null &&
      exhaustiveDomainSize(route.collected.symbols, contract.maxAssignments) > BigInt(contract.maxAssignments)) {
    return { eligible: false, reason: 'assignment-budget-exceeded' };
  }
  return { eligible: true, reason: 'capability-contract-matches-query' };
}

export function classifyTieredQuery(query, options = {}) {
  const value = (name, fallback) => Object.prototype.hasOwnProperty.call(options, name) ? options[name] : fallback;
  let exhaustiveMaxBvWidth;
  let exhaustiveMaxAssignments;
  let maxBvWidth;
  let maxExprNodes;
  let maxExprDepth;
  let maxConstraints;
  try {
    exhaustiveMaxBvWidth = requirePositiveSafeInteger(value('exhaustiveMaxBvWidth', 8), 'exhaustiveMaxBvWidth');
    exhaustiveMaxAssignments = requirePositiveSafeInteger(value('exhaustiveMaxAssignments', 1 << 20), 'exhaustiveMaxAssignments');
    maxBvWidth = requirePositiveSafeInteger(value('maxBvWidth', 64), 'maxBvWidth');
    maxExprNodes = requirePositiveSafeInteger(value('maxExprNodes', 100000), 'maxExprNodes');
    maxExprDepth = requirePositiveSafeInteger(value('maxExprDepth', 1024), 'maxExprDepth');
    maxConstraints = requirePositiveSafeInteger(value('maxConstraints', 4096), 'maxConstraints');
  } catch (error) {
    return Object.freeze({ supported: false, status: SOLVER_STATUS.INVALID_QUERY, reason: `invalid-budget:${error.message}`, tier: null });
  }
  if (exhaustiveMaxBvWidth > maxBvWidth) {
    return Object.freeze({ supported: false, status: SOLVER_STATUS.INVALID_QUERY, reason: 'exhaustive-width-exceeds-tiered-width', tier: null });
  }
  const validation = validateVerificationQuery(query, { maxExprNodes });
  if (!validation.valid) {
    return Object.freeze({
      supported: false,
      status: validation.limitExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY,
      reason: validation.reason,
      tier: null,
    });
  }
  if (query.constraints.length > maxConstraints) {
    return Object.freeze({ supported: false, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'constraint-budget-exceeded', tier: null });
  }
  const collected = collectSymbols(queryExpressions(query), { maxExprNodes, maxExprDepth });
  if (collected.limitExceeded) return Object.freeze({ supported: false, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'expression-node-budget-exceeded', tier: null, collected });
  if (collected.depthExceeded) return Object.freeze({ supported: false, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'expression-depth-budget-exceeded', tier: null, collected });
  if (collected.unsupportedReason) return Object.freeze({ supported: false, status: SOLVER_STATUS.UNSUPPORTED, reason: collected.unsupportedReason, tier: null, collected });
  if (collected.maxBvWidth > maxBvWidth) {
    return Object.freeze({ supported: false, status: SOLVER_STATUS.UNSUPPORTED, reason: `bitvector-width-exceeds-${maxBvWidth}`, tier: null, collected });
  }
  const domainSize = exhaustiveDomainSize(collected.symbols, exhaustiveMaxAssignments);
  const narrow = collected.maxBvWidth <= exhaustiveMaxBvWidth && domainSize <= BigInt(exhaustiveMaxAssignments);
  return Object.freeze({
    supported: true,
    tier: narrow ? 'exhaustive-oracle' : 'bitblast-qfbv',
    reason: narrow ? 'bounded-domain-within-exhaustive-oracle' : 'wide-or-large-domain-qfbv',
    maxBvWidth: collected.maxBvWidth,
    exhaustiveDomainSize: domainSize.toString(),
    collected,
  });
}

class TieredSolverSession extends SolverSession {
  async _executeCheck(query, options = {}, _token, signal) {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs;
    const deadline = typeof timeoutMs === 'number' && timeoutMs > 0 ? monotonicNow() + timeoutMs : Infinity;
    let limits;
    try {
      limits = {
        maxBvWidth: effectivePositiveSafeInteger(options, 'maxBvWidth', this.options.maxBvWidth, this.backend.maxBvWidth),
        exhaustiveMaxBvWidth: effectivePositiveSafeInteger(options, 'exhaustiveMaxBvWidth', this.options.exhaustiveMaxBvWidth, this.backend.exhaustiveMaxBvWidth),
        exhaustiveMaxAssignments: effectivePositiveSafeInteger(options, 'exhaustiveMaxAssignments', this.options.exhaustiveMaxAssignments, this.backend.exhaustiveMaxAssignments),
        maxConstraints: effectivePositiveSafeInteger(options, 'maxConstraints', this.options.maxConstraints, this.backend.maxConstraints),
        maxExprNodes: effectivePositiveSafeInteger(options, 'maxExprNodes', this.options.maxExprNodes, this.backend.maxExprNodes),
        maxExprDepth: effectivePositiveSafeInteger(options, 'maxExprDepth', this.options.maxExprDepth, this.backend.maxExprDepth),
        yieldEvery: effectivePositiveSafeInteger(options, 'yieldEvery', this.options.yieldEvery, this.backend.yieldEvery),
      };
    } catch (error) {
      return createSolverResult({ status: SOLVER_STATUS.INVALID_QUERY, reason: `invalid-budget:${error.message}`, backend: this.backend.id, backendVersion: this.backend.version, queryHash: null, lifecycle: { publishable: false } });
    }
    const route = classifyTieredQuery(query, limits);
    const base = { backend: this.backend.id, backendVersion: this.backend.version, queryHash: route.supported ? query.queryHash : null };
    if (!route.supported) {
      return createSolverResult({
        ...base,
        status: route.status || SOLVER_STATUS.UNSUPPORTED,
        reason: route.reason,
        stats: { solveTimeMs: Date.now() - startedAt, routingTier: 'unsupported' },
        lifecycle: { budgetExceeded: route.status === SOLVER_STATUS.RESOURCE_LIMIT, publishable: false },
      });
    }
    const configured = [this.backend.narrowContract, this.backend.wideContract];
    const eligibility = configured.map((contract) => Object.freeze({ contract, ...backendEligibility(contract, query, route) }));
    const candidates = eligibility.filter((item) => item.eligible);
    if (candidates.length === 0) {
      return createSolverResult({ ...base, status: SOLVER_STATUS.UNSUPPORTED, reason: 'no-configured-exact-tier-capability-overlap', lifecycle: { publishable: false } });
    }

    const attempts = [];
    const results = [];
    for (const candidate of candidates) {
      const contract = candidate.contract;
      if (signal?.aborted) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.CANCELLED, reason: 'tiered-query-aborted', lifecycle: { cancelled: true, publishable: false }, stats: { attempts } });
      }
      const remainingMs = deadline === Infinity ? 0 : Math.floor(deadline - monotonicNow());
      if (deadline !== Infinity && remainingMs <= 0) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.TIMEOUT, reason: 'tiered-deadline-exceeded', lifecycle: { timedOut: true, publishable: false }, stats: { attempts } });
      }
      if (!contractStillMatches(contract)) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: `tier-provider-contract-mismatch:${contract.role}`, lifecycle: { publishable: false }, stats: { attempts } });
      }
      let child;
      let result;
      try {
        child = contract.createSession.call(contract.backend, { ...options, timeoutMs: remainingMs });
        if (!contractStillMatches(contract)) throw new Error('provider-contract-changed-after-session-create');
        const childOptions = {
          ...options,
          signal,
          timeoutMs: remainingMs,
          maxBvWidth: Math.min(limits.maxBvWidth, contract.maxBvWidth),
          maxConstraints: limits.maxConstraints,
          maxExprNodes: limits.maxExprNodes,
          maxExprDepth: limits.maxExprDepth,
          yieldEvery: limits.yieldEvery,
        };
        if (contract.maxAssignments != null) {
          childOptions.maxAssignments = Math.min(limits.exhaustiveMaxAssignments, contract.maxAssignments);
        }
        result = await child.check(query, childOptions);
      } catch (error) {
        result = createSolverResult({
          status: SOLVER_STATUS.PROVIDER_FAILURE,
          reason: `tier-provider-unavailable:${error?.message || 'provider-failure'}`,
          backend: contract.id,
          backendVersion: contract.version,
          queryHash: query.queryHash,
          lifecycle: { publishable: false },
        });
      } finally {
        try { await child?.dispose(); } catch { /* child result fails closed below if contract changed */ }
      }
      attempts.push(Object.freeze({ backend: contract.id, status: result?.status || 'invalid' }));
      if (!contractStillMatches(contract)) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: `tier-provider-contract-mismatch:${contract.role}`, lifecycle: { publishable: false }, stats: { attempts } });
      }
      const proofResult = isDefinite(result);
      if (!isValidSolverResult(result, { backend: { id: contract.id, version: contract.version } }) ||
          (proofResult && !isValidSolverResult(result, { query, backend: { id: contract.id, version: contract.version } })) ||
          (result?.queryHash != null && result.queryHash !== query.queryHash)) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: 'tier-returned-malformed-or-misbound-result', lifecycle: { publishable: false }, stats: { attempts } });
      }
      if (result.status === SOLVER_STATUS.SAT) {
        const bindings = validateExactModelBindings(route.collected.symbols, result.model);
        const semantic = bindings.valid ? validateSatModel(query, result.model) : bindings;
        if (!semantic.valid) {
          return createSolverResult({ ...base, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: `tier-model-validation-failed:${semantic.reason}`, lifecycle: { publishable: false }, stats: { attempts } });
        }
      }
      results.push(result);
      if (result.status === SOLVER_STATUS.CANCELLED || signal?.aborted) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.CANCELLED, reason: result.reason || 'tiered-query-aborted', lifecycle: { cancelled: true, publishable: false }, stats: { attempts } });
      }
      if (result.status === SOLVER_STATUS.TIMEOUT) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.TIMEOUT, reason: result.reason || 'tiered-deadline-exceeded', lifecycle: { timedOut: true, publishable: false }, stats: { attempts } });
      }
    }

    const definite = results.filter(isDefinite);
    if (candidates.length > 1) {
      if (definite.length !== candidates.length) {
        const unavailable = results.find((result) => !isDefinite(result));
        return createSolverResult({
          ...base,
          status: unavailable?.status || SOLVER_STATUS.PROVIDER_FAILURE,
          reason: `exact-tier-agreement-unavailable:${unavailable?.reason || 'missing-definite-result'}`,
          lifecycle: { ...(unavailable?.lifecycle || {}), publishable: false },
          stats: { attempts, agreementPolicy: 'all-overlapping-exact-tiers-v1' },
        });
      }
      if (new Set(definite.map((result) => result.status)).size !== 1) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: 'exact-tier-semantic-disagreement', lifecycle: { publishable: false }, stats: { attempts, agreementPolicy: 'all-overlapping-exact-tiers-v1' } });
      }
    }
    const selected = definite[0] || results[results.length - 1];
    const proofResult = isDefinite(selected);
    if (proofResult && deadline !== Infinity && monotonicNow() >= deadline) {
      return createSolverResult({ ...base, status: SOLVER_STATUS.TIMEOUT, reason: 'tiered-deadline-exceeded-before-publication', lifecycle: { timedOut: true, publishable: false }, stats: { attempts } });
    }
    if (proofResult && candidates.some((candidate) => !contractStillMatches(candidate.contract))) {
      return createSolverResult({ ...base, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: 'tier-provider-contract-mismatch-before-publication', lifecycle: { publishable: false }, stats: { attempts } });
    }
    return createSolverResult({
      ...selected,
      ...base,
      stats: {
        ...selected.stats,
        solveTimeMs: Date.now() - startedAt,
        routingTier: route.tier,
        routingReason: route.reason,
        exhaustiveDomainSize: route.exhaustiveDomainSize,
        engineBackend: proofResult ? selected.backend : null,
        attempts,
        agreementPolicy: candidates.length > 1 ? 'all-overlapping-exact-tiers-v1' : 'single-capability-route-v1',
      },
      lifecycle: { ...selected.lifecycle, publishable: proofResult && selected.lifecycle?.publishable !== false },
    });
  }
}

export class TieredBvBackend extends SolverBackend {
  constructor(options = {}) {
    const {
      id = TIERED_BACKEND_ID,
      version = TIERED_BACKEND_VERSION,
      narrowBackend = null,
      wideBackend = null,
      ...wideOptions
    } = options;
    super({ id, version, proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: false, isWasm: false, requiresCanonicalQueryIdentity: true });
    const value = (name, fallback) => Object.prototype.hasOwnProperty.call(options, name) ? options[name] : fallback;
    this.maxBvWidth = requirePositiveSafeInteger(value('maxBvWidth', 64), 'maxBvWidth');
    this.exhaustiveMaxBvWidth = requirePositiveSafeInteger(value('exhaustiveMaxBvWidth', 8), 'exhaustiveMaxBvWidth');
    this.exhaustiveMaxAssignments = requirePositiveSafeInteger(value('exhaustiveMaxAssignments', 1 << 20), 'exhaustiveMaxAssignments');
    this.maxConstraints = requirePositiveSafeInteger(value('maxConstraints', 4096), 'maxConstraints');
    this.maxExprNodes = requirePositiveSafeInteger(value('maxExprNodes', 100000), 'maxExprNodes');
    this.maxExprDepth = requirePositiveSafeInteger(value('maxExprDepth', 1024), 'maxExprDepth');
    this.yieldEvery = requirePositiveSafeInteger(value('yieldEvery', 4096), 'yieldEvery');
    if (this.exhaustiveMaxBvWidth > this.maxBvWidth) throw new TypeError('exhaustiveMaxBvWidth cannot exceed maxBvWidth');

    const forwarded = { ...wideOptions };
    for (const name of ['maxBvWidth', 'exhaustiveMaxBvWidth', 'exhaustiveMaxAssignments', 'maxConstraints', 'maxExprNodes', 'maxExprDepth', 'yieldEvery']) delete forwarded[name];
    this.narrowBackend = narrowBackend || new ExhaustiveBvBackend({
      maxBvWidth: this.exhaustiveMaxBvWidth,
      maxAssignments: this.exhaustiveMaxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      yieldEvery: this.yieldEvery,
    });
    this.wideBackend = wideBackend || new BitBlastBvBackend({
      maxBvWidth: this.maxBvWidth,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      yieldEvery: this.yieldEvery,
      ...forwarded,
    });
    Object.defineProperties(this, {
      narrowContract: { value: snapshotContract(this.narrowBackend, 'narrow'), enumerable: true },
      wideContract: { value: snapshotContract(this.wideBackend, 'wide'), enumerable: true },
    });
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
      routingPolicy: 'exhaustive-oracle-then-bitblast-v1',
      overlapAgreementPolicy: 'all-overlapping-exact-tiers-v1',
      exhaustiveMaxBvWidth: this.exhaustiveMaxBvWidth,
      exhaustiveMaxAssignments: this.exhaustiveMaxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      yieldEvery: this.yieldEvery,
      narrowBackendFingerprint: this.narrowContract.fingerprint,
      wideBackendFingerprint: this.wideContract.fingerprint,
    };
  }

  createSession(options = {}) {
    return new TieredSolverSession(this, {
      maxBvWidth: this.maxBvWidth,
      exhaustiveMaxBvWidth: this.exhaustiveMaxBvWidth,
      exhaustiveMaxAssignments: this.exhaustiveMaxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      yieldEvery: this.yieldEvery,
      ...options,
    });
  }
}

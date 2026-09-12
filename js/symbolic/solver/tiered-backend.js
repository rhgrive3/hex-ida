/**
 * Production QF_BV capability router.
 *
 * The exhaustive finite-domain backend remains the exact oracle for feasible
 * <=8-bit queries. Wider or larger-domain queries are routed to the exact
 * bit-blast backend. No heuristic backend participates in this proof path.
 */

import { SORT_KIND } from '../expr/kinds.js';
import { validateSatModel } from '../verify/validate-model.js';
import { validateVerificationQuery } from '../verify/query.js';
import { isSolverBackendInstance, PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { BitBlastBvBackend } from './bitblast-backend.js';
import { collectSymbols, ExhaustiveBvBackend } from './exhaustive-backend.js';
import { effectivePositiveSafeInteger, requirePositiveSafeInteger } from './limits.js';
import { validateExactModelBindings } from './model-boundary.js';
import { SOLVER_STATUS, createSolverResult, isValidSolverResult } from './result.js';
import { SolverSession } from './session.js';

export const TIERED_BACKEND_ID = 'hex-tiered-qfbv';
export const TIERED_BACKEND_VERSION = '1.0.0';

function queryExpressions(query) {
  return [...(Array.isArray(query?.constraints) ? query.constraints : []), ...(query?.assertion ? [query.assertion] : [])];
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

function monotonicNow() {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

function canonicalPlainSnapshot(value, label, path = new WeakSet(), depth = 0) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} contains a non-safe-integer number`);
    return value;
  }
  if (typeof value !== 'object' || depth > 64) throw new TypeError(`${label} is not bounded canonical plain data`);
  if (path.has(value)) throw new TypeError(`${label} contains cyclic data`);
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (isArray ? Array.prototype : Object.prototype)) throw new TypeError(`${label} contains non-plain data`);
  path.add(value);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { throw new TypeError(`${label} cannot be descriptor-snapshotted`); }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) throw new TypeError(`${label} contains symbol keys`);
  let snapshot;
  if (isArray) {
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
      throw new TypeError(`${label} has an invalid array length`);
    }
    const elementKeys = keys.filter((key) => key !== 'length');
    if (elementKeys.length !== lengthDescriptor.value) throw new TypeError(`${label} contains array holes or extra properties`);
    snapshot = new Array(lengthDescriptor.value);
    for (let index = 0; index < lengthDescriptor.value; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError(`${label} contains accessors, holes, or non-enumerable elements`);
      }
      snapshot[index] = canonicalPlainSnapshot(descriptor.value, label, path, depth + 1);
    }
  } else {
    snapshot = {};
    for (const key of keys.sort()) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError(`${label} contains accessors or non-enumerable properties`);
      }
      Object.defineProperty(snapshot, key, {
        value: canonicalPlainSnapshot(descriptor.value, label, path, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
  }
  path.delete(value);
  return Object.freeze(snapshot);
}

function canonicalCapabilitySnapshot(value, label) {
  const snapshot = canonicalPlainSnapshot(value, label);
  try { structuredClone(value); }
  catch { throw new TypeError(`${label} contains proxy or non-cloneable data`); }
  if (!snapshot || Array.isArray(snapshot)) throw new TypeError(`${label} must be a plain object`);
  const supportedSorts = snapshot.supportedSorts;
  if (!Array.isArray(supportedSorts) || supportedSorts.length === 0 ||
      supportedSorts.some((sort) => sort !== SORT_KIND.BOOL && sort !== SORT_KIND.BV) ||
      new Set(supportedSorts).size !== supportedSorts.length) {
    throw new TypeError(`${label} has invalid or duplicate supported sorts`);
  }
  return Object.freeze({ ...snapshot, supportedSorts: Object.freeze([...supportedSorts].sort()) });
}

function snapshotProviderIdentity(backend, label) {
  if (!isSolverBackendInstance(backend)) throw new TypeError(`${label} backend must be a branded SolverBackend instance, not a proxy`);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(backend); }
  catch { throw new TypeError(`${label} backend identity cannot be descriptor-snapshotted`); }
  const value = (name) => {
    const descriptor = descriptors[name];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new TypeError(`${label}.${name} must be an own data property`);
    return descriptor.value;
  };
  const id = value('id');
  const version = value('version');
  const proofAuthority = value('proofAuthority');
  if (typeof id !== 'string' || !id || typeof version !== 'string' || !version || proofAuthority !== PROOF_AUTHORITY.EXACT) {
    throw new TypeError(`${label} backend must have an exact immutable identity contract`);
  }
  return Object.freeze({ id, version, proofAuthority });
}

function resolveDataMethod(value, name, label) {
  let cursor = value;
  while (cursor != null) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new TypeError(`${label}.${name} must be a data method`);
      }
      return descriptor.value;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new TypeError(`${label}.${name} must be a data method`);
}

function sameCanonicalData(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => sameCanonicalData(left[key], right[key]));
}

function validatedProviderState(backend, label, expectedMethods = null) {
  const identity = snapshotProviderIdentity(backend, label);
  const methods = Object.freeze({
    capabilities: resolveDataMethod(backend, 'capabilities', label),
    capabilityFingerprint: resolveDataMethod(backend, 'capabilityFingerprint', label),
    createSession: resolveDataMethod(backend, 'createSession', label),
  });
  if (expectedMethods && Object.keys(methods).some((name) => methods[name] !== expectedMethods[name])) {
    throw new TypeError(`${label} backend methods changed`);
  }
  const capabilities = canonicalCapabilitySnapshot(methods.capabilities.call(backend), `${label}.capabilities`);
  const fingerprint = methods.capabilityFingerprint.call(backend);
  const reboundIdentity = snapshotProviderIdentity(backend, label);
  if (capabilities.proofAuthority !== PROOF_AUTHORITY.EXACT || capabilities.exactProofs !== true ||
      capabilities.supportsModelExtraction !== true || typeof fingerprint !== 'string' || !fingerprint ||
      capabilities.capabilityFingerprint !== fingerprint ||
      reboundIdentity.id !== identity.id || reboundIdentity.version !== identity.version || reboundIdentity.proofAuthority !== identity.proofAuthority ||
      typeof capabilities.maxBvWidth !== 'number' || !Number.isSafeInteger(capabilities.maxBvWidth) || capabilities.maxBvWidth <= 0) {
    throw new TypeError(`${label} backend has an invalid capability contract`);
  }
  return Object.freeze({ identity, methods, capabilities, fingerprint });
}

function captureCapabilityContract(backend, label) {
  const state = validatedProviderState(backend, label);
  const { capabilities } = state;
  const optionalLimit = (name) => {
    if (!Object.prototype.hasOwnProperty.call(capabilities, name)) return null;
    return requirePositiveSafeInteger(capabilities[name], `${label}.${name}`);
  };
  return Object.freeze({
    role: label,
    backend,
    providerId: state.identity.id,
    providerVersion: state.identity.version,
    proofAuthority: state.identity.proofAuthority,
    methods: state.methods,
    fingerprint: state.fingerprint,
    capabilities,
    supportedSorts: capabilities.supportedSorts,
    maxBvWidth: capabilities.maxBvWidth,
    maxAssignments: optionalLimit('maxAssignments'),
    maxConstraints: optionalLimit('maxConstraints'),
    maxExprNodes: optionalLimit('maxExprNodes'),
    maxExprDepth: optionalLimit('maxExprDepth'),
  });
}

function providerContractMatches(contract) {
  try {
    const state = validatedProviderState(contract.backend, contract.role, contract.methods);
    return state.identity.id === contract.providerId && state.identity.version === contract.providerVersion &&
      state.identity.proofAuthority === contract.proofAuthority && state.fingerprint === contract.fingerprint &&
      sameCanonicalData(state.capabilities, contract.capabilities);
  } catch {
    return false;
  }
}

function capabilityContractIdentity(contract) {
  return Object.freeze({
    role: contract.role,
    providerId: contract.providerId,
    providerVersion: contract.providerVersion,
    proofAuthority: contract.proofAuthority,
    fingerprint: contract.fingerprint,
    capabilities: contract.capabilities,
    supportedSorts: Object.freeze([...contract.supportedSorts]),
    maxBvWidth: contract.maxBvWidth,
    maxAssignments: contract.maxAssignments,
    maxConstraints: contract.maxConstraints,
    maxExprNodes: contract.maxExprNodes,
    maxExprDepth: contract.maxExprDepth,
  });
}

function backendEligibility(contract, query, route) {
  if (!contract.supportedSorts.includes(SORT_KIND.BOOL)) return Object.freeze({ eligible: false, reason: 'bool-sort-not-supported' });
  if (route.maxBvWidth > 0 && !contract.supportedSorts.includes(SORT_KIND.BV)) return Object.freeze({ eligible: false, reason: 'bv-sort-not-supported' });
  if (route.maxBvWidth > contract.maxBvWidth) return Object.freeze({ eligible: false, reason: `bitvector-width-exceeds-${contract.maxBvWidth}` });
  if (contract.maxConstraints != null && query.constraints.length > contract.maxConstraints) return Object.freeze({ eligible: false, reason: 'constraint-budget-exceeded' });
  if (contract.maxExprNodes != null && route.collected.nodeCount > contract.maxExprNodes) return Object.freeze({ eligible: false, reason: 'expression-node-budget-exceeded' });
  if (contract.maxExprDepth != null && route.collected.maxDepth > contract.maxExprDepth) return Object.freeze({ eligible: false, reason: 'expression-depth-budget-exceeded' });
  if (contract.maxAssignments != null && exhaustiveDomainSize(route.collected.symbols, contract.maxAssignments) > BigInt(contract.maxAssignments)) {
    return Object.freeze({ eligible: false, reason: 'assignment-budget-exceeded' });
  }
  return Object.freeze({ eligible: true, reason: 'capability-contract-matches-query' });
}

export function classifyTieredQuery(query, options = {}) {
  const value = (name, fallback) => Object.prototype.hasOwnProperty.call(options, name) ? options[name] : fallback;
  const exhaustiveMaxBvWidth = value('exhaustiveMaxBvWidth', 8);
  const exhaustiveMaxAssignments = value('exhaustiveMaxAssignments', 1 << 20);
  const maxBvWidth = value('maxBvWidth', 64);
  const maxExprNodes = value('maxExprNodes', 100000);
  const maxExprDepth = value('maxExprDepth', 1024);
  const maxConstraints = value('maxConstraints', 4096);
  try {
    requirePositiveSafeInteger(exhaustiveMaxBvWidth, 'exhaustiveMaxBvWidth');
    requirePositiveSafeInteger(exhaustiveMaxAssignments, 'exhaustiveMaxAssignments');
    requirePositiveSafeInteger(maxBvWidth, 'maxBvWidth');
    requirePositiveSafeInteger(maxExprNodes, 'maxExprNodes');
    requirePositiveSafeInteger(maxExprDepth, 'maxExprDepth');
    requirePositiveSafeInteger(maxConstraints, 'maxConstraints');
  } catch (error) {
    return Object.freeze({ supported: false, status: SOLVER_STATUS.INVALID_QUERY, reason: `invalid-budget:${error.message}`, tier: null });
  }
  const queryValidation = validateVerificationQuery(query, { maxExprNodes });
  if (!queryValidation.valid) {
    return Object.freeze({
      supported: false,
      status: queryValidation.limitExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY,
      reason: queryValidation.reason,
      tier: null,
    });
  }
  if (query.constraints.length > maxConstraints) return Object.freeze({ supported: false, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'constraint-budget-exceeded', tier: null });
  const collected = collectSymbols(queryExpressions(query), { maxExprNodes, maxExprDepth });
  if (collected.limitExceeded) return Object.freeze({ supported: false, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'expression-node-budget-exceeded', tier: null, collected });
  if (collected.depthExceeded) return Object.freeze({ supported: false, status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'expression-depth-budget-exceeded', tier: null, collected });
  if (collected.unsupportedReason) return Object.freeze({ supported: false, reason: collected.unsupportedReason, tier: null, collected });
  if (collected.maxBvWidth > maxBvWidth) {
    return Object.freeze({ supported: false, reason: `bitvector-width-exceeds-${maxBvWidth}`, tier: null, collected });
  }
  const domainSize = exhaustiveDomainSize(collected.symbols, exhaustiveMaxAssignments);
  const exhaustive = collected.maxBvWidth <= exhaustiveMaxBvWidth && domainSize <= BigInt(exhaustiveMaxAssignments);
  return Object.freeze({
    supported: true,
    tier: exhaustive ? 'exhaustive-oracle' : 'bitblast-qfbv',
    reason: exhaustive ? 'bounded-domain-within-exhaustive-oracle' : 'wide-or-large-domain-qfbv',
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
    let effectiveMaxBvWidth;
    let effectiveExhaustiveMaxBvWidth;
    let effectiveExhaustiveMaxAssignments;
    let effectiveMaxExprNodes;
    let effectiveMaxExprDepth;
    let effectiveMaxConstraints;
    let effectiveYieldEvery;
    try {
      effectiveMaxBvWidth = effectivePositiveSafeInteger(options, 'maxBvWidth', this.backend.maxBvWidth, this.backend.maxBvWidth);
      effectiveExhaustiveMaxBvWidth = effectivePositiveSafeInteger(options, 'exhaustiveMaxBvWidth', this.backend.exhaustiveMaxBvWidth, this.backend.exhaustiveMaxBvWidth);
      effectiveExhaustiveMaxAssignments = effectivePositiveSafeInteger(options, 'exhaustiveMaxAssignments', this.backend.exhaustiveMaxAssignments, this.backend.exhaustiveMaxAssignments);
      effectiveMaxExprNodes = effectivePositiveSafeInteger(options, 'maxExprNodes', this.options.maxExprNodes, this.backend.maxExprNodes);
      effectiveMaxExprDepth = effectivePositiveSafeInteger(options, 'maxExprDepth', this.options.maxExprDepth, this.backend.maxExprDepth);
      effectiveMaxConstraints = effectivePositiveSafeInteger(options, 'maxConstraints', this.options.maxConstraints, this.backend.maxConstraints);
      effectiveYieldEvery = effectivePositiveSafeInteger(options, 'yieldEvery', this.options.yieldEvery, this.backend.yieldEvery);
    } catch (error) {
      return createSolverResult({ status: SOLVER_STATUS.INVALID_QUERY, reason: `invalid-budget:${error.message}`, backend: this.backend.id, backendVersion: this.backend.version, queryHash: null, lifecycle: { publishable: false } });
    }
    const route = classifyTieredQuery(query, {
      exhaustiveMaxBvWidth: effectiveExhaustiveMaxBvWidth,
      exhaustiveMaxAssignments: effectiveExhaustiveMaxAssignments,
      maxBvWidth: effectiveMaxBvWidth,
      maxExprNodes: effectiveMaxExprNodes,
      maxExprDepth: effectiveMaxExprDepth,
      maxConstraints: effectiveMaxConstraints,
    });
    const base = { backend: this.backend.id, backendVersion: this.backend.version, queryHash: query?.queryHash || null };
    if (!route.supported) {
      const status = route.status || SOLVER_STATUS.UNSUPPORTED;
      return createSolverResult({ ...base, status, reason: route.reason, stats: { solveTimeMs: Date.now() - startedAt, routingTier: 'unsupported' }, lifecycle: { publishable: false } });
    }
    if (deadline !== Infinity && monotonicNow() >= deadline) {
      return createSolverResult({ ...base, status: SOLVER_STATUS.TIMEOUT, reason: 'tiered-routing-deadline-exceeded', lifecycle: { timedOut: true, publishable: false }, stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier } });
    }

    const attempts = [];
    const configured = [this.backend.narrowCapabilityContract, this.backend.wideCapabilityContract];
    const eligibility = configured.map((contract) => Object.freeze({ contract, ...backendEligibility(contract, query, route) }));
    const candidates = eligibility.filter((item) => item.eligible);
    if (candidates.length === 0) {
      return createSolverResult({ ...base, status: SOLVER_STATUS.UNSUPPORTED, reason: 'no-configured-exact-tier-capability-overlap', lifecycle: { publishable: false }, stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier, eligibility: eligibility.map((item) => ({ backend: item.contract.providerId, eligible: item.eligible, reason: item.reason })) } });
    }
    const results = [];
    for (const candidate of candidates) {
      const { backend, role } = candidate.contract;
      const providerFailure = (reason) => createSolverResult({
        status: SOLVER_STATUS.PROVIDER_FAILURE,
        reason,
        backend: candidate.contract.providerId,
        backendVersion: candidate.contract.providerVersion,
        queryHash: query.queryHash,
        lifecycle: { publishable: false },
      });
      if (signal?.aborted) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.CANCELLED, reason: 'tiered-query-aborted', lifecycle: { cancelled: true, publishable: false }, stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier, attempts } });
      }
      const remainingMs = deadline === Infinity ? 0 : Math.floor(deadline - monotonicNow());
      if (remainingMs <= 0 && deadline !== Infinity) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.TIMEOUT, reason: 'tiered-agreement-deadline-exceeded', lifecycle: { timedOut: true, publishable: false }, stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier, attempts } });
      }
      let child = null;
      let result;
      let providerContractInvalid = false;
      let disposeError = null;
      const childSessionOptions = { ...options, timeoutMs: remainingMs };
      try {
        providerContractInvalid = !providerContractMatches(candidate.contract);
        if (!providerContractInvalid) {
          child = candidate.contract.methods.createSession.call(backend, childSessionOptions);
          providerContractInvalid = !providerContractMatches(candidate.contract);
        }
        if (!providerContractInvalid) {
          const childOptions = role === 'narrow'
            ? { ...options, timeoutMs: remainingMs, maxBvWidth: Math.min(effectiveMaxBvWidth, candidate.contract.maxBvWidth), maxAssignments: candidate.contract.maxAssignments == null ? effectiveExhaustiveMaxAssignments : Math.min(effectiveExhaustiveMaxAssignments, candidate.contract.maxAssignments), maxConstraints: effectiveMaxConstraints, maxExprNodes: effectiveMaxExprNodes, maxExprDepth: effectiveMaxExprDepth, yieldEvery: effectiveYieldEvery, signal }
            : { ...options, timeoutMs: remainingMs, maxBvWidth: effectiveMaxBvWidth, maxConstraints: effectiveMaxConstraints, maxExprNodes: effectiveMaxExprNodes, maxExprDepth: effectiveMaxExprDepth, yieldEvery: effectiveYieldEvery, signal };
          const check = resolveDataMethod(child, 'check', `${role}.session`);
          providerContractInvalid = !providerContractMatches(candidate.contract);
          if (!providerContractInvalid) result = await check.call(child, query, childOptions);
          providerContractInvalid ||= !providerContractMatches(candidate.contract);
        }
      } catch (error) {
        result = providerFailure(`tier-provider-unavailable:${error?.message || 'provider-failure'}`);
      } finally {
        try { await child?.dispose(); }
        catch (error) { disposeError = error; }
        providerContractInvalid ||= !providerContractMatches(candidate.contract);
      }
      if (providerContractInvalid) result = providerFailure(`tier-provider-contract-mismatch:${role}`);
      else if (disposeError) result = providerFailure(`tier-provider-dispose-failed:${disposeError?.message || 'provider-failure'}`);
      attempts.push(Object.freeze({ backend: candidate.contract.providerId, status: result?.status || 'invalid' }));
      if (deadline !== Infinity && monotonicNow() >= deadline) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.TIMEOUT, reason: 'tiered-agreement-deadline-exceeded', lifecycle: { timedOut: true, publishable: false }, stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier, attempts } });
      }
      const proofResult = isDefinite(result);
      const capturedBackendIdentity = { id: candidate.contract.providerId, version: candidate.contract.providerVersion };
      if (!isValidSolverResult(result, { backend: capturedBackendIdentity }) ||
          (proofResult && !isValidSolverResult(result, { query, backend: capturedBackendIdentity })) ||
          (result?.queryHash != null && result.queryHash !== query.queryHash)) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: 'tier-returned-malformed-or-misbound-result', lifecycle: { publishable: false }, stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier, attempts } });
      }
      if (result.status === SOLVER_STATUS.SAT) {
        const bindingValidation = validateExactModelBindings(route.collected.symbols, result.model);
        if (!bindingValidation.valid) {
          return createSolverResult({ ...base, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: `tier-model-binding-validation-failed:${bindingValidation.reason}`, lifecycle: { publishable: false }, stats: { ...result.stats, solveTimeMs: Date.now() - startedAt, routingTier: route.tier, routingReason: route.reason, attempts } });
        }
        const validation = validateSatModel(query, result.model);
        if (!validation.valid) {
          return createSolverResult({ ...base, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: `tier-model-validation-failed:${validation.reason}`, lifecycle: { publishable: false }, stats: { ...result.stats, solveTimeMs: Date.now() - startedAt, routingTier: route.tier, routingReason: route.reason, attempts } });
        }
      }
      results.push(result);
      if (result.status === SOLVER_STATUS.CANCELLED || signal?.aborted) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.CANCELLED, reason: result.reason || 'tiered-query-aborted', lifecycle: { cancelled: true, publishable: false }, stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier, attempts } });
      }
      if (result.status === SOLVER_STATUS.TIMEOUT) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.TIMEOUT, reason: result.reason || 'tiered-agreement-deadline-exceeded', lifecycle: { timedOut: true, publishable: false }, stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier, attempts } });
      }
    }

    const definite = results.filter(isDefinite);
    if (candidates.length > 1) {
      if (definite.length === 2 && definite[0].status !== definite[1].status) {
        return createSolverResult({ ...base, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: `exact-tier-semantic-disagreement:${definite[0].status}-vs-${definite[1].status}`, lifecycle: { publishable: false }, stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier, routingReason: route.reason, attempts, agreementPolicy: 'all-overlapping-exact-tiers-v1' } });
      }
      if (definite.length !== 2) {
        const unavailable = results.find((result) => !isDefinite(result)) || results[0];
        return createSolverResult({
          ...base,
          status: unavailable?.status || SOLVER_STATUS.PROVIDER_FAILURE,
          reason: `exact-tier-agreement-unavailable:${unavailable?.reason || unavailable?.status || 'missing-result'}`,
          lifecycle: { ...(unavailable?.lifecycle || {}), publishable: false },
          stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier, routingReason: route.reason, attempts, agreementPolicy: 'all-overlapping-exact-tiers-v1' },
        });
      }
    }

    const lastResult = definite[0] || results[results.length - 1];
    const proofResult = isDefinite(lastResult);
    if (proofResult && deadline !== Infinity && monotonicNow() >= deadline) {
      return createSolverResult({ ...base, status: SOLVER_STATUS.TIMEOUT, reason: 'tiered-agreement-deadline-exceeded-before-publication', lifecycle: { timedOut: true, publishable: false }, stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier, attempts } });
    }
    const unboundBeforePublication = proofResult ? candidates.find((candidate) => !providerContractMatches(candidate.contract)) : null;
    if (unboundBeforePublication) {
      return createSolverResult({
        ...base,
        status: SOLVER_STATUS.PROVIDER_FAILURE,
        reason: `tier-provider-contract-mismatch-before-publication:${unboundBeforePublication.contract.role}`,
        lifecycle: { publishable: false },
        stats: { solveTimeMs: Date.now() - startedAt, routingTier: route.tier, routingReason: route.reason, attempts, engineBackend: null },
      });
    }
    return createSolverResult({
      ...lastResult,
      ...base,
      stats: {
        ...lastResult.stats,
        solveTimeMs: Date.now() - startedAt,
        routingTier: route.tier,
        routingReason: route.reason,
        exhaustiveDomainSize: route.exhaustiveDomainSize,
        engineBackend: proofResult ? lastResult.backend : null,
        attempts,
        agreementPolicy: candidates.length > 1 ? 'all-overlapping-exact-tiers-v1' : 'single-capability-route-v1',
        agreementBackends: proofResult ? definite.map((result) => result.backend) : [],
        eligibility: eligibility.map((item) => ({ backend: item.contract.providerId, eligible: item.eligible, reason: item.reason })),
      },
      lifecycle: { ...lastResult.lifecycle, publishable: proofResult && lastResult.lifecycle?.publishable !== false },
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
    delete wideOptions.maxBvWidth;
    delete wideOptions.exhaustiveMaxBvWidth;
    delete wideOptions.exhaustiveMaxAssignments;
    delete wideOptions.maxConstraints;
    delete wideOptions.maxExprNodes;
    delete wideOptions.maxExprDepth;
    delete wideOptions.yieldEvery;
    if (this.exhaustiveMaxBvWidth > this.maxBvWidth) throw new TypeError('exhaustiveMaxBvWidth cannot exceed maxBvWidth');
    this.narrowBackend = narrowBackend || new ExhaustiveBvBackend({
      maxBvWidth: this.exhaustiveMaxBvWidth,
      maxAssignments: this.exhaustiveMaxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      yieldEvery: this.yieldEvery,
    });
    this.wideBackend = wideBackend || new BitBlastBvBackend({ maxBvWidth: this.maxBvWidth, maxConstraints: this.maxConstraints, maxExprNodes: this.maxExprNodes, maxExprDepth: this.maxExprDepth, yieldEvery: this.yieldEvery, ...wideOptions });
    Object.defineProperties(this, {
      narrowCapabilityContract: { value: captureCapabilityContract(this.narrowBackend, 'narrow'), enumerable: true },
      wideCapabilityContract: { value: captureCapabilityContract(this.wideBackend, 'wide'), enumerable: true },
    });
  }

  baseCapabilities() {
    const narrowCapabilityContract = capabilityContractIdentity(this.narrowCapabilityContract);
    const wideCapabilityContract = capabilityContractIdentity(this.wideCapabilityContract);
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
      singleEngineAuthority: 'nonoverlapping-capability-route-only-v1',
      exhaustiveMaxBvWidth: this.exhaustiveMaxBvWidth,
      exhaustiveMaxAssignments: this.exhaustiveMaxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      yieldEvery: this.yieldEvery,
      narrowBackendFingerprint: narrowCapabilityContract.fingerprint,
      wideBackendFingerprint: wideCapabilityContract.fingerprint,
      narrowCapabilityContract,
      wideCapabilityContract,
    };
  }

  createSession(options = {}) {
    return new TieredSolverSession(this, { maxConstraints: this.maxConstraints, maxExprNodes: this.maxExprNodes, maxExprDepth: this.maxExprDepth, yieldEvery: this.yieldEvery, ...options });
  }
}

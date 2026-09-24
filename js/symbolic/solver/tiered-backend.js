/** Exact QF_BV router with captured provider contracts and overlap agreement. */
import { stableDigest } from '../../core/identity/index.js';
import { SORT_KIND } from '../expr/kinds.js';
import { validateVerificationQuery } from '../verify/query.js';
import { validateSatModel } from '../verify/validate-model.js';
import { PROOF_AUTHORITY, SolverBackend, isSolverBackendInstance } from './backend.js';
import { BitBlastBvBackend } from './bitblast-backend.js';
import { ExhaustiveBvBackend } from './exhaustive-backend.js';
import { effectivePositiveSafeInteger, requirePositiveSafeInteger } from './limits.js';
import { validateExactModelBindings } from './model-boundary.js';
import { analyzeSolverExpressions } from './query-analysis.js';
import { SOLVER_STATUS, createSolverResult, isValidSolverResult } from './result.js';
import { SolverSession } from './session.js';

export const TIERED_BACKEND_ID = 'hex-tiered-qfbv';
export const TIERED_BACKEND_VERSION = '1.0.0';

const DEFAULTS = Object.freeze({
  maxBvWidth: 64,
  maxConstraints: 4096,
  maxExprNodes: 100000,
  maxExprDepth: 1024,
  exhaustiveMaxBvWidth: 8,
  exhaustiveMaxAssignments: 1 << 20,
  maxVariables: 400000,
  maxClauses: 1600000,
  maxDecisions: 500000,
  maxPropagations: 8000000,
  yieldEvery: 8192,
});
const OPTION_NAMES = new Set([
  'id', 'version', 'timeoutMs', ...Object.keys(DEFAULTS), 'narrowBackend', 'wideBackend', 'exhaustiveBackend', 'bitblastBackend',
]);
const SESSION_OPTION_NAMES = new Set([...OPTION_NAMES, 'signal', 'isCancelled']);
const CAPABILITY_SORTS = new Set([SORT_KIND.BOOL, SORT_KIND.BV]);

function safeOptions(value, name, allowedNames = OPTION_NAMES) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be a data object`);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { throw new TypeError(`${name} must not be a proxy or unreadable object`); }
  const result = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new TypeError(`${name} must contain enumerable own data`);
    }
    if (!allowedNames.has(key)) throw new TypeError(`${name} contains unsupported option '${key}'`);
    result[key] = descriptor.value;
  }
  return result;
}

function dataMethod(object, name) {
  let current = object;
  while (current) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(current, name); }
    catch { throw new TypeError(`backend ${name} method is unreadable`); }
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new TypeError(`backend ${name} must be a data method`);
      }
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  throw new TypeError(`backend ${name} method is required`);
}

function ownIdentity(backend, key) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(backend, key); }
  catch { throw new TypeError(`backend ${key} must be an own data property`); }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`backend ${key} must be an own data property`);
  return descriptor.value;
}

function snapshotSorts(value) {
  if (!Array.isArray(value)) throw new TypeError('backend supported sorts must be a data array');
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { throw new TypeError('backend supported sorts cannot be a proxy or non-cloneable data'); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 1) throw new TypeError('backend supported sorts must be a nonempty data array');
  const sorts = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      throw new TypeError('backend supported sorts cannot contain extra properties');
    }
  }
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable ||
        typeof descriptor.value !== 'string' || !CAPABILITY_SORTS.has(descriptor.value) || sorts.includes(descriptor.value)) {
      throw new TypeError('backend supported sorts must be unique canonical data');
    }
    sorts.push(descriptor.value);
  }
  try { structuredClone(value); }
  catch { throw new TypeError('backend supported sorts cannot be a proxy or non-cloneable data'); }
  return Object.freeze(sorts.sort());
}

function capabilityData(backend) {
  if (!isSolverBackendInstance(backend)) throw new TypeError('provider must be a branded SolverBackend instance, not a proxy');
  const id = ownIdentity(backend, 'id');
  const version = ownIdentity(backend, 'version');
  const authority = ownIdentity(backend, 'proofAuthority');
  if (typeof id !== 'string' || !id || typeof version !== 'string' || !version) throw new TypeError('backend identity must use own nonempty data properties');
  if (authority !== PROOF_AUTHORITY.EXACT) throw new TypeError('backend must have exact proof authority');
  const capabilitiesMethod = dataMethod(backend, 'capabilities');
  const fingerprintMethod = dataMethod(backend, 'capabilityFingerprint');
  let advertised;
  try { advertised = capabilitiesMethod.call(backend); }
  catch { throw new TypeError('backend capabilities could not be captured'); }
  if (!advertised || typeof advertised !== 'object' || Array.isArray(advertised)) throw new TypeError('backend capabilities must be a plain record');
  let prototype, descriptors;
  try {
    prototype = Object.getPrototypeOf(advertised);
    descriptors = Object.getOwnPropertyDescriptors(advertised);
  } catch { throw new TypeError('backend capabilities must not be proxy-backed'); }
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('backend capabilities must be a plain record');
  const contract = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new TypeError('backend capability accessors and hidden fields are not supported');
    }
    const value = key === 'supportedSorts' ? snapshotSorts(descriptor.value) : descriptor.value;
    if (key !== 'supportedSorts' && value !== null && !['string', 'boolean', 'number'].includes(typeof value)) {
      throw new TypeError(`backend capability '${key}' must be cloneable primitive data`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`backend capability '${key}' must be finite`);
    contract[key] = value;
  }
  if (!Object.hasOwn(contract, 'supportedSorts') ||
      !Number.isSafeInteger(contract.maxBvWidth) || contract.maxBvWidth < 1 ||
      contract.exactProofs !== true || contract.supportsModelExtraction !== true ||
      contract.proofAuthority !== PROOF_AUTHORITY.EXACT) {
    throw new TypeError('backend capabilities do not establish an exact model-producing contract');
  }
  for (const name of ['maxConstraints', 'maxExprNodes', 'maxExprDepth', 'maxAssignments', 'maxVariables', 'maxClauses', 'maxDecisions', 'maxPropagations']) {
    if (Object.hasOwn(contract, name)) requirePositiveSafeInteger(contract[name], `backend ${name}`);
  }
  let fingerprint;
  try { fingerprint = fingerprintMethod.call(backend); }
  catch { throw new TypeError('backend capability fingerprint could not be captured'); }
  if (typeof fingerprint !== 'string' || !fingerprint || contract.capabilityFingerprint !== fingerprint) {
    throw new TypeError('backend capability fingerprint is not bound to its advertised contract');
  }
  const snapshot = Object.freeze({ ...contract, supportedSorts: contract.supportedSorts });
  return Object.freeze({ backend, id, version, authority, fingerprint, contract: snapshot,
    digest: stableDigest({ id, version, authority, fingerprint, contract: snapshot }) });
}

function sameProviderContract(captured) {
  try { return capabilityData(captured.backend).digest === captured.digest; }
  catch { return false; }
}

function domainSize(symbols, ceiling) {
  let size = 1n;
  const max = BigInt(ceiling);
  for (const symbol of symbols) {
    size *= symbol.sort.kind === SORT_KIND.BOOL ? 2n : 1n << BigInt(symbol.sort.width);
    if (size > max) break;
  }
  return size;
}

function routeFailure(status, reason, extra = {}) {
  return Object.freeze({ supported: false, status, reason, tier: null, ...extra });
}

export function classifyTieredQuery(query, options = {}) {
  let captured;
  try { captured = safeOptions(options, 'tier classification options'); }
  catch (error) { return routeFailure(SOLVER_STATUS.INVALID_QUERY, `invalid-budget:${error.message}`); }
  const values = {};
  try {
    for (const [name, fallback] of Object.entries(DEFAULTS)) {
      const value = Object.hasOwn(captured, name) ? captured[name] : fallback;
      values[name] = requirePositiveSafeInteger(value, name);
    }
    if (values.exhaustiveMaxBvWidth > values.maxBvWidth) throw new TypeError('exhaustiveMaxBvWidth cannot exceed maxBvWidth');
  } catch (error) { return routeFailure(SOLVER_STATUS.INVALID_QUERY, `invalid-budget:${error.message}`); }
  const validation = validateVerificationQuery(query, {
    maxExprNodes: values.maxExprNodes,
    maxExprDepth: values.maxExprDepth,
  });
  if (!validation.valid) {
    const resource = validation.limitExceeded === true || ['expression-node-budget-exceeded', 'expression-depth-budget-exceeded'].includes(validation.reason);
    return routeFailure(resource ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY, validation.reason, {
      limitExceeded: resource,
    });
  }
  const expressions = [...query.constraints, ...(query.assertion ? [query.assertion] : [])];
  const analysis = analyzeSolverExpressions(expressions, {
    maxExprNodes: values.maxExprNodes,
    maxExprDepth: values.maxExprDepth,
  });
  if (analysis.limitExceeded || analysis.depthExceeded) return routeFailure(SOLVER_STATUS.RESOURCE_LIMIT,
    analysis.limitExceeded ? 'expression-node-budget-exceeded' : 'expression-depth-budget-exceeded', { analysis, limitExceeded: true });
  if (analysis.unsupportedReason) return routeFailure(SOLVER_STATUS.UNSUPPORTED, analysis.unsupportedReason, { analysis });
  if (query.constraints.length > values.maxConstraints) return routeFailure(SOLVER_STATUS.RESOURCE_LIMIT,
    'constraint-budget-exceeded', { analysis, limitExceeded: true });
  if (analysis.maxBvWidth > values.maxBvWidth) return routeFailure(SOLVER_STATUS.UNSUPPORTED,
    `bitvector-width-exceeds-${values.maxBvWidth}`, { analysis });
  const size = domainSize(analysis.symbols, values.exhaustiveMaxAssignments);
  const narrowRoute = analysis.maxBvWidth <= values.exhaustiveMaxBvWidth && size <= BigInt(values.exhaustiveMaxAssignments);
  return Object.freeze({ supported: true, status: SOLVER_STATUS.SAT, tier: narrowRoute ? 'exhaustive-oracle' : 'bitblast-qfbv',
    reason: narrowRoute ? 'bounded-domain-within-exhaustive-oracle' : 'wide-or-large-domain-qfbv',
    maxBvWidth: analysis.maxBvWidth, exhaustiveDomainSize: size.toString(), constraintCount: query.constraints.length,
    analysis, validation });
}

function providerEligible(provider, route, role, limits) {
  const cap = provider.contract;
  if (route.analysis.maxBvWidth > cap.maxBvWidth) return false;
  if (route.analysis.symbols.some((symbol) => !cap.supportedSorts.includes(symbol.sort.kind))) return false;
  if (cap.maxConstraints != null && route.constraintCount > cap.maxConstraints) return false;
  if (cap.maxExprNodes != null && route.analysis.nodeCount > cap.maxExprNodes) return false;
  if (cap.maxExprDepth != null && route.analysis.maxDepth > cap.maxExprDepth) return false;
  if (role === 'narrow') {
    if (cap.maxAssignments != null && route.exhaustiveDomainSize &&
        BigInt(route.exhaustiveDomainSize) > BigInt(cap.maxAssignments)) return false;
  }
  return true;
}

function resultFor(backend, queryHash, status, reason, stats = {}, lifecycle = {}) {
  return createSolverResult({ status, reason, stats, backend: backend.id, backendVersion: backend.version,
    queryHash, lifecycle: { publishable: false, ...lifecycle } });
}

function failurePriority(attempts) {
  const statuses = attempts.map((attempt) => attempt.result?.status ?? attempt.status);
  for (const status of [SOLVER_STATUS.TIMEOUT, SOLVER_STATUS.CANCELLED, SOLVER_STATUS.RESOURCE_LIMIT,
    SOLVER_STATUS.PROVIDER_FAILURE, SOLVER_STATUS.INVALID_QUERY, SOLVER_STATUS.UNSUPPORTED]) {
    if (statuses.includes(status)) return status;
  }
  return SOLVER_STATUS.UNKNOWN;
}

class TieredSolverSession extends SolverSession {
  async _executeCheck(query, options = {}, _token, signal) {
    const names = Object.keys(DEFAULTS);
    const limits = {};
    try {
      for (const name of names) limits[name] = effectivePositiveSafeInteger(options, name, this.options[name], this.backend[name]);
      if (limits.exhaustiveMaxBvWidth > limits.maxBvWidth) throw new TypeError('exhaustiveMaxBvWidth cannot exceed maxBvWidth');
    } catch (error) {
      return resultFor(this.backend, null, SOLVER_STATUS.INVALID_QUERY, `invalid-budget:${error.message}`);
    }
    const route = classifyTieredQuery(query, limits);
    if (!route.supported) return resultFor(this.backend,
      route.status === SOLVER_STATUS.INVALID_QUERY ? null : query?.queryHash || null,
      route.status || SOLVER_STATUS.UNSUPPORTED, route.reason,
      { routingTier: route.tier, eligibility: [], attempts: [], engineBackend: null },
      { budgetExceeded: route.limitExceeded === true });

    let querySnapshot;
    try { querySnapshot = structuredClone(query); }
    catch (error) { return resultFor(this.backend, null, SOLVER_STATUS.INVALID_QUERY,
      `query-snapshot-failed:${error?.message || 'uncloneable-query'}`); }
    const snapshotRoute = classifyTieredQuery(querySnapshot, limits);
    if (!snapshotRoute.supported || querySnapshot.queryHash !== query.queryHash) {
      return resultFor(this.backend, null, SOLVER_STATUS.INVALID_QUERY, 'query-snapshot-identity-mismatch');
    }
    const candidates = [
      { role: 'narrow', provider: this.backend.narrowBackend },
      { role: 'wide', provider: this.backend.wideBackend },
    ];
    const eligibility = candidates.map(({ role, provider }) => Object.freeze({
      backend: provider.id,
      eligible: providerEligible(this.backend._providerContracts[role], snapshotRoute, role, limits),
    }));
    const selected = candidates.filter(({ role }) => eligibility[role === 'narrow' ? 0 : 1].eligible);
    if (!selected.length) return resultFor(this.backend, querySnapshot.queryHash, SOLVER_STATUS.UNSUPPORTED,
      'no-exact-tier-eligible', { eligibility, attempts: [], engineBackend: null });

    const timeoutMs = options.timeoutMs;
    const deadline = timeoutMs > 0 ? (globalThis.performance?.now?.() ?? Date.now()) + timeoutMs : Infinity;
    const attempts = [];
    for (const { role, provider } of selected) {
      if (signal?.aborted) return resultFor(this.backend, querySnapshot.queryHash, SOLVER_STATUS.CANCELLED,
        'exact-tier-agreement-cancelled', { eligibility, attempts, engineBackend: null }, { cancelled: true });
      if ((globalThis.performance?.now?.() ?? Date.now()) >= deadline) return resultFor(this.backend, querySnapshot.queryHash,
        SOLVER_STATUS.TIMEOUT, 'exact-tier-agreement-timeout', { eligibility, attempts, engineBackend: null }, { timedOut: true });
      const captured = this.backend._providerContracts[role];
      if (!sameProviderContract(captured)) return resultFor(this.backend, querySnapshot.queryHash,
        SOLVER_STATUS.PROVIDER_FAILURE, `tier-provider-contract-mismatch:${role}`,
        { eligibility, attempts, engineBackend: null });
      let childSession, raw, normalized;
      try {
        const createSession = dataMethod(provider, 'createSession');
        childSession = createSession.call(provider, { timeoutMs: 0 });
        if (!childSession || typeof childSession !== 'object' || typeof childSession.check !== 'function') {
          throw new TypeError('exact provider returned an invalid session');
        }
        const cap = captured.contract;
        const childLimits = {
          ...limits,
          maxBvWidth: Math.min(limits.maxBvWidth, cap.maxBvWidth),
          maxConstraints: Math.min(limits.maxConstraints, cap.maxConstraints ?? limits.maxConstraints),
          maxExprNodes: Math.min(limits.maxExprNodes, cap.maxExprNodes ?? limits.maxExprNodes),
          maxExprDepth: Math.min(limits.maxExprDepth, cap.maxExprDepth ?? limits.maxExprDepth),
          maxVariables: Math.min(limits.maxVariables, cap.maxVariables ?? limits.maxVariables),
          maxClauses: Math.min(limits.maxClauses, cap.maxClauses ?? limits.maxClauses),
          maxDecisions: Math.min(limits.maxDecisions, cap.maxDecisions ?? limits.maxDecisions),
          maxPropagations: Math.min(limits.maxPropagations, cap.maxPropagations ?? limits.maxPropagations),
          exhaustiveMaxAssignments: Math.min(limits.exhaustiveMaxAssignments, cap.maxAssignments ?? limits.exhaustiveMaxAssignments),
        };
        const remaining = deadline === Infinity ? timeoutMs : Math.max(1, Math.floor(deadline - (globalThis.performance?.now?.() ?? Date.now())));
        if (role === 'narrow') childLimits.maxAssignments = childLimits.exhaustiveMaxAssignments;
        raw = await childSession.check(querySnapshot, { ...options, ...childLimits, timeoutMs: remaining, signal });
      } catch (error) {
        attempts.push({ backend: captured.id, status: SOLVER_STATUS.PROVIDER_FAILURE, reason: error?.message || 'provider-unavailable' });
        try { await childSession?.dispose?.(); } catch { /* provider cleanup is best effort */ }
        if (signal?.aborted) return resultFor(this.backend, querySnapshot.queryHash, SOLVER_STATUS.CANCELLED,
          'exact-tier-agreement-cancelled', { eligibility, attempts, engineBackend: null }, { cancelled: true });
        continue;
      }
      try { await childSession.dispose?.(); } catch { /* completed provider cleanup is best effort */ }
      if (signal?.aborted) return resultFor(this.backend, querySnapshot.queryHash, SOLVER_STATUS.CANCELLED,
        'exact-tier-agreement-cancelled', { eligibility, attempts, engineBackend: null }, { cancelled: true });
      if ((globalThis.performance?.now?.() ?? Date.now()) >= deadline) return resultFor(this.backend, querySnapshot.queryHash,
        SOLVER_STATUS.TIMEOUT, 'exact-tier-agreement-timeout', { eligibility, attempts, engineBackend: null }, { timedOut: true });
      if (!sameProviderContract(captured)) return resultFor(this.backend, querySnapshot.queryHash,
        SOLVER_STATUS.PROVIDER_FAILURE, `tier-provider-contract-mismatch:${role}`,
        { eligibility, attempts, engineBackend: null });
      try {
        normalized = createSolverResult(raw);
        if (!isValidSolverResult(normalized, { query: querySnapshot, backend: provider })) {
          throw new TypeError('provider result identity mismatch');
        }
        if (normalized.status === SOLVER_STATUS.SAT) {
          const binding = validateExactModelBindings(snapshotRoute.analysis.symbols, normalized.model);
          const semantic = binding.valid ? validateSatModel(querySnapshot, normalized.model) : binding;
          if (!semantic.valid) throw new TypeError(`tier-model-binding-validation-failed:model-validation-failed:${semantic.reason}`);
        }
      } catch (error) {
        const reason = String(error?.message || 'provider-result-invalid');
        attempts.push({ backend: captured.id, status: SOLVER_STATUS.PROVIDER_FAILURE, reason });
        continue;
      }
      attempts.push({ backend: captured.id, status: normalized.status, result: normalized, role });
    }

    if (signal?.aborted) return resultFor(this.backend, querySnapshot.queryHash, SOLVER_STATUS.CANCELLED,
      'exact-tier-agreement-cancelled', { eligibility, attempts, engineBackend: null }, { cancelled: true });
    if ((globalThis.performance?.now?.() ?? Date.now()) >= deadline) return resultFor(this.backend, querySnapshot.queryHash,
      SOLVER_STATUS.TIMEOUT, 'exact-tier-agreement-timeout', { eligibility, attempts, engineBackend: null }, { timedOut: true });
    const valid = attempts.filter((attempt) => attempt.result);
    const failed = attempts.filter((attempt) => !attempt.result);
    const success = valid.filter((attempt) => attempt.result.status === SOLVER_STATUS.SAT || attempt.result.status === SOLVER_STATUS.UNSAT);
    if (failed.length || success.length !== valid.length) {
      const status = failurePriority(attempts);
      const detailedProviderFailure = status === SOLVER_STATUS.PROVIDER_FAILURE
        ? failed.find((attempt) => attempt.reason?.startsWith('tier-model-binding-validation-failed:') || attempt.reason?.startsWith('tier-provider-contract-mismatch:'))?.reason
        : null;
      const reason = detailedProviderFailure || (status === SOLVER_STATUS.RESOURCE_LIMIT
        ? 'exact-tier-agreement-unavailable:resource-limit-budget-exceeded'
        : `exact-tier-agreement-unavailable:${status}`);
      return resultFor(this.backend, querySnapshot.queryHash, status, reason,
        { eligibility, attempts: attempts.map(({ backend, status: resultStatus }) => ({ backend, status: resultStatus })), engineBackend: null },
        { budgetExceeded: status === SOLVER_STATUS.RESOURCE_LIMIT,
          timedOut: status === SOLVER_STATUS.TIMEOUT, cancelled: status === SOLVER_STATUS.CANCELLED });
    }
    const statuses = new Set(success.map((attempt) => attempt.result.status));
    if (statuses.size > 1) {
      const first = success[0].result.status, second = success.find((attempt) => attempt.result.status !== first).result.status;
      const disagreement = `${first}-vs-${second}`;
      return resultFor(this.backend, querySnapshot.queryHash, SOLVER_STATUS.PROVIDER_FAILURE,
        `exact-tier-semantic-disagreement:${disagreement}`,
        { eligibility, attempts: attempts.map(({ backend, status: resultStatus }) => ({ backend, status: resultStatus })),
          agreementBackends: [], engineBackend: null }, { publishable: false });
    }
    const winner = success[0];
    const tier = winner.role === 'narrow' ? 'exhaustive-oracle' : 'bitblast-qfbv';
    const stats = {
      ...winner.result.stats,
      routingTier: tier,
      engineBackend: winner.result.backend,
      tier,
      routedBackend: winner.result.backend,
      eligibility,
      attempts: attempts.map(({ backend, status: resultStatus }) => ({ backend, status: resultStatus })),
      agreementBackends: success.map((attempt) => attempt.result.backend),
      agreementPolicy: success.length > 1 ? 'all-overlapping-exact-tiers-v1' : null,
    };
    return createSolverResult({ status: winner.result.status, model: winner.result.model, reason: winner.result.reason,
      stats, backend: this.backend.id, backendVersion: this.backend.version, queryHash: querySnapshot.queryHash,
      lifecycle: winner.result.lifecycle });
  }
}

export class TieredBvBackend extends SolverBackend {
  constructor(options = {}) {
    const captured = safeOptions(options, 'tiered backend options');
    const values = {};
    for (const [name, fallback] of Object.entries(DEFAULTS)) values[name] = requirePositiveSafeInteger(
      Object.hasOwn(captured, name) ? captured[name] : fallback, name);
    if (values.exhaustiveMaxBvWidth > values.maxBvWidth) throw new TypeError('exhaustiveMaxBvWidth cannot exceed maxBvWidth');
    const id = Object.hasOwn(captured, 'id') ? captured.id : TIERED_BACKEND_ID;
    const version = Object.hasOwn(captured, 'version') ? captured.version : TIERED_BACKEND_VERSION;
    if (typeof id !== 'string' || !id || typeof version !== 'string' || !version) throw new TypeError('tiered backend id/version must be nonempty strings');
    const narrow = Object.hasOwn(captured, 'narrowBackend') ? captured.narrowBackend
      : Object.hasOwn(captured, 'exhaustiveBackend') ? captured.exhaustiveBackend
        : new ExhaustiveBvBackend({ maxBvWidth: values.exhaustiveMaxBvWidth,
          maxAssignments: values.exhaustiveMaxAssignments, maxConstraints: values.maxConstraints,
          maxExprNodes: values.maxExprNodes, maxExprDepth: values.maxExprDepth, yieldEvery: values.yieldEvery });
    const wide = Object.hasOwn(captured, 'wideBackend') ? captured.wideBackend
      : Object.hasOwn(captured, 'bitblastBackend') ? captured.bitblastBackend
        : new BitBlastBvBackend({ maxBvWidth: values.maxBvWidth, maxConstraints: values.maxConstraints,
          maxExprNodes: values.maxExprNodes, maxExprDepth: values.maxExprDepth,
          maxVariables: values.maxVariables, maxClauses: values.maxClauses,
          maxDecisions: values.maxDecisions, maxPropagations: values.maxPropagations, yieldEvery: values.yieldEvery });
    const narrowProvider = capabilityData(narrow);
    const wideProvider = capabilityData(wide);
    super({ id, version, proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: false, isWasm: false });
    Object.assign(this, values);
    this.narrowBackend = narrow;
    this.wideBackend = wide;
    this.exhaustiveBackend = narrow;
    this.bitblastBackend = wide;
    this._providerContracts = Object.freeze({ narrow: narrowProvider, wide: wideProvider });
    Object.freeze(this);
  }

  baseCapabilities() {
    const narrow = this._providerContracts.narrow;
    const wide = this._providerContracts.wide;
    return {
      ...super.baseCapabilities(),
      supportedSorts: Object.freeze([...new Set([...narrow.contract.supportedSorts, ...wide.contract.supportedSorts])].sort()),
      supportedLogic: 'QF_BV',
      maxBvWidth: Math.min(this.maxBvWidth, wide.contract.maxBvWidth),
      supportsIncremental: false,
      supportsCancellation: true,
      supportsModelExtraction: true,
      sessionReuseAfterTimeout: false,
      exactProofs: true,
      executionIsolation: 'caller-selected',
      memoryBudgetClass: 'measured-only',
      algorithm: 'tiered-exact-provider-agreement',
      maxAssignments: this.exhaustiveMaxAssignments,
      exhaustiveMaxBvWidth: this.exhaustiveMaxBvWidth,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      maxVariables: this.maxVariables,
      maxClauses: this.maxClauses,
      maxDecisions: this.maxDecisions,
      maxPropagations: this.maxPropagations,
      routingPolicy: 'exhaustive-oracle-then-bitblast-v1',
      overlapAgreementPolicy: 'all-overlapping-exact-tiers-v1',
      singleEngineAuthority: 'nonoverlapping-capability-route-only-v1',
      narrowBackendFingerprint: narrow.fingerprint,
      wideBackendFingerprint: wide.fingerprint,
      narrowCapabilityContract: narrow.contract,
      wideCapabilityContract: wide.contract,
    };
  }

  createSession(options = {}) {
    const captured = safeOptions(options, 'tiered session options', SESSION_OPTION_NAMES);
    const sessionOptions = { ...DEFAULTS };
    for (const [key, value] of Object.entries(captured)) {
      if (key === 'timeoutMs' || Object.hasOwn(DEFAULTS, key)) sessionOptions[key] = value;
    }
    return new TieredSolverSession(this, sessionOptions);
  }
}

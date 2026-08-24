import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { DEBUG_CAPABILITIES } from '../debug/adapter.js';
import { isValidatedStage2CapabilityProof } from '../platform/stage2-profile-evidence.js';

export const RUNTIME_AUTHORITY_SCHEMA = 'hex-runtime-authority/v1';
export const RUNTIME_OBSERVATION_SCHEMA = 'hex-runtime-observation/v1';
const DEBUG_CAPABILITY_SET = new Set(DEBUG_CAPABILITIES);

// These are the locked Stage 2 profiles.  A runtime proof is an authority
// boundary, so accepting an arbitrary caller supplied profile label would let
// a provider mint a new profile merely by naming it.
const NATIVE_TARGET_PROFILES = new Set(['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc']);
const PROVIDER_PROFILE_PATTERNS = Object.freeze([
  /^native:(?:remote-debug|lldb-compatible|frida-compatible|replay)-v1(?::[a-z0-9][a-z0-9._-]{0,63})?$/i,
  /^managed:(?:wasm|dex|cil|jvm):provider-bound-runtime-v1(?::[a-z0-9][a-z0-9._-]{0,63})?$/i,
]);
const MANAGED_TARGET_PROFILE = /^managed:(?:wasm|dex|cil|jvm):m6$/;
const VALID_RUNTIME_PROFILE_SUPPORT = new WeakSet();
const BINDING_FIELDS = Object.freeze([
  'schemaVersion', 'providerIdentity', 'providerProfileId', 'providerVersion',
  'runtimeInstanceIdentity', 'targetIdentity', 'targetProfileId',
  'architectureProfileId', 'binaryIdentity', 'buildIdentity',
  'runtimeBuildIdentity', 'moduleIdentity', 'loadMappingIdentity',
  'sessionIdentity', 'capabilityVersion', 'commitSha', 'treeSha', 'epoch',
]);
const OBSERVATION_FIELDS = Object.freeze([
  'schemaVersion', 'bindingId', 'providerIdentity', 'providerProfileId',
  'providerVersion', 'runtimeInstanceIdentity', 'targetIdentity',
  'targetProfileId', 'architectureProfileId', 'binaryIdentity',
  'buildIdentity', 'runtimeBuildIdentity', 'moduleIdentity',
  'loadMappingIdentity', 'sessionIdentity', 'capabilityVersion', 'commitSha',
  'treeSha', 'epoch', 'sequence', 'observedAt', 'kind', 'payload', 'authority',
]);

function required(value, code) {
  if (typeof value !== 'string') throw new TypeError(code);
  const text = value.trim();
  if (!text) throw new TypeError(code);
  return text;
}

function optional(value, code) {
  if (value == null) return null;
  return required(value, code);
}

function optionalSha(value, code) {
  const text = optional(value, code);
  if (text == null) return null;
  const normalized = text.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new TypeError(code);
  return normalized;
}

function identityAlias(input, primary, alias, code) {
  const first = input[primary] == null ? null : required(input[primary], code);
  const second = input[alias] == null ? null : required(input[alias], code);
  if (first != null && second != null && first !== second) throw new TypeError('runtime-identity-alias-mismatch');
  return first ?? second;
}

function numericPrimitive(value, code) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  throw new TypeError(code);
}

function uint(value, code) {
  const n = numericPrimitive(value, code);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(code);
  return n;
}

function boundedCount(value, fallback, max, code) {
  const n = value == null ? fallback : numericPrimitive(value, code);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError(code);
  return n;
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function capabilityList(value) {
  if (!Array.isArray(value)) return [];
  const out = [...new Set(value.map(String).filter(Boolean))].sort();
  for (const capability of out) if (!DEBUG_CAPABILITY_SET.has(capability)) throw new TypeError(`runtime-capability-unknown:${capability}`);
  return out;
}

function bindingPayload(input = {}) {
  const targetProfileId = identityAlias(input, 'targetProfileId', 'architectureProfileId', 'runtime-target-profile-required');
  const buildIdentity = identityAlias(input, 'buildIdentity', 'runtimeBuildIdentity', 'runtime-build-identity-invalid');
  return {
    schemaVersion: RUNTIME_AUTHORITY_SCHEMA,
    providerIdentity: required(input.providerIdentity, 'runtime-provider-identity-required'),
    providerProfileId: optional(input.providerProfileId, 'runtime-provider-profile-invalid'),
    providerVersion: optional(input.providerVersion, 'runtime-provider-version-invalid'),
    runtimeInstanceIdentity: required(input.runtimeInstanceIdentity, 'runtime-instance-identity-required'),
    targetIdentity: required(input.targetIdentity ?? input.processIdentity, 'runtime-target-identity-required'),
    targetProfileId,
    architectureProfileId: targetProfileId,
    binaryIdentity: required(input.binaryIdentity ?? input.binaryHash, 'runtime-binary-identity-required'),
    buildIdentity,
    runtimeBuildIdentity: buildIdentity,
    moduleIdentity: required(input.moduleIdentity, 'runtime-module-identity-required'),
    loadMappingIdentity: required(input.loadMappingIdentity, 'runtime-load-mapping-identity-required'),
    sessionIdentity: required(input.sessionIdentity ?? input.sessionId, 'runtime-session-identity-required'),
    capabilityVersion: required(input.capabilityVersion, 'runtime-capability-version-required'),
    commitSha: optionalSha(input.commitSha ?? input.sourceCommitSha, 'runtime-commit-identity-invalid'),
    treeSha: optionalSha(input.treeSha ?? input.sourceTreeSha, 'runtime-tree-identity-invalid'),
    epoch: uint(input.epoch ?? 0, 'runtime-epoch-invalid'),
  };
}

function bindingIdFor(binding) {
  const payload = {};
  for (const field of BINDING_FIELDS) if (field !== 'schemaVersion' || binding[field] != null) payload[field] = binding[field];
  return `runtime-binding:${stableDigest(payload)}`;
}

function canonicalBinding(input, { throwOnError = true } = {}) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('runtime-binding-schema-invalid');
    if (input.schemaVersion != null && input.schemaVersion !== RUNTIME_AUTHORITY_SCHEMA) throw new TypeError('runtime-binding-schema-invalid');
    const binding = bindingPayload(input);
    const expectedId = bindingIdFor(binding);
    if (input.schemaVersion === RUNTIME_AUTHORITY_SCHEMA && input.bindingId !== expectedId) throw new TypeError('runtime-binding-identity-invalid');
    return deepFreeze({ ...binding, bindingId: expectedId });
  } catch (error) {
    if (throwOnError) throw error;
    return null;
  }
}

function observationIdentity(observation) {
  const payload = {};
  for (const field of OBSERVATION_FIELDS) payload[field] = observation[field];
  return `runtime-observation:${stableDigest(payload)}`;
}

function profileAllowed(value) {
  const text = String(value ?? '').trim();
  return PROVIDER_PROFILE_PATTERNS.some((pattern) => pattern.test(text));
}

function targetProfileAllowed(value) {
  const text = String(value ?? '').trim();
  return NATIVE_TARGET_PROFILES.has(text) || MANAGED_TARGET_PROFILE.test(text);
}

function mismatchReason(binding, providerProfileId, targetProfileId, expectedBuildIdentity, proof = {}) {
  const boundProviderProfileId = binding.providerProfileId;
  const boundTargetProfileId = binding.targetProfileId;
  const proofProviderProfileId = proof.providerProfileId == null ? null : String(proof.providerProfileId).trim();
  const proofTargetProfileId = proof.targetProfileId == null ? null : String(proof.targetProfileId).trim();
  const proofProviderIdentity = proof.providerIdentity == null ? null : String(proof.providerIdentity).trim();
  const proofBuildIdentity = proof.buildIdentity ?? proof.runtimeBuildIdentity ?? null;
  if (!profileAllowed(providerProfileId)) return 'runtime-provider-profile-unsupported';
  if (!targetProfileAllowed(targetProfileId)) return 'runtime-target-profile-unsupported';
  if (boundProviderProfileId !== providerProfileId) return 'runtime-provider-profile-mismatch';
  if (boundTargetProfileId !== targetProfileId) return 'runtime-target-profile-mismatch';
  if (proofProviderProfileId != null && proofProviderProfileId !== providerProfileId) return 'runtime-proof-provider-profile-mismatch';
  if (proofTargetProfileId != null && proofTargetProfileId !== targetProfileId) return 'runtime-proof-target-profile-mismatch';
  if (proofProviderIdentity != null && proofProviderIdentity !== binding.providerIdentity) return 'runtime-proof-provider-identity-mismatch';
  if (expectedBuildIdentity != null && binding.buildIdentity !== String(expectedBuildIdentity)) return 'runtime-build-identity-mismatch';
  if (proofBuildIdentity != null && String(proofBuildIdentity) !== binding.buildIdentity) return 'runtime-proof-build-identity-mismatch';
  return null;
}

export function createRuntimeAuthorityBinding(input = {}) {
  // The factory creates a new authority record.  A caller may spread an
  // existing record while advancing an epoch or replacing a session, so an
  // old schema/id pair is input metadata rather than an assertion here.
  return canonicalBinding({ ...input, schemaVersion: undefined, bindingId: undefined });
}

export function createRuntimeObservation(input = {}) {
  const binding = canonicalBinding(input.binding || input);
  const sequence = uint(input.sequence, 'runtime-observation-sequence-invalid');
  const observedAt = required(input.observedAt ?? input.timestamp, 'runtime-observation-timestamp-required');
  const observation = {
    schemaVersion: RUNTIME_OBSERVATION_SCHEMA,
    bindingId: binding.bindingId,
    providerIdentity: binding.providerIdentity,
    providerProfileId: binding.providerProfileId,
    providerVersion: binding.providerVersion,
    runtimeInstanceIdentity: binding.runtimeInstanceIdentity,
    targetIdentity: binding.targetIdentity,
    targetProfileId: binding.targetProfileId,
    architectureProfileId: binding.architectureProfileId,
    binaryIdentity: binding.binaryIdentity,
    buildIdentity: binding.buildIdentity,
    runtimeBuildIdentity: binding.runtimeBuildIdentity,
    moduleIdentity: binding.moduleIdentity,
    loadMappingIdentity: binding.loadMappingIdentity,
    sessionIdentity: binding.sessionIdentity,
    capabilityVersion: binding.capabilityVersion,
    commitSha: binding.commitSha,
    treeSha: binding.treeSha,
    epoch: binding.epoch,
    sequence,
    observedAt,
    kind: required(input.kind || 'observation', 'runtime-observation-kind-required'),
    payload: clone(input.payload ?? null),
    authority: 'runtime-evidence',
  };
  return deepFreeze({ ...observation, observationId: observationIdentity(observation) });
}

export function validateRuntimeObservation(bindingInput, observation, options = {}) {
  const binding = canonicalBinding(bindingInput || {}, { throwOnError: false });
  if (!binding) return { ok: false, reason: 'runtime-binding-identity-invalid' };
  if (!observation || typeof observation !== 'object' || observation.schemaVersion !== RUNTIME_OBSERVATION_SCHEMA) return { ok: false, reason: 'runtime-observation-schema-invalid' };
  if (observation.authority !== 'runtime-evidence') return { ok: false, reason: 'runtime-observation-authority-invalid' };
  const identityKeys = ['bindingId', 'providerIdentity', 'providerProfileId', 'providerVersion', 'runtimeInstanceIdentity', 'targetIdentity', 'targetProfileId', 'architectureProfileId', 'binaryIdentity', 'buildIdentity', 'runtimeBuildIdentity', 'moduleIdentity', 'loadMappingIdentity', 'sessionIdentity', 'capabilityVersion', 'commitSha', 'treeSha', 'epoch'];
  for (const key of identityKeys) {
    if (observation[key] !== binding[key]) return { ok: false, reason: `runtime-observation-${key}-mismatch`, expected: binding[key], observed: observation[key] };
  }
  if (typeof observation.sequence !== 'number' || !Number.isSafeInteger(observation.sequence) || observation.sequence < 0) return { ok: false, reason: 'runtime-observation-sequence-invalid' };
  if (typeof observation.observedAt !== 'string' || !observation.observedAt.trim()) return { ok: false, reason: 'runtime-observation-timestamp-required' };
  if (typeof observation.kind !== 'string' || !observation.kind.trim()) return { ok: false, reason: 'runtime-observation-kind-required' };
  if (observation.observationId !== observationIdentity(observation)) return { ok: false, reason: 'runtime-observation-identity-invalid' };
  const minimumSequence = options.minimumSequence == null ? 0 : uint(options.minimumSequence, 'runtime-minimum-sequence-invalid');
  if (observation.sequence < minimumSequence) return { ok: false, reason: 'runtime-observation-stale-sequence' };
  return { ok: true, binding, observation };
}

export class RuntimeAuthorityTracker {
  constructor(bindingInput, options = {}) {
    this.binding = canonicalBinding(bindingInput || {});
    this.lastSequence = -1;
    this.closed = false;
    this.maxObservations = boundedCount(options.maxObservations, 1024, 4096, 'runtime-max-observations-invalid');
    this.observations = [];
  }

  accept(input) {
    if (this.closed) return Object.freeze({ status: 'rejected', reason: 'runtime-tracker-closed' });
    let observation;
    try {
      observation = input?.schemaVersion === RUNTIME_OBSERVATION_SCHEMA ? input : createRuntimeObservation({ ...input, binding: this.binding });
    } catch (error) {
      return Object.freeze({ status: 'rejected', reason: error?.message || 'runtime-observation-invalid' });
    }
    const checked = validateRuntimeObservation(this.binding, observation, { minimumSequence: this.lastSequence + 1 });
    if (!checked.ok) return Object.freeze({ status: 'rejected', reason: checked.reason });
    this.lastSequence = observation.sequence;
    this.observations.push(observation);
    if (this.observations.length > this.maxObservations) this.observations.shift();
    return Object.freeze({ status: 'accepted', observationId: observation.observationId, sequence: observation.sequence });
  }

  authorizeMutation(input = {}) {
    if (this.closed) return Object.freeze({ status: 'rejected', reason: 'runtime-tracker-closed' });
    const bindingId = required(input.bindingId ?? this.binding.bindingId, 'runtime-mutation-binding-required');
    if (bindingId !== this.binding.bindingId) return Object.freeze({ status: 'rejected', reason: 'runtime-mutation-binding-mismatch' });
    if (input.explicitApproval !== true) return Object.freeze({ status: 'rejected', reason: 'runtime-mutation-explicit-approval-required' });
    const actorIdentity = required(input.actorIdentity, 'runtime-mutation-actor-required');
    const operation = required(input.operation, 'runtime-mutation-operation-required');
    const token = {
      schemaVersion: 'hex-runtime-mutation-authority/v1',
      bindingId,
      actorIdentity,
      operation,
      scope: clone(input.scope || {}),
      issuedAt: required(input.issuedAt, 'runtime-mutation-issued-at-required'),
      authority: 'explicit-local-runtime-mutation',
    };
    return Object.freeze({ status: 'authorized', token: deepFreeze({ ...token, tokenId: `runtime-mutation:${stableDigest(token)}` }) });
  }

  nextEpoch(bindingOverrides = {}) {
    const nextBinding = createRuntimeAuthorityBinding({ ...this.binding, ...bindingOverrides, epoch: this.binding.epoch + 1, sessionIdentity: bindingOverrides.sessionIdentity || this.binding.sessionIdentity });
    this.closed = true;
    return nextBinding;
  }

  snapshot() {
    return deepFreeze({ binding: this.binding, lastSequence: this.lastSequence, observations: [...this.observations] });
  }
}

export function runtimeProfileSupport({
  binding,
  providerProfileId = null,
  targetProfileId = null,
  providerCapabilities = {},
  requiredCapabilities = [],
  proof = {},
  expectedHeadSha = null,
  expectedTreeSha = null,
  expectedBuildIdentity = null,
  profileProof = null,
} = {}) {
  const canonical = canonicalBinding(binding || {}, { throwOnError: false });
  const hasBinding = canonical != null;
  const declared = capabilityList(requiredCapabilities);
  const missing = declared.filter((key) => providerCapabilities[key] !== true);
  const proofComplete = proof.exactHead === true
    && proof.identityNegativeTests === true
    && proof.staleEventTests === true
    && proof.lifecycleTests === true
    && proof.capabilityTests === true
    && proof.moduleMappingTests === true
    && proof.mutationAuthorityTests === true;
  const normalizedProviderProfileId = providerProfileId == null ? null : String(providerProfileId).trim();
  const normalizedTargetProfileId = targetProfileId == null ? null : String(targetProfileId).trim();
  let reason = null;
  if (!hasBinding) reason = 'runtime-binding-identity-invalid';
  else if (!normalizedProviderProfileId || !normalizedTargetProfileId) reason = 'runtime-profile-identity-required';
  else reason = mismatchReason(canonical, normalizedProviderProfileId, normalizedTargetProfileId, expectedBuildIdentity, proof);

  const managedMatch = normalizedTargetProfileId?.match(/^managed:(wasm|dex|cil|jvm):m6$/) || null;
  const profileItemId = managedMatch ? `S2-M6-${managedMatch[1].toUpperCase()}` : 'S2-A7-NATIVE';
  const profileEvidenceComplete = normalizedTargetProfileId
    && isValidatedStage2CapabilityProof(profileProof, { itemId: profileItemId, profileIds: [normalizedTargetProfileId] })
    && profileProof.commitSha === canonical?.commitSha
    && profileProof.treeSha === canonical?.treeSha;
  if (!reason && !profileEvidenceComplete) reason = 'runtime-profile-evidence-required';

  // A profile proof is only current when its head/tree agrees with both the
  // authority record and any caller-supplied expected revision.  A boolean
  // exactHead flag alone is not an identity.
  if (!reason && hasBinding) {
    const proofHeadSha = proof.headSha ?? proof.commitSha ?? null;
    const proofTreeSha = proof.treeSha ?? null;
    const expectedHead = expectedHeadSha ?? proof.expectedHeadSha ?? null;
    const expectedTree = expectedTreeSha ?? proof.expectedTreeSha ?? null;
    if (canonical.commitSha == null || canonical.treeSha == null || proofHeadSha == null || proofTreeSha == null) reason = 'runtime-proof-exact-identity-required';
    else if (String(proofHeadSha).toLowerCase() !== canonical.commitSha) reason = 'runtime-proof-stale-head';
    else if (String(proofTreeSha).toLowerCase() !== canonical.treeSha) reason = 'runtime-proof-stale-tree';
    else if (expectedHead != null && (canonical.commitSha !== String(expectedHead).toLowerCase() || String(proofHeadSha).toLowerCase() !== String(expectedHead).toLowerCase())) reason = 'runtime-proof-stale-head';
    else if (expectedTree != null && (canonical.treeSha !== String(expectedTree).toLowerCase() || String(proofTreeSha).toLowerCase() !== String(expectedTree).toLowerCase())) reason = 'runtime-proof-stale-tree';
  }
  const proven = hasBinding
    && declared.length > 0
    && missing.length === 0
    && proofComplete
    && !reason
    && canonical.buildIdentity != null;
  const result = Object.freeze({
    status: proven ? 'supported-for-exact-provider-profile' : hasBinding ? 'partial' : 'unavailable',
    bindingId: hasBinding ? canonical.bindingId : null,
    providerIdentity: hasBinding ? canonical.providerIdentity : null,
    providerProfileId: normalizedProviderProfileId || null,
    targetProfileId: normalizedTargetProfileId || null,
    requiredCapabilities: Object.freeze(declared),
    missingCapabilities: Object.freeze(missing),
    proofComplete,
    buildIdentity: hasBinding ? canonical.buildIdentity : null,
    commitSha: hasBinding ? canonical.commitSha : null,
    treeSha: hasBinding ? canonical.treeSha : null,
    reason,
    authority: proven ? 'runtime-evidence-bound' : 'none',
  });
  if (proven) VALID_RUNTIME_PROFILE_SUPPORT.add(result);
  return result;
}

export function isValidatedRuntimeProfileSupport(value) {
  return !!value && VALID_RUNTIME_PROFILE_SUPPORT.has(value) && value.status === 'supported-for-exact-provider-profile';
}

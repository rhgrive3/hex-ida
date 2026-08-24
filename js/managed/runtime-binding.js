import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { RUNTIME_AUTHORITY_SCHEMA, createRuntimeAuthorityBinding, isValidatedRuntimeProfileSupport, validateRuntimeObservation } from '../runtime/authority.js';

export const MANAGED_RUNTIME_BINDING_SCHEMA = 'hex-managed-runtime-binding/v1';
const FRONTENDS = new Set(['wasm', 'dex', 'cil', 'jvm']);
const MANAGED_RUNTIME_PROVIDER_PROFILE_VERSION = 'provider-bound-runtime-v1';
const VALID_MANAGED_RUNTIME_SUPPORT = new WeakSet();

// Keep this denominator at the managed boundary.  The generic runtime
// authority can validate an arbitrary capability subset, but M6 cannot be
// promoted from a proof that silently omitted one of the managed debugger
// operations.
export const MANAGED_RUNTIME_REQUIRED_CAPABILITIES = Object.freeze([
  'backtrace', 'cancel', 'connect', 'disconnect', 'modules', 'pause',
  'readMemory', 'readRegisters', 'resume', 'stepInto', 'threads',
]);

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

function boundedCount(value, fallback, max, code) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError(code);
  return n;
}

export function managedRuntimeTargetProfileId(frontendId) {
  const id = required(frontendId, 'managed-runtime-frontend-required').toLowerCase();
  if (!FRONTENDS.has(id)) throw new TypeError('managed-runtime-frontend-unsupported');
  return `managed:${id}:m6`;
}

export function managedRuntimeProviderProfileId(frontendId) {
  const id = required(frontendId, 'managed-runtime-frontend-required').toLowerCase();
  if (!FRONTENDS.has(id)) throw new TypeError('managed-runtime-frontend-unsupported');
  return `managed:${id}:${MANAGED_RUNTIME_PROVIDER_PROFILE_VERSION}`;
}

function includesAll(values, expected) {
  const set = new Set(Array.isArray(values) ? values.map(String) : []);
  return expected.every((item) => set.has(item));
}

function runtimeBindingPayload(runtime) {
  if (!runtime || typeof runtime !== 'object' || runtime.schemaVersion !== RUNTIME_AUTHORITY_SCHEMA) return null;
  const { bindingId, ...payload } = runtime;
  return { bindingId, payload };
}

function isManagedRuntimeBinding(binding) {
  if (!binding || typeof binding !== 'object' || binding.schemaVersion !== MANAGED_RUNTIME_BINDING_SCHEMA) return false;
  let expectedTarget;
  try {
    expectedTarget = managedRuntimeTargetProfileId(binding.frontendId);
  } catch {
    return false;
  }
  if (binding.targetProfileId !== expectedTarget) return false;
  if (typeof binding.staticModuleIdentity !== 'string' || typeof binding.runtimeModuleIdentity !== 'string') return false;
  if (!binding.staticModuleIdentity || binding.staticModuleIdentity !== binding.runtimeModuleIdentity) return false;
  if (!binding.runtime || binding.runtime.moduleIdentity !== binding.runtimeModuleIdentity) return false;

  const runtimeIdentity = runtimeBindingPayload(binding.runtime);
  if (!runtimeIdentity || runtimeIdentity.bindingId !== `runtime-binding:${stableDigest(runtimeIdentity.payload)}`) return false;

  const { bindingId, ...payload } = binding;
  return bindingId === `managed-runtime:${stableDigest(payload)}`;
}

export function createManagedRuntimeBinding(input = {}) {
  const frontendId = required(input.frontendId, 'managed-runtime-frontend-required').toLowerCase();
  if (!FRONTENDS.has(frontendId)) throw new TypeError('managed-runtime-frontend-unsupported');
  const targetProfileId = managedRuntimeTargetProfileId(frontendId);
  const providerProfileId = managedRuntimeProviderProfileId(frontendId);
  if (input.providerProfileId != null && required(input.providerProfileId, 'managed-runtime-provider-profile-required') !== providerProfileId) {
    throw new TypeError('managed-runtime-provider-profile-mismatch');
  }
  const buildIdentity = required(input.buildIdentity, 'managed-runtime-build-identity-required');
  const staticModuleIdentity = required(input.staticModuleIdentity, 'managed-runtime-static-module-required');
  const runtimeModuleIdentity = required(input.runtimeModuleIdentity, 'managed-runtime-module-required');
  if (staticModuleIdentity !== runtimeModuleIdentity) throw new TypeError('managed-runtime-module-identity-mismatch');
  const runtime = createRuntimeAuthorityBinding({
    providerIdentity: input.providerIdentity,
    providerProfileId,
    providerVersion: input.providerVersion ?? input.runtimeVersion,
    runtimeInstanceIdentity: input.runtimeInstanceIdentity,
    targetIdentity: input.targetIdentity,
    targetProfileId,
    binaryIdentity: input.binaryIdentity,
    buildIdentity,
    moduleIdentity: runtimeModuleIdentity,
    loadMappingIdentity: input.loadMappingIdentity,
    sessionIdentity: input.sessionIdentity,
    capabilityVersion: input.capabilityVersion,
    commitSha: input.commitSha,
    treeSha: input.treeSha,
    epoch: input.epoch ?? 0,
  });
  const binding = {
    schemaVersion: MANAGED_RUNTIME_BINDING_SCHEMA,
    frontendId,
    targetProfileId,
    runtimeImplementation: required(input.runtimeImplementation, 'managed-runtime-implementation-required'),
    runtimeVersion: required(input.runtimeVersion, 'managed-runtime-version-required'),
    staticModuleIdentity,
    runtimeModuleIdentity,
    runtime,
    maxThreads: boundedCount(input.maxThreads, 256, 4096, 'managed-runtime-max-threads-invalid'),
    maxFramesPerThread: boundedCount(input.maxFramesPerThread, 1024, 16384, 'managed-runtime-max-frames-invalid'),
    maxLocalsPerFrame: boundedCount(input.maxLocalsPerFrame, 4096, 65536, 'managed-runtime-max-locals-invalid'),
    maxOperandStack: boundedCount(input.maxOperandStack, 4096, 65536, 'managed-runtime-max-stack-invalid'),
  };
  return deepFreeze({ ...binding, bindingId: `managed-runtime:${stableDigest(binding)}` });
}

export function validateManagedRuntimeState(binding, state = {}) {
  if (!isManagedRuntimeBinding(binding)) return { ok: false, reason: 'managed-runtime-binding-invalid' };
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, reason: 'managed-runtime-state-invalid' };
  if (!Array.isArray(state.threads)) return { ok: false, reason: 'managed-runtime-threads-required' };
  const threads = state.threads;
  if (threads.length > binding.maxThreads) return { ok: false, reason: 'managed-runtime-thread-budget-exceeded' };
  for (const thread of threads) {
    if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return { ok: false, reason: 'managed-runtime-thread-invalid' };
    const frames = Array.isArray(thread?.frames) ? thread.frames : [];
    if (frames.length > binding.maxFramesPerThread) return { ok: false, reason: 'managed-runtime-frame-budget-exceeded' };
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return { ok: false, reason: 'managed-runtime-frame-invalid' };
      if (frame.moduleIdentity == null || String(frame.moduleIdentity).trim() === '') return { ok: false, reason: 'managed-runtime-frame-module-required' };
      if (String(frame.moduleIdentity) !== binding.runtimeModuleIdentity) return { ok: false, reason: 'managed-runtime-frame-module-mismatch' };
      if ((Array.isArray(frame.locals) ? frame.locals.length : 0) > binding.maxLocalsPerFrame) return { ok: false, reason: 'managed-runtime-local-budget-exceeded' };
      if ((Array.isArray(frame.operandStack) ? frame.operandStack.length : 0) > binding.maxOperandStack) return { ok: false, reason: 'managed-runtime-stack-budget-exceeded' };
    }
  }
  return { ok: true, threads };
}

export function validateManagedRuntimeObservation(binding, observation, options = {}) {
  if (!isManagedRuntimeBinding(binding)) return { ok: false, reason: 'managed-runtime-binding-invalid' };
  const runtime = validateRuntimeObservation(binding.runtime, observation, options);
  if (!runtime.ok) return runtime;
  if (!observation || typeof observation.payload !== 'object' || observation.payload == null || Array.isArray(observation.payload)) {
    return { ok: false, reason: 'managed-runtime-observation-payload-invalid' };
  }
  if (observation.payload.moduleIdentity == null || String(observation.payload.moduleIdentity).trim() === '') {
    return { ok: false, reason: 'managed-runtime-observation-module-required' };
  }
  if (String(observation.payload.moduleIdentity) !== binding.runtimeModuleIdentity) {
    return { ok: false, reason: 'managed-runtime-observation-module-mismatch' };
  }
  const { observationId, ...payload } = observation;
  if (observationId !== `runtime-observation:${stableDigest(payload)}`) {
    return { ok: false, reason: 'managed-runtime-observation-tampered' };
  }
  return { ok: true, observation };
}

export function managedRuntimeProfileSupport({ binding, runtimeProfileProof = null, proof = {} } = {}) {
  const valid = isManagedRuntimeBinding(binding);
  const runtimeBound = valid
    && isValidatedRuntimeProfileSupport(runtimeProfileProof)
    && runtimeProfileProof?.status === 'supported-for-exact-provider-profile'
    && runtimeProfileProof?.bindingId === binding.runtime.bindingId
    && runtimeProfileProof?.targetProfileId === binding.targetProfileId
    && runtimeProfileProof?.providerProfileId === managedRuntimeProviderProfileId(binding.frontendId)
    && runtimeProfileProof?.providerIdentity === binding.runtime.providerIdentity
    && (runtimeProfileProof?.frontendId == null || runtimeProfileProof.frontendId === binding.frontendId)
    && includesAll(runtimeProfileProof?.requiredCapabilities, MANAGED_RUNTIME_REQUIRED_CAPABILITIES)
    && runtimeProfileProof?.buildIdentity === binding.runtime.buildIdentity
    && runtimeProfileProof?.commitSha === binding.runtime.commitSha
    && runtimeProfileProof?.treeSha === binding.runtime.treeSha
    && Array.isArray(runtimeProfileProof?.missingCapabilities)
    && runtimeProfileProof.missingCapabilities.length === 0;
  const proofComplete = valid
    && proof.exactHead === true
    && proof.identityNegativeTests === true
    && proof.staleEventTests === true
    && proof.stateBudgetTests === true
    && proof.runtimeDisagreementPreservesStaticTruth === true
    && proof.frontendProviderTests === true
    && proof.profileDenominatorComplete === true;
  const proven = valid && runtimeBound && proofComplete;
  const result = Object.freeze({
    frontendId: valid ? binding.frontendId : null,
    targetProfileId: valid ? binding.targetProfileId : null,
    runtimeImplementation: valid ? binding.runtimeImplementation : null,
    runtimeVersion: valid ? binding.runtimeVersion : null,
    runtimeBindingId: valid ? binding.runtime.bindingId : null,
    providerProfileId: runtimeBound ? runtimeProfileProof.providerProfileId : null,
    proofComplete,
    status: proven ? 'supported-for-exact-provider-profile' : valid ? 'partial' : 'unavailable',
    authority: proven ? 'runtime-evidence-bound' : 'none',
  });
  if (proven) VALID_MANAGED_RUNTIME_SUPPORT.add(result);
  return result;
}

export function isValidatedManagedRuntimeProfileSupport(value) {
  return !!value && VALID_MANAGED_RUNTIME_SUPPORT.has(value) && value.status === 'supported-for-exact-provider-profile';
}

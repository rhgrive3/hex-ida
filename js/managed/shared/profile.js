import { deepFreeze, stableDigest, stableStringify } from '../../core/identity/index.js';
import { createManagedTargetProfileId } from './identity.js';

export const MANAGED_FRONTEND_IDS = Object.freeze(['wasm', 'dex', 'cil', 'jvm']);
const FRONTEND_SET = new Set(MANAGED_FRONTEND_IDS);

function fail(code) { throw new TypeError(code); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}
function textOrIndex(value, code) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(code);
    return String(value);
  }
  return nonEmpty(value, code);
}
function sortedUniqueStrings(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail('managed-profile-invalid-feature-set');
  return [...new Set(values.map((value) => nonEmpty(value, 'managed-profile-invalid-feature')))].sort();
}

export function createManagedTargetProfile(input) {
  input = object(input, 'managed-profile-invalid-input');
  const frontendId = nonEmpty(input.frontendId, 'managed-profile-frontend-id-required').toLowerCase();
  if (!FRONTEND_SET.has(frontendId)) fail('managed-profile-unsupported-frontend');

  const frontendSemanticVersion = nonEmpty(input.frontendSemanticVersion ?? '1.0.0', 'managed-profile-version-required');
  const formatVersion = textOrIndex(input.formatVersion ?? '1', 'managed-profile-format-version-required');
  const vmSpecEdition = textOrIndex(input.vmSpecEdition ?? 'default', 'managed-profile-spec-edition-required');
  const featureSet = sortedUniqueStrings(input.featureSet);
  const runtimeVersionHint = input.runtimeVersionHint == null
    ? null
    : nonEmpty(input.runtimeVersionHint, 'managed-profile-runtime-version-hint-invalid');
  const validationPolicy = nonEmpty(input.validationPolicy ?? 'strict', 'managed-profile-validation-policy-required');
  
  const options = input.options ? input.options : {};
  const decodingOptionsHash = stableDigest(options);
  // All identity-defining semantic configuration participates in the
  // canonical id (#5401): feature set, validation policy, decoding options,
  // runtime hint and frontend semantic version are part of the identity
  // denominator, so semantically different profiles cannot collide.
  const semanticTail = {
    frontendSemanticVersion,
    featureSet,
    runtimeVersionHint,
    validationPolicy,
    decodingOptionsHash,
  };
  const id = createManagedTargetProfileId(frontendId, formatVersion, vmSpecEdition, semanticTail);

  return deepFreeze({
    id,
    frontendId,
    frontendSemanticVersion,
    formatVersion,
    vmSpecEdition,
    featureSet,
    runtimeVersionHint,
    validationPolicy,
    decodingOptionsHash,
  });
}

export function validateManagedTargetProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) fail('managed-profile-invalid');
  if (typeof profile.frontendId !== 'string' || !FRONTEND_SET.has(profile.frontendId)) {
    fail('managed-profile-unsupported-frontend');
  }
  if (!profile.id || typeof profile.id !== 'string') fail('managed-profile-missing-id');

  // A validating profile must have the same required canonical shape emitted
  // by createManagedTargetProfile(). Do not substitute constructor defaults
  // while validating published identity (#5296): an under-specified object
  // must fail before identity re-derivation.
  if (typeof profile.frontendSemanticVersion !== 'string' || !profile.frontendSemanticVersion.trim()) {
    fail('managed-profile-invalid-version');
  }
  if (typeof profile.formatVersion !== 'string' || !profile.formatVersion.trim()) {
    fail('managed-profile-invalid-format-version');
  }
  if (typeof profile.vmSpecEdition !== 'string' || !profile.vmSpecEdition.trim()) {
    fail('managed-profile-invalid-spec-edition');
  }
  if (!Array.isArray(profile.featureSet)) fail('managed-profile-invalid-feature-set');
  const canonicalFeatureSet = sortedUniqueStrings(profile.featureSet);
  if (canonicalFeatureSet.length !== profile.featureSet.length
      || canonicalFeatureSet.some((value, index) => value !== profile.featureSet[index])) {
    fail('managed-profile-invalid-feature-set');
  }
  if (profile.runtimeVersionHint != null
      && (typeof profile.runtimeVersionHint !== 'string' || !profile.runtimeVersionHint.trim())) {
    fail('managed-profile-runtime-version-hint-invalid');
  }
  if (typeof profile.validationPolicy !== 'string' || !profile.validationPolicy.trim()) {
    fail('managed-profile-invalid-validation-policy');
  }
  if (typeof profile.decodingOptionsHash !== 'string' || !profile.decodingOptionsHash.trim()) {
    fail('managed-profile-invalid-options-hash');
  }

  // The published id must be the canonical identity of the validated
  // published content, so a tampered or stale id cannot alias a different
  // configuration (#5401/#5296).
  const semanticTail = {
    frontendSemanticVersion: profile.frontendSemanticVersion,
    featureSet: canonicalFeatureSet,
    runtimeVersionHint: profile.runtimeVersionHint ?? null,
    validationPolicy: profile.validationPolicy,
    decodingOptionsHash: profile.decodingOptionsHash,
  };
  const canonicalId = createManagedTargetProfileId(
    profile.frontendId,
    profile.formatVersion,
    profile.vmSpecEdition,
    semanticTail,
  );
  if (profile.id !== canonicalId) fail('managed-profile-identity-mismatch');
  return true;
}

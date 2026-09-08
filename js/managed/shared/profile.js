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
  const id = createManagedTargetProfileId(frontendId, formatVersion, vmSpecEdition);

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
  if (!profile || typeof profile !== 'object') fail('managed-profile-invalid');
  if (typeof profile.frontendId !== 'string' || !FRONTEND_SET.has(profile.frontendId)) {
    fail('managed-profile-unsupported-frontend');
  }
  if (!profile.id || typeof profile.id !== 'string') fail('managed-profile-missing-id');
  if (profile.frontendSemanticVersion !== undefined
      && (typeof profile.frontendSemanticVersion !== 'string' || !profile.frontendSemanticVersion.trim())) {
    fail('managed-profile-invalid-version');
  }
  if (profile.formatVersion !== undefined
      && (typeof profile.formatVersion !== 'string' || !profile.formatVersion.trim())) {
    fail('managed-profile-invalid-format-version');
  }
  if (profile.vmSpecEdition !== undefined
      && (typeof profile.vmSpecEdition !== 'string' || !profile.vmSpecEdition.trim())) {
    fail('managed-profile-invalid-spec-edition');
  }
  if (profile.featureSet !== undefined
      && (!Array.isArray(profile.featureSet)
        || profile.featureSet.some((value) => typeof value !== 'string' || !value.trim()))) {
    fail('managed-profile-invalid-feature-set');
  }
  if (profile.runtimeVersionHint != null
      && (typeof profile.runtimeVersionHint !== 'string' || !profile.runtimeVersionHint.trim())) {
    fail('managed-profile-runtime-version-hint-invalid');
  }
  if (profile.validationPolicy !== undefined
      && (typeof profile.validationPolicy !== 'string' || !profile.validationPolicy.trim())) {
    fail('managed-profile-invalid-validation-policy');
  }
  if (profile.decodingOptionsHash !== undefined
      && (typeof profile.decodingOptionsHash !== 'string' || !profile.decodingOptionsHash.trim())) {
    fail('managed-profile-invalid-options-hash');
  }
  return true;
}

import { deepFreeze } from '../core/identity/index.js';
import { validateProviderOutput } from './package-envelope.js';

// Provider output becomes L1 external evidence: the validated object must be a
// detached immutable snapshot. deepFreeze alone cannot stop Map/Set/TypedArray
// internals from mutating afterwards, so cloneable values are detached before
// exposure and unclonable values fail closed rather than retaining provider
// ownership (#7127).
function detachedFrozenValue(value) {
  if (value == null || typeof value !== 'object') return value;
  let clone;
  try {
    clone = structuredClone(value);
  } catch {
    throw new TypeError('provider-output-unclonable');
  }
  return deepFreeze(clone);
}

/** Validate provider data before it can become an ArtifactStore candidate. */
export function validatePhase12ProviderResult(result, options = {}) {
  const checked = validateProviderOutput(result, options);
  if (!checked.ok) return checked;
  try {
    return { ok: true, value: detachedFrozenValue({ ...checked.value, authority: 'L1-external-evidence', textIsUntrustedData: true, persisted: false }) };
  } catch (error) {
    return { ok: false, error: error?.message || 'provider-output-unclonable', code: 'provider-output-unclonable' };
  }
}

export function providerFailure(result) {
  return Object.freeze({ status: 'rejected', reason: result?.code || result?.error || 'provider-output-invalid', authority: 'none', persisted: false });
}

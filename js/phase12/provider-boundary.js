import { deepFreeze } from '../core/identity/index.js';
import { validateProviderOutput } from './package-envelope.js';

// Provider output becomes L1 external evidence: the validated object must be a
// detached immutable snapshot. deepFreeze alone cannot stop Map/Set/TypedArray
// internals from mutating afterwards, which let a provider inflate a small
// validated result past maxBytes post-validation (#7127) — so the value is
// structured-cloned (detaching every keyed/buffered collection) before the
// plain-data tree is frozen.
function detachedFrozenValue(value) {
  if (value == null || typeof value !== 'object') return value;
  let clone;
  try {
    clone = structuredClone(value);
  } catch {
    deepFreeze(value);
    return value;
  }
  deepFreeze(clone);
  return clone;
}

/** Validate provider data before it can become an ArtifactStore candidate. */
export function validatePhase12ProviderResult(result, options = {}) {
  const checked = validateProviderOutput(result, options);
  if (!checked.ok) return checked;
  return { ok: true, value: detachedFrozenValue({ ...checked.value, authority: 'L1-external-evidence', textIsUntrustedData: true, persisted: false }) };
}

export function providerFailure(result) {
  return Object.freeze({ status: 'rejected', reason: result?.code || result?.error || 'provider-output-invalid', authority: 'none', persisted: false });
}

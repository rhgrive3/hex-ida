import { stableStringify } from '../../core/identity/index.js';

const sealedEnvelopes = new WeakMap();

function digestOrNone(records) {
  try {
    return stableStringify(records);
  } catch {
    return null;
  }
}

export function sealPersistedConfirmedEnvelope(records) {
  if (!Array.isArray(records)) return records;
  const digest = digestOrNone(records);
  if (digest !== null) sealedEnvelopes.set(records, digest);
  return records;
}

export function isPersistedConfirmedEnvelope(value) {
  if (!Array.isArray(value)) return false;
  const digest = sealedEnvelopes.get(value);
  if (digest === undefined) return false;
  return digestOrNone(value) === digest;
}

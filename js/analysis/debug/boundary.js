/** Shared fail-closed validation for the public DWARF/PDB provider boundary. */
export function assertDebugPageCursor(cursor) {
  if (cursor == null) return;
  if (typeof cursor !== 'string' || !/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new TypeError('debug-page-cursor-invalid');
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new TypeError('debug-page-cursor-invalid');
}

/**
 * Canonicalizes a PE CodeView identity only after validating its authority-bearing
 * components. Malformed structured values become unavailable rather than being
 * laundered through String()/template-literal coercion.
 */
export function normalizeCodeViewIdentity(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.guid !== 'string') return null;
  const guid = value.guid.trim();
  if (!guid) return null;
  if (typeof value.age !== 'number' || !Number.isSafeInteger(value.age) || value.age < 0) return null;
  return Object.freeze({ ...value, guid: guid.toUpperCase(), age: value.age });
}

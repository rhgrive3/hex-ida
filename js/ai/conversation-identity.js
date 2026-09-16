// Canonical conversation identity for the AI session/memory/job boundary
// (#8769). A conversation key used for binding or ownership must already be a
// primitive non-empty string: structured values (arrays, objects with a
// custom toString(), numbers, booleans) must never be laundered into a
// legitimate chat's key through generic String() coercion.

export function isCanonicalConversationId(value) {
  return typeof value === 'string' && value.length > 0;
}

export function canonicalConversationId(value, label = 'conversationId') {
  if (value == null) return null;
  if (!isCanonicalConversationId(value)) {
    throw new TypeError(`AI ${label} must be null or a non-empty primitive string`);
  }
  return value;
}

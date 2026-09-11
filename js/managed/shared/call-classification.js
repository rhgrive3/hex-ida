const EXTERNAL_DISPATCH_KINDS = new Set([
  'external',
  'host-import',
  'jni-native',
  'native',
  'pinvoke',
]);

const EXTERNAL_TARGET_PREFIXES = Object.freeze([
  'host:',
  'host-import:',
  'import:',
  'jni:',
  'jni-native:',
  'native:',
  'pinvoke:',
]);

function canonicalText(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null;
  return value.toLowerCase();
}

export function isManagedExternalCall(targetEntityIds, dispatchKind) {
  const kind = canonicalText(dispatchKind);
  if (kind && EXTERNAL_DISPATCH_KINDS.has(kind)) return true;
  if (!Array.isArray(targetEntityIds)) return false;
  return targetEntityIds.some((target) => {
    const identity = canonicalText(target);
    return identity != null && EXTERNAL_TARGET_PREFIXES.some((prefix) => identity.startsWith(prefix));
  });
}

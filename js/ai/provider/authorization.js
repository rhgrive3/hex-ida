const MAX_AI_AUTHORIZATION_CHARS = 4096;

export function canonicalAIProviderAuthorization(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_AI_AUTHORIZATION_CHARS || value !== value.trim()) {
    throw new TypeError('ai-provider-authorization-invalid');
  }
  return value;
}

export function readAIProviderAuthorization(explicit = undefined, globalRef = globalThis) {
  if (explicit !== undefined) return canonicalAIProviderAuthorization(explicit);
  let live;
  try { live = globalRef?.__HEX_AI_AUTHORIZATION__; } catch { return null; }
  return canonicalAIProviderAuthorization(live);
}

export function authorizedAIFetch(fetchImpl, explicit = undefined, globalRef = globalThis) {
  if (typeof fetchImpl !== 'function') return fetchImpl;
  return (url, init = {}) => {
    const token = readAIProviderAuthorization(explicit, globalRef);
    if (!token) return fetchImpl(url, init);
    const headers = new Headers(init.headers || {});
    headers.set('authorization', `Bearer ${token}`);
    return fetchImpl(url, { ...init, headers });
  };
}

export function aiAuthorizationHeaders(explicit = undefined, globalRef = globalThis) {
  const token = readAIProviderAuthorization(explicit, globalRef);
  return token ? { authorization: `Bearer ${token}` } : {};
}

export const AI_CAPABILITY_HEADER = 'x-hex-ai-capability';
export const AI_CAPABILITY_AUDIENCE = 'hex-ai-provider';
export const AI_CAPABILITY_TTL_MS = 60_000;

const BUILD_ID = /^[A-Za-z0-9._~-]{8,128}$/;
const SUBJECT = /^[a-f0-9]{64}$/;

export async function mintAICapability({ signingKey, buildId, subject, now = Date.now(), sessionExpiresAt = Infinity } = {}) {
  const key = normalizeKey(signingKey);
  if (!key || !BUILD_ID.test(String(buildId || '')) || !SUBJECT.test(String(subject || ''))) throw new TypeError('ai-capability-config-invalid');
  const issuedAt = Math.floor(Number(now) / 1000);
  const expiryMs = Math.min(Number(now) + AI_CAPABILITY_TTL_MS, Number(sessionExpiresAt));
  const expiresAt = Math.floor(expiryMs / 1000);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw new TypeError('ai-capability-session-expired');
  const nonce = new Uint8Array(16); crypto.getRandomValues(nonce);
  const sessionBinding = encodeBase64URL((await hmac(`session:${subject}`, key)).slice(0, 16));
  const payload = {
    v: 1,
    aud: AI_CAPABILITY_AUDIENCE,
    bid: String(buildId),
    sid: sessionBinding,
    iat: issuedAt,
    exp: expiresAt,
    jti: encodeBase64URL(nonce),
  };
  const encoded = encodeBase64URL(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmac(encoded, key);
  return { capability: `${encoded}.${encodeBase64URL(signature)}`, expiresAt: expiresAt * 1000 };
}

export async function verifyAICapability(value, { signingKey, buildId, now = Date.now() } = {}) {
  const key = normalizeKey(signingKey);
  if (!key || !BUILD_ID.test(String(buildId || '')) || typeof value !== 'string' || value.length > 2048) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let actual;
  try { actual = decodeBase64URL(parts[1]); } catch { return null; }
  const expected = await hmac(parts[0], key);
  if (!constantTimeBytes(expected, actual)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64URL(parts[0])));
    const nowSeconds = Math.floor(Number(now) / 1000);
    if (payload?.v !== 1 || payload.aud !== AI_CAPABILITY_AUDIENCE || payload.bid !== buildId) return null;
    if (!/^[A-Za-z0-9_-]{22}$/.test(String(payload.sid || '')) || typeof payload.jti !== 'string' || payload.jti.length < 16 || payload.jti.length > 64) return null;
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp <= nowSeconds || payload.iat > nowSeconds + 5 || payload.exp - payload.iat > Math.ceil(AI_CAPABILITY_TTL_MS / 1000)) return null;
    return payload;
  } catch { return null; }
}

function normalizeKey(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 32) return null;
  return value;
}
async function hmac(value, rawKey) {
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(value))));
}
function constantTimeBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0;
}
function encodeBase64URL(bytes) {
  let binary = ''; for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}
function decodeBase64URL(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(value || ''))) throw new TypeError('invalid-base64url');
  const raw = String(value).replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(raw + '='.repeat((4 - raw.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

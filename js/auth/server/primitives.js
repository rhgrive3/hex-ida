export const SESSION_COOKIE = '__Host-hex_session';
export const OAUTH_COOKIE = '__Host-hex_oauth';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TRANSACTION_TTL_MS = 10 * 60 * 1000;
export const PROOF_TTL_MS = 2 * 60 * 1000;
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
export const MAX_BODY_BYTES = 8192;
export class AuthError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function randomSecret() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function equalHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
export function discordId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{16,19}$/.test(value) || BigInt(value) > 18446744073709551615n) throw new AuthError('invalid-discord-id');
  return value;
}
export function secret(value) {
  if (typeof value !== 'string' || !SECRET_RE.test(value)) throw new AuthError('invalid-proof', 401);
  return value;
}
export function objectShape(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new AuthError('invalid-input');
  return value;
}
export async function readTextBounded(response, maxBytes = MAX_BODY_BYTES, signal = null) {
  const size = response.headers.get('content-length');
  if (size && (!/^\d+$/.test(size) || Number(size) > maxBytes)) throw new AuthError('body-too-large', 413);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks = []; let count = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new AuthError('request-timeout', 504);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new AuthError('request-timeout', 504);
      if (done) break;
      count += value.byteLength;
      if (count > maxBytes) throw new AuthError('body-too-large', 413);
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(count); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AuthError('invalid-encoding'); }
}
export async function deadline(operation, ms, code = 'request-timeout') {
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AuthError(code, 504)); }, ms); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}
export async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new AuthError('json-required', 415);
  const text = await deadline((signal) => readTextBounded(request, MAX_BODY_BYTES, signal), 5000);
  try { return JSON.parse(text); } catch { throw new AuthError('invalid-json'); }
}
export function cookieValue(request, name) {
  const matches = (request.headers.get('cookie') || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  return matches[0].slice(name.length + 1);
}
export function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function headers(extra = {}) {
  return { 'cache-control': 'private, no-store', 'pragma': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-origin', ...extra };
}
export function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: headers({ 'content-type': 'application/json; charset=utf-8', ...extra }) });
}
export function requireMethod(request, methods) {
  if (!methods.includes(request.method)) throw new AuthError('method-not-allowed', 405);
}
export function requireSameOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new AuthError('origin-not-allowed', 403);
}

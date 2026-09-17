import { DurableObject } from 'cloudflare:workers';
import worker from './worker.js';
import { AI_QUOTA, acquireQuotaState, releaseQuotaState } from './js/ai/quota.js';
import { RUNTIME_BUILD } from './.runtime-build/runtime-secrets.js';
import { PRIVILEGED_BUILD } from './.runtime-build/privileged-assets.js';
import { createAuthHandler } from './js/auth/server/router.js';
import { AI_CAPABILITY_HEADER, verifyAICapability } from './js/auth/server/ai-capability.js';
import { DEPLOYMENT_COMMIT } from './js/userscript/deployment-identity.generated.js';
import { CHATGPT_ORIGINS, isAllowedRequestOrigin } from './js/userscript/request-origin-policy.js';
import {
  decodeBase64URL, encodeBase64URL, publicRuntimeManifest,
  signRuntimeSession, validateRuntimeBootstrap, verifyRuntimeSession,
} from './js/userscript/runtime-security.js';
import {
  RUNTIME_BOOTSTRAP_ADMISSION,
  abortRuntimeBootstrapIssuance,
  beginRuntimeBootstrapIssuance,
  consumeRuntimeBootstrapSession,
  finishRuntimeBootstrapIssuance,
  pruneRuntimeBootstrapState,
} from './js/userscript/runtime-bootstrap-admission.js';

const AI_CAPABILITY_SIGNING_KEY = runtimeAICapabilitySigningKey();
const handleAuth = createAuthHandler({
  privileged: PRIVILEGED_BUILD,
  aiCapability: AI_CAPABILITY_SIGNING_KEY ? { signingKey: AI_CAPABILITY_SIGNING_KEY, buildId: RUNTIME_BUILD.manifest.buildId } : null,
});
const QUOTA_STATE_KEY = 'quota';
const USER_SCRIPT_TEMPLATE = '/userscript/hex.user.template.js';
const BOOTSTRAP_MAX_BYTES = 16 * 1024;
const SESSION_TTL_MS = 2 * 60 * 1000;
const PRIVATE_PREFIXES = ['/.runtime-build/', '/migrations/', '/.wrangler/', '/.git/', '/node_modules/', '/auth-assets/', '/.runtime/', '/userscript-assets/', '/js/', '/css/', '/scripts/', '/tests/', '/.github/', '/userscript/'];
const PRIVATE_FILES = new Set(['/package.json', '/package-lock.json', '/worker-entry.js', '/worker.js', '/wrangler.jsonc']);

export class AIQuota extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; }
  async acquire(input = {}) {
    const token = crypto.randomUUID();
    const previous = await this.ctx.storage.get(QUOTA_STATE_KEY);
    const { state, result } = acquireQuotaState(previous, { now: Date.now(), token, sessionId: input.sessionId }, AI_QUOTA);
    await this.ctx.storage.put(QUOTA_STATE_KEY, state); return result;
  }
  async release(token) {
    const previous = await this.ctx.storage.get(QUOTA_STATE_KEY);
    const { state, released } = releaseQuotaState(previous, token, Date.now(), AI_QUOTA);
    await this.ctx.storage.put(QUOTA_STATE_KEY, state); return { released };
  }
}

export class RuntimeBootstrap extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; }
  async beginIssue(input) {
    const now = Date.now();
    const result = await beginRuntimeBootstrapIssuance(this.ctx.storage, input, { now });
    if (!result.ok) return result;
    try {
      await scheduleRuntimeBootstrapCleanup(this.ctx.storage, Math.min(input.expiry, result.leaseExpiry));
      return result;
    } catch {
      // Never publish a lease whose eventual cleanup cannot be scheduled. The
      // rate counter remains charged, but provisional nonce/session/lease rows
      // are rolled back before the caller can start expensive crypto work.
      await abortRuntimeBootstrapIssuance(this.ctx.storage, { leaseId: result.leaseId, sessionId: input.sessionId });
      return { ok: false, reason: 'bootstrap-cleanup-scheduling-failed' };
    }
  }
  async finishIssue(input) {
    return finishRuntimeBootstrapIssuance(this.ctx.storage, { ...input, now: Date.now() });
  }
  async abortIssue(input) {
    return abortRuntimeBootstrapIssuance(this.ctx.storage, input);
  }
  async consume(input) {
    return consumeRuntimeBootstrapSession(this.ctx.storage, { ...input, now: Date.now() });
  }
  async prune(options = {}) {
    return pruneRuntimeBootstrapState(this.ctx.storage, {
      now: options.now ?? Date.now(),
      maxPagesPerPrefix: options.maxPagesPerPrefix ?? RUNTIME_BOOTSTRAP_ADMISSION.requestSweepPages,
    });
  }
  async alarm() {
    const now = Date.now();
    const result = await this.prune({ now, maxPagesPerPrefix: RUNTIME_BOOTSTRAP_ADMISSION.alarmSweepPages });
    if (result.more) await scheduleRuntimeBootstrapCleanup(this.ctx.storage, now + 1000, true);
    else if (result.earliestExpiry != null) await scheduleRuntimeBootstrapCleanup(this.ctx.storage, Math.max(now + 1000, result.earliestExpiry), true);
  }
}

export default {
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url);
    if (url.pathname.includes('%')) {
      let decoded; try { decoded = decodeURIComponent(url.pathname); } catch { return new Response('Not Found', { status: 404 }); }
      if (decoded !== url.pathname && (isPrivatePath(decoded) || /^\/(?:admin|auth|_privileged|api\/(?:admin|auth))(?:\/|$)/.test(decoded))) return new Response('Not Found', { status: 404, headers: securityHeaders() });
    }
    const authResponse = await handleAuth(request, env);
    if (authResponse) return authResponse;
    if (url.pathname === '/hex.user.js') return serveUserscript(request, env, url, false);
    if (url.pathname === '/hex.meta.js') return serveUserscript(request, env, url, true);
    if (url.pathname === '/embed/chatgpt') return serveChatGPTEmbed(request, env, url);
    if (url.pathname === '/runtime/bootstrap') return runtimeBootstrap(request, env, url);
    if (url.pathname.startsWith('/_runtime/')) return protectedRuntime(request, env, url);
    if (isPrivatePath(url.pathname)) return new Response('Not Found', { status: 404, headers: securityHeaders() });
    if (url.pathname.startsWith('/api/')) {
      const origin = request.headers.get('origin');
      if (request.method === 'OPTIONS') return apiPreflight(origin);
      if (isProviderSpendPath(url.pathname)) {
        const capability = request.headers.get(AI_CAPABILITY_HEADER);
        const authorized = AI_CAPABILITY_SIGNING_KEY && await verifyAICapability(capability, {
          signingKey: AI_CAPABILITY_SIGNING_KEY,
          buildId: RUNTIME_BUILD.manifest.buildId,
        });
        if (!authorized) return withApiCors(json({ error: { code: 'unauthorized', message: 'A valid Hex AI capability is required.' } }, 401), origin);
      }
      return withApiCors(await worker.fetch(request, env, executionCtx), origin);
    }
    return worker.fetch(request, env, executionCtx);
  },
};

async function serveUserscript(request, env, url, metadataOnly) {
  if (!['GET', 'HEAD'].includes(request.method)) return methodNotAllowed('GET, HEAD');
  const source = await asset(env, url, USER_SCRIPT_TEMPLATE);
  if (!source.ok) return new Response('Hex userscript has not been built.', { status: 503 });
  let body = (await source.text()).replaceAll('__HEX_ORIGIN__', url.origin);
  if (metadataOnly) { const marker = '// ==/UserScript=='; const end = body.indexOf(marker); if (end < 0) return new Response('Invalid userscript metadata.', { status: 500 }); body = body.slice(0, end + marker.length) + '\n'; }
  return new Response(request.method === 'HEAD' ? null : body, { headers: { ...securityHeaders(), 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate' } });
}

async function serveChatGPTEmbed(request, env, url) {
  const headers = embedDocumentHeaders();
  if (!['GET', 'HEAD'].includes(request.method)) {
    headers.set('allow', 'GET, HEAD');
    return new Response('Method Not Allowed', { status: 405, headers });
  }
  if (!env.ASSETS?.fetch) return new Response(request.method === 'HEAD' ? null : 'Hex shell is unavailable.', { status: 503, headers });
  const source = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), { method: request.method }));
  return new Response(request.method === 'HEAD' ? null : source.body, { status: source.status, statusText: source.statusText, headers });
}

// #8703: bounded streaming read that enforces the request cap during ingress.
async function readBoundedBootstrapText(request, limit) {
  const body = request.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      size += value.byteLength;
      if (size > limit) {
        // Once the cap has been crossed, the semantic classification is fixed.
        // Cancellation is best-effort transport cleanup and must never replace
        // the deterministic 413 outcome if an underlying source rejects it.
        const error = new Error('bootstrap-request-too-large');
        error.bootstrapRequestTooLarge = true;
        try { await reader.cancel(); } catch { /* preserve the overflow classification */ }
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released after cancel */ }
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

async function runtimeBootstrap(request, env, url) {
  if (request.method === 'OPTIONS') return runtimePreflight(request.headers.get('origin'), url.origin);
  if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
  const origin = request.headers.get('origin');
  if (!isAllowedRequestOrigin(origin, url.origin)) return json({ error: 'origin-not-allowed' }, 403);
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > BOOTSTRAP_MAX_BYTES) return json({ error: 'request-too-large' }, 413);
  let text;
  try { text = await readBoundedBootstrapText(request, BOOTSTRAP_MAX_BYTES); }
  catch (error) {
    if (error && error.bootstrapRequestTooLarge) return json({ error: 'request-too-large' }, 413);
    return json({ error: 'invalid-bootstrap-request' }, 400);
  }
  let input;
  try { input = JSON.parse(text); } catch { return json({ error: 'invalid-bootstrap-request' }, 400); }
  const validation = validateRuntimeBootstrap(input, { buildId: RUNTIME_BUILD.manifest.buildId });
  if (validation) return json({ error: validation }, validation === 'wrong-build' ? 409 : 400);

  const sessionId = crypto.randomUUID(), expiryMs = Date.now() + SESSION_TTL_MS;
  const replay = runtimeState(env);
  const bucket = await runtimeBootstrapAuthorityBucket(request, input.sessionIdentity);
  const issued = await replay.beginIssue({
    nonce: input.nonce,
    sessionId,
    expiry: expiryMs,
    requestId: input.requestId,
    bucket,
  });
  if (!issued.ok) {
    const status = issued.reason === 'replayed-nonce' ? 403 : 429;
    const retry = status === 429 ? { 'retry-after': '1' } : {};
    return json({ error: issued.reason }, status, origin, retry);
  }
  let committed = false;
  try {
    const envelope = await wrapContentKey(input.clientPublicKey, sessionId);
    const payload = { v: 1, sid: sessionId, bid: RUNTIME_BUILD.manifest.buildId, exp: Math.floor(expiryMs / 1000), rid: input.requestId, cid: await shortHash(input.sessionIdentity) };
    const session = await signRuntimeSession(payload, decodeBase64URL(RUNTIME_BUILD.signingKey));
    const finalized = await replay.finishIssue({ leaseId: issued.leaseId, sessionId });
    if (!finalized.ok) throw new Error(finalized.reason || 'bootstrap-issuance-finalize-failed');
    committed = true;
    return json({
      session, sessionId, expiry: new Date(expiryMs).toISOString(), buildId: RUNTIME_BUILD.manifest.buildId,
      sourceCommit: DEPLOYMENT_COMMIT,
      manifest: publicRuntimeManifest(RUNTIME_BUILD.manifest), runtimeLocator: `/_runtime/${RUNTIME_BUILD.manifest.buildId}`,
      serverPublicKey: envelope.serverPublicKey, keyEnvelope: envelope.keyEnvelope,
    }, 200, origin, { 'cache-control': 'no-store, private' });
  } catch {
    if (!committed) await replay.abortIssue({ leaseId: issued.leaseId, sessionId });
    return json({ error: 'key-envelope-failed' }, 400);
  }
}

async function protectedRuntime(request, env, url) {
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') return runtimeAssetPreflight(origin, url.origin);
  if (request.method !== 'GET') return methodNotAllowed('GET, OPTIONS');
  if (!isAllowedRequestOrigin(origin, url.origin)) return json({ error: 'origin-not-allowed' }, 403);
  let buildId;
  try {
    buildId = decodeURIComponent(url.pathname.slice('/_runtime/'.length));
  } catch {
    return json({ error: 'invalid-runtime-path' }, 400);
  }
  if (buildId !== RUNTIME_BUILD.manifest.buildId) return json({ error: 'wrong-build' }, 403);
  const raw = request.headers.get('authorization') || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  const payload = await verifyRuntimeSession(token, decodeBase64URL(RUNTIME_BUILD.signingKey));
  if (!payload || payload.bid !== buildId) return json({ error: 'invalid-or-expired-session' }, 403);
  const response = await asset(env, url, RUNTIME_BUILD.manifest.assetPath);
  if (!response.ok) return json({ error: 'runtime-unavailable' }, 503);
  const consumed = await runtimeState(env).consume({ sessionId: payload.sid, requestId: payload.rid });
  if (!consumed.ok) return json({ error: consumed.reason }, 403);
  const headers = new Headers(securityHeaders()); headers.set('content-type', 'application/octet-stream'); headers.set('content-length', String(RUNTIME_BUILD.manifest.byteLength)); headers.set('cache-control', 'private, max-age=120'); headers.set('x-hex-runtime-build', buildId);
  if (origin && CHATGPT_ORIGINS.has(origin)) { headers.set('access-control-allow-origin', origin); headers.set('vary', 'Origin'); }
  return new Response(response.body, { status: 200, headers });
}

async function wrapContentKey(clientJwk, sessionId) {
  const clientKey = await crypto.subtle.importKey('jwk', clientJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKeys.privateKey, 256);
  const salt = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const wrappingKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(`hex-runtime-wrap:${RUNTIME_BUILD.manifest.buildId}`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(`${RUNTIME_BUILD.manifest.buildId}:${sessionId}`), tagLength: 128 }, wrappingKey, decodeBase64URL(RUNTIME_BUILD.contentKey));
  new Uint8Array(shared).fill(0);
  return { serverPublicKey: await crypto.subtle.exportKey('jwk', serverKeys.publicKey), keyEnvelope: { algorithm: 'ECDH-P256+HKDF-SHA256+A256GCM', salt: encodeBase64URL(salt), iv: encodeBase64URL(iv), ciphertext: encodeBase64URL(new Uint8Array(ciphertext)) } };
}

async function runtimeBootstrapAuthorityBucket(request, sessionIdentity) {
  // Cloudflare supplies CF-Connecting-IP at the edge; callers cannot use a
  // self-declared Origin/session string to escape per-client admission. The
  // session identity is only the headless/test fallback when the platform IP
  // authority is unavailable.
  const connectingIp = request.headers.get('cf-connecting-ip');
  return shortHash(connectingIp ? `ip:${connectingIp}` : `session:${sessionIdentity}`);
}

async function scheduleRuntimeBootstrapCleanup(storage, when, replace = false) {
  if (typeof storage?.setAlarm !== 'function') return;
  if (!replace && typeof storage.getAlarm === 'function') {
    const current = await storage.getAlarm();
    if (current != null && current <= when) return;
  }
  await storage.setAlarm(when);
}

function runtimeState(env) { if (!env.RUNTIME_BOOTSTRAP) throw new Error('RUNTIME_BOOTSTRAP binding is unavailable'); return env.RUNTIME_BOOTSTRAP.get(env.RUNTIME_BOOTSTRAP.idFromName('runtime-v1')); }
function isPrivatePath(path) {
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return true; }
  if (decoded.includes('%') || decoded.includes('\\') || decoded.includes('\0')) return true;
  return PRIVATE_FILES.has(decoded) || PRIVATE_PREFIXES.some((prefix) => decoded === prefix.slice(0, -1) || decoded.startsWith(prefix));
}
async function asset(env, url, path) { if (!env.ASSETS?.fetch) return new Response(null, { status: 503 }); return env.ASSETS.fetch(new Request(new URL(path, url.origin), { method: 'GET' })); }
function methodNotAllowed(allow) { return new Response('Method Not Allowed', { status: 405, headers: { ...securityHeaders(), allow } }); }
function securityHeaders() { return { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-site' }; }
function embedDocumentHeaders() { return new Headers({ 'content-security-policy': 'frame-ancestors https://chatgpt.com https://chat.openai.com', 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); }
function utf8(value) { return new TextEncoder().encode(String(value)); }
async function shortHash(value) { const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(value))); return encodeBase64URL(digest.slice(0, 12)); }


function runtimeAICapabilitySigningKey() {
  try {
    if (typeof RUNTIME_BUILD?.signingKey !== 'string') return null;
    const key = decodeBase64URL(RUNTIME_BUILD.signingKey);
    return key.byteLength >= 32 ? key : null;
  } catch { return null; }
}
function isProviderSpendPath(path) { return path === '/api/ai/turn' || path === '/api/gemini'; }

function runtimePreflight(origin, workerOrigin) {
  if (!isAllowedRequestOrigin(origin, workerOrigin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '600', vary: 'Origin' } });
}
function runtimeAssetPreflight(origin, workerOrigin) {
  if (!isAllowedRequestOrigin(origin, workerOrigin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'Authorization', 'access-control-max-age': '600', vary: 'Origin' } });
}
function apiPreflight(origin) { if (!CHATGPT_ORIGINS.has(origin)) return new Response(null, { status: 403 }); return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, X-Hex-Session, X-Hex-AI-Capability', 'access-control-max-age': '86400', vary: 'Origin' } }); }
function withApiCors(response, origin) { if (!CHATGPT_ORIGINS.has(origin)) return response; const headers = new Headers(response.headers); headers.set('access-control-allow-origin', origin); headers.set('access-control-allow-methods', 'POST, OPTIONS'); headers.set('access-control-allow-headers', 'Content-Type, X-Hex-Session, X-Hex-AI-Capability'); headers.set('vary', appendVary(headers.get('vary'), 'Origin')); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); }
function appendVary(current, value) { const parts = String(current || '').split(',').map((item) => item.trim()).filter(Boolean); if (!parts.some((item) => item.toLowerCase() === value.toLowerCase())) parts.push(value); return parts.join(', '); }
function json(body, status = 200, origin = null, extra = {}) { const headers = new Headers({ ...securityHeaders(), 'content-type': 'application/json; charset=utf-8', ...extra }); if (origin && CHATGPT_ORIGINS.has(origin)) { headers.set('access-control-allow-origin', origin); headers.set('vary', 'Origin'); } return new Response(JSON.stringify(body), { status, headers }); }

export const __runtimeTest = {
  isPrivatePath,
  readBoundedBootstrapText,
  runtimeBootstrap,
  runtimeBootstrapAuthorityBucket,
};

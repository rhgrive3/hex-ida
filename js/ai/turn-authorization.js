import { verifyRuntimeSession } from '../userscript/runtime-security.js';

const SESSION_HEADER = 'authorization';
const PROVIDER_ENDPOINTS = new Set(['/api/ai/turn', '/api/gemini']);
const verifiedTurnContexts = new WeakMap();
export const AI_PROVIDER_AUDIENCE = 'ai-provider';
export const AI_PROVIDER_SCOPE = 'provider-spend';

export function isProviderSpendPath(pathname) {
  return PROVIDER_ENDPOINTS.has(String(pathname || ''));
}

export function authorizedAITurnContext(request) {
  return request && typeof request === 'object' ? (verifiedTurnContexts.get(request) || null) : null;
}

function bearerToken(request) {
  const raw = request?.headers?.get?.(SESSION_HEADER);
  if (typeof raw !== 'string') return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
}

export async function verifyAITurnAuthorization(request, { signingKeyBytes, buildId, now = Date.now() } = {}) {
  if (!signingKeyBytes || signingKeyBytes.length === 0) {
    return { ok: false, status: 503, error: 'ai-authorization-unavailable', reason: 'server signing key not configured' };
  }
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'ai-authorization-required', reason: 'missing bearer capability token' };
  const payload = await verifyRuntimeSession(token, signingKeyBytes, { now, requireUnexpired: true });
  if (!payload) return { ok: false, status: 401, error: 'ai-authorization-invalid', reason: 'invalid or expired capability token' };
  if (payload.aud !== AI_PROVIDER_AUDIENCE) return { ok: false, status: 401, error: 'ai-authorization-audience-mismatch', reason: 'token audience does not authorize provider spend' };
  if (payload.scope !== AI_PROVIDER_SCOPE) return { ok: false, status: 401, error: 'ai-authorization-scope-mismatch', reason: 'token scope does not authorize provider spend' };
  if (buildId != null && payload.bid !== buildId) return { ok: false, status: 401, error: 'ai-authorization-build-mismatch', reason: 'token audience does not match this build' };
  const context = Object.freeze({ sid: payload.sid, rid: payload.rid, exp: Number(payload.exp), bid: payload.bid });
  verifiedTurnContexts.set(request, context);
  return { ok: true, payload, context };
}

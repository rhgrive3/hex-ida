import { verifyRuntimeSession } from '../userscript/runtime-security.js';

const SESSION_HEADER = 'authorization';
const PROVIDER_ENDPOINTS = new Set(['/api/ai/turn', '/api/gemini']);
export const AI_PROVIDER_AUDIENCE = 'ai-provider';

export function isProviderSpendPath(pathname) {
  return PROVIDER_ENDPOINTS.has(String(pathname || ''));
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
  if (buildId != null && payload.bid !== buildId) return { ok: false, status: 401, error: 'ai-authorization-build-mismatch', reason: 'token audience does not match this build' };
  return { ok: true, payload };
}

// #8750: provider-backed AI endpoints had no authorization boundary — an
// unauthenticated direct HTTP client (no Origin/Authorization/session) reached
// `handleAITurn` and spent the deployment's server-owned Gemini/Groq key before
// any per-IP/session quota could even be attributed. This closes the ingress
// gap with a short-lived, server-signed capability credential: the same
// `signRuntimeSession`/`verifyRuntimeSession` primitive (HMAC over the build's
// private `RUNTIME_BUILD.signingKey`, never shipped to the browser) that the
// protected runtime already uses. Verification is audience- and expiry-bound and
// MUST complete before quota acquisition and before any provider request, so a
// rejected caller never triggers provider spend.

import { verifyRuntimeSession } from '../userscript/runtime-security.js';

const SESSION_HEADER = 'authorization';
const PROVIDER_ENDPOINTS = new Set(['/api/ai/turn', '/api/gemini']);

export function isProviderSpendPath(pathname) {
  return PROVIDER_ENDPOINTS.has(String(pathname || ''));
}

function bearerToken(request) {
  const raw = request?.headers?.get?.(SESSION_HEADER);
  if (typeof raw !== 'string') return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
}

// Returns { ok:true, payload } on a valid credential, otherwise a terminal
// { ok:false, status, error, reason } that the caller turns into a response
// BEFORE dispatching to the provider worker. Fail-closed: a deployment without
// the server signing key cannot silently allow unauthenticated provider spend.
export async function verifyAITurnAuthorization(request, { signingKeyBytes, buildId, now = Date.now() } = {}) {
  if (!signingKeyBytes || signingKeyBytes.length === 0) {
    return { ok: false, status: 503, error: 'ai-authorization-unavailable', reason: 'server signing key not configured' };
  }
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'ai-authorization-required', reason: 'missing bearer capability token' };
  const payload = await verifyRuntimeSession(token, signingKeyBytes, { now, requireUnexpired: true });
  if (!payload) return { ok: false, status: 401, error: 'ai-authorization-invalid', reason: 'invalid or expired capability token' };
  if (buildId != null && payload.bid !== buildId) return { ok: false, status: 401, error: 'ai-authorization-build-mismatch', reason: 'token audience does not match this build' };
  return { ok: true, payload };
}

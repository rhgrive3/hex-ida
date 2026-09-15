// Regression for #8750: `/api/ai/turn` and `/api/gemini` reached `handleAITurn`
// and spent the deployment's server-owned provider key from a direct HTTP client
// with no Origin/Authorization/session, because CORS/`withApiCors` is only a
// browser-isolation control. The deployed ingress (`worker-entry.js`) now
// requires a short-lived, server-signed capability token (the same `RUNTIME_BUILD`
// signing primitive the protected runtime uses) BEFORE quota attribution or any
// provider request. The 12 existing turn/quota unit tests call `worker.js`
// directly and are unaffected; this exercises the real ingress boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const BUILD_ID = 'lane07-8750-build';
const SIGNING_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // base64url, 32 bytes

register('data:text/javascript,' + encodeURIComponent(`
const runtimeSecrets = ${JSON.stringify(`export const RUNTIME_BUILD = Object.freeze({
  manifest: Object.freeze({ buildId: '${BUILD_ID}', assetPath: '/.runtime/runtime.test.bin', byteLength: 0 }),
  signingKey: '${SIGNING_KEY}',
});`)};
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {}', shortCircuit: true };
  if (specifier.endsWith('.runtime-build/runtime-secrets.js')) return { url: 'data:text/javascript,' + encodeURIComponent(runtimeSecrets), shortCircuit: true };
  return nextResolve(specifier, context);
}
`));

const { default: entry } = await import('../../../worker-entry.js');
const { decodeBase64URL } = await import('../../../js/userscript/runtime-security.js');
const { verifyAITurnAuthorization, isProviderSpendPath } = await import('../../../js/ai/turn-authorization.js');
const { signRuntimeSession } = await import('../../../js/userscript/runtime-security.js');

const workerOrigin = 'https://ida.example.workers.dev';
const KEY = decodeBase64URL(SIGNING_KEY);

async function token({ buildId = BUILD_ID, expOffsetSec = 120 } = {}) {
  const exp = Math.floor(Date.now() / 1000) + expOffsetSec;
  return signRuntimeSession({ v: 1, sid: 'sess-8750', bid: buildId, rid: 'req-8750', exp }, KEY);
}

async function postTurn(path = '/api/ai/turn', headers = {}) {
  return entry.fetch(new Request(`${workerOrigin}${path}`, {
    method: 'POST',
    headers: { origin: 'https://chatgpt.com', 'content-type': 'application/json', ...headers },
    body: 'not-json', // malformed on purpose: proves we never reach the provider
  }), {});
}

test('#8750 an unauthenticated provider POST is rejected at the ingress before any provider spend', async () => {
  for (const path of ['/api/ai/turn', '/api/gemini']) {
    const response = await postTurn(path);
    assert.equal(response.status, 401, `${path} without a capability token must be 401`);
    const body = await response.json();
    assert.equal(body.error, 'ai-authorization-required', `${path}: rejected before quota/provider`);
  }
});

test('#8750 a malformed / foreign-build / expired capability token is rejected', async () => {
  assert.equal((await postTurn('/api/ai/turn', { authorization: 'Bearer garbage' })).status, 401);
  const foreign = await postTurn('/api/ai/turn', { authorization: `Bearer ${await token({ buildId: 'other-build' })}` });
  assert.equal(foreign.status, 401);
  assert.equal((await foreign.json()).error, 'ai-authorization-build-mismatch');
  const expired = await postTurn('/api/ai/turn', { authorization: `Bearer ${await token({ expOffsetSec: -3600 })}` });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error, 'ai-authorization-invalid');
});

test('#8750 a valid capability token clears the gate (reaches the inner handler, not a 401 auth error)', async () => {
  const response = await postTurn('/api/ai/turn', { authorization: `Bearer ${await token()}` });
  const body = await response.json().catch(() => ({}));
  assert.notEqual(body?.error, 'ai-authorization-required', 'authorized request must not be short-circuited by the gate');
  assert.notEqual(body?.error, 'ai-authorization-invalid', 'authorized request must not be short-circuited by the gate');
  assert.equal(statusIsAuthReject(response.status, body), false, 'authorized request must pass the ingress gate');
});

test('#8750 CORS preflight and the public capability route are never blocked by the spend gate', async () => {
  const preflight = await entry.fetch(new Request(`${workerOrigin}/api/ai/turn`, {
    method: 'OPTIONS',
    headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST' },
  }), {});
  assert.equal(preflight.status, 204, 'preflight still allowed');
  const caps = await entry.fetch(new Request(`${workerOrigin}/api/ai/capabilities`, { method: 'GET', headers: { origin: 'https://chatgpt.com' } }), {});
  assert.equal(statusIsAuthReject(caps.status, await caps.json().catch(() => ({}))), false, 'capability GET must not be blocked by the spend gate');
});

test('#8750 (unit) the verifier fails closed without a configured signing key', async () => {
  const result = await verifyAITurnAuthorization(new Request('https://x/api/ai/turn'), { signingKeyBytes: null, buildId: BUILD_ID });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error, 'ai-authorization-unavailable');
});

test('#8750 (unit) only provider-spend paths are gated', () => {
  assert.equal(isProviderSpendPath('/api/ai/turn'), true);
  assert.equal(isProviderSpendPath('/api/gemini'), true);
  assert.equal(isProviderSpendPath('/api/ai/capabilities'), false);
});

function statusIsAuthReject(status, body) {
  return status === 401 && typeof body?.error === 'string' && body.error.startsWith('ai-authorization');
}

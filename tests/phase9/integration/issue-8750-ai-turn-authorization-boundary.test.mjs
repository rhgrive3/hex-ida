// Regression for #8750: provider-backed endpoints must require a purpose-bound,
// server-signed, single-use spend grant before quota attribution/provider spend.
// CORS/Origin and caller-controlled session identifiers are never authority.
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
const { decodeBase64URL, signRuntimeSession } = await import('../../../js/userscript/runtime-security.js');
const {
  AI_PROVIDER_AUDIENCE, AI_PROVIDER_SCOPE, authorizedAITurnContext,
  isProviderSpendPath, verifyAITurnAuthorization,
} = await import('../../../js/ai/turn-authorization.js');

const workerOrigin = 'https://ida.example.workers.dev';
const KEY = decodeBase64URL(SIGNING_KEY);
let tokenSequence = 0;

async function token({
  buildId = BUILD_ID,
  expOffsetSec = 120,
  audience = AI_PROVIDER_AUDIENCE,
  scope = AI_PROVIDER_SCOPE,
  sid = 'sess-8750',
  rid = `grant-8750-${++tokenSequence}`,
  includeAudience = true,
  includeScope = true,
} = {}) {
  const exp = Math.floor(Date.now() / 1000) + expOffsetSec;
  const payload = { v: 1, sid, bid: buildId, rid, exp };
  if (includeAudience) payload.aud = audience;
  if (includeScope) payload.scope = scope;
  return signRuntimeSession(payload, KEY);
}

function replayEnv() {
  const consumed = new Set();
  const stub = {
    async consumeAIGrant({ grantId, expiry }) {
      assert.equal(typeof grantId, 'string');
      assert.ok(Number.isFinite(expiry));
      if (consumed.has(grantId)) return { ok: false, reason: 'replayed-ai-grant' };
      consumed.add(grantId);
      return { ok: true };
    },
  };
  return {
    RUNTIME_BOOTSTRAP: {
      idFromName(name) { assert.equal(name, 'runtime-v1'); return name; },
      get() { return stub; },
    },
  };
}

async function postTurn(path = '/api/ai/turn', headers = {}, env = replayEnv()) {
  return entry.fetch(new Request(`${workerOrigin}${path}`, {
    method: 'POST',
    headers: { origin: 'https://chatgpt.com', 'content-type': 'application/json', ...headers },
    body: 'not-json', // malformed on purpose: proves the ingress gate runs first
  }), env);
}

test('#8750 no auth remains rejected even with spoofed allowed Origin/session identifiers', async () => {
  for (const path of ['/api/ai/turn', '/api/gemini']) {
    const response = await postTurn(path, { 'x-hex-session': 'attacker-controlled-session' });
    assert.equal(response.status, 401, `${path} without a spend grant must be 401`);
    const body = await response.json();
    assert.equal(body.error, 'ai-authorization-required', `${path}: rejected before quota/provider`);
  }
});

test('#8750 a generic runtime-bootstrap token is not provider-spend authority', async () => {
  const generic = await token({ includeAudience: false, includeScope: false, rid: 'runtime-request-8750' });
  const response = await postTurn('/api/ai/turn', { authorization: `Bearer ${generic}` });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'ai-authorization-audience-mismatch');
});

test('#8750 malformed, foreign-build, wrong-audience, wrong-scope, and expired grants fail closed', async () => {
  assert.equal((await postTurn('/api/ai/turn', { authorization: 'Bearer garbage' })).status, 401);

  const foreign = await postTurn('/api/ai/turn', { authorization: `Bearer ${await token({ buildId: 'other-build' })}` });
  assert.equal(foreign.status, 401);
  assert.equal((await foreign.json()).error, 'ai-authorization-build-mismatch');

  const wrongAudience = await postTurn('/api/ai/turn', { authorization: `Bearer ${await token({ audience: 'runtime-asset' })}` });
  assert.equal(wrongAudience.status, 401);
  assert.equal((await wrongAudience.json()).error, 'ai-authorization-audience-mismatch');

  const wrongScope = await postTurn('/api/ai/turn', { authorization: `Bearer ${await token({ scope: 'read-only' })}` });
  assert.equal(wrongScope.status, 401);
  assert.equal((await wrongScope.json()).error, 'ai-authorization-scope-mismatch');

  const expired = await postTurn('/api/ai/turn', { authorization: `Bearer ${await token({ expOffsetSec: -3600 })}` });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error, 'ai-authorization-invalid');
});

test('#8750 a valid spend grant is single-use and a replay is rejected before inner handling', async () => {
  const env = replayEnv();
  const grant = await token({ rid: 'single-use-grant-8750' });
  const headers = { authorization: `Bearer ${grant}` };

  const first = await postTurn('/api/ai/turn', headers, env);
  const firstBody = await first.json().catch(() => ({}));
  assert.equal(statusIsAuthReject(first.status, firstBody), false, 'first use must clear ingress authorization');
  assert.equal(first.status, 400, 'malformed fixture reaches the inner JSON parser after authorization');

  const replay = await postTurn('/api/ai/turn', headers, env);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, 'ai-authorization-replayed');
});

test('#8750 verifier records the signed session identity for downstream quota attribution', async () => {
  const signed = await token({ sid: 'signed-session-8750', rid: 'quota-context-grant-8750' });
  const request = new Request(`${workerOrigin}/api/ai/turn`, { headers: { authorization: `Bearer ${signed}` } });
  const result = await verifyAITurnAuthorization(request, { signingKeyBytes: KEY, buildId: BUILD_ID });
  assert.equal(result.ok, true);
  assert.equal(authorizedAITurnContext(request)?.sid, 'signed-session-8750');
  assert.equal(authorizedAITurnContext(request)?.rid, 'quota-context-grant-8750');
});

test('#8750 browser CORS permits Authorization while capability discovery stays public/read-only', async () => {
  const preflight = await entry.fetch(new Request(`${workerOrigin}/api/ai/turn`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://chatgpt.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  }), {});
  assert.equal(preflight.status, 204, 'preflight still allowed');
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /authorization/i,
    'legitimate browser callers may send the bearer spend grant');

  const caps = await entry.fetch(new Request(`${workerOrigin}/api/ai/capabilities`, {
    method: 'GET', headers: { origin: 'https://chatgpt.com' },
  }), {});
  assert.equal(statusIsAuthReject(caps.status, await caps.json().catch(() => ({}))), false,
    'capability discovery must not be blocked by the spend gate');
});

test('#8750 verifier fails closed without a configured signing key', async () => {
  const result = await verifyAITurnAuthorization(new Request('https://x/api/ai/turn'), {
    signingKeyBytes: null, buildId: BUILD_ID,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error, 'ai-authorization-unavailable');
});

test('#8750 only provider-spend paths are gated', () => {
  assert.equal(isProviderSpendPath('/api/ai/turn'), true);
  assert.equal(isProviderSpendPath('/api/gemini'), true);
  assert.equal(isProviderSpendPath('/api/ai/capabilities'), false);
});

function statusIsAuthReject(status, body) {
  return status === 401 && typeof body?.error === 'string' && body.error.startsWith('ai-authorization');
}

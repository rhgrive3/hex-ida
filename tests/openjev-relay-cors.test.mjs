import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  CHATGPT_ORIGINS,
  isAllowedRequestOrigin,
  isAllowedOpenJevOrigin,
} from '../js/userscript/request-origin-policy.js';

const WORKER_ORIGIN = 'https://hex.test';
const ENDPOINT = `${WORKER_ORIGIN}/api/jev/systemone`;

test('request-origin-policy keeps isAllowedRequestOrigin strict while isAllowedOpenJevOrigin allows Origin: null', () => {
  // Existing policy must NOT allow Origin: null
  assert.equal(isAllowedRequestOrigin('null', WORKER_ORIGIN), false);
  assert.equal(isAllowedRequestOrigin(null, WORKER_ORIGIN), false);
  assert.equal(isAllowedRequestOrigin('', WORKER_ORIGIN), false);
  assert.equal(isAllowedRequestOrigin('https://evil.example', WORKER_ORIGIN), false);
  assert.equal(isAllowedRequestOrigin(WORKER_ORIGIN, WORKER_ORIGIN), true);
  for (const chatgptOrigin of CHATGPT_ORIGINS) {
    assert.equal(isAllowedRequestOrigin(chatgptOrigin, WORKER_ORIGIN), true);
  }

  // OpenJev policy allows 'null', workerOrigin, and CHATGPT_ORIGINS only
  assert.equal(isAllowedOpenJevOrigin('null', WORKER_ORIGIN), true);
  assert.equal(isAllowedOpenJevOrigin(WORKER_ORIGIN, WORKER_ORIGIN), true);
  for (const chatgptOrigin of CHATGPT_ORIGINS) {
    assert.equal(isAllowedOpenJevOrigin(chatgptOrigin, WORKER_ORIGIN), true);
  }
  assert.equal(isAllowedOpenJevOrigin(null, WORKER_ORIGIN), false);
  assert.equal(isAllowedOpenJevOrigin(undefined, WORKER_ORIGIN), false);
  assert.equal(isAllowedOpenJevOrigin('', WORKER_ORIGIN), false);
  assert.equal(isAllowedOpenJevOrigin('https://evil.example', WORKER_ORIGIN), false);
});

test('worker-entry handleOpenJevSystemOne enforces full origin x method x status CORS matrix', () => {
  const script = `
    import vm from 'node:vm';
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { webcrypto } from 'node:crypto';

    const root = new URL('./', 'file://' + process.cwd() + '/');
    const buildId = 'a'.repeat(24) + '.' + 'b'.repeat(24);
    const signingKey = Buffer.alloc(32, 7).toString('base64url');
    const context = vm.createContext({
      fetch, Request, Response, Headers, URL, URLSearchParams, ReadableStream,
      TextEncoder, TextDecoder, AbortController, AbortSignal, AggregateError,
      crypto: webcrypto, console, setTimeout, clearTimeout, setInterval, clearInterval,
      atob, btoa, performance, structuredClone,
    });
    const cache = new Map();
    async function moduleFor(id) {
      if (cache.has(id)) return cache.get(id);
      let source;
      if (id === 'cloudflare:workers') source = 'export class DurableObject { constructor() {} }';
      else if (id.endsWith('/.runtime-build/runtime-secrets.js')) source = 'export const RUNTIME_BUILD={manifest:{buildId:' + JSON.stringify('a'.repeat(24)) + ',privileged:{buildId:' + JSON.stringify(buildId) + '}},signingKey:' + JSON.stringify(signingKey) + '};';
      else if (id.endsWith('/.runtime-build/privileged-assets.js')) source = 'export const PRIVILEGED_BUILD=' + JSON.stringify({ buildId, parentSource: '/* p */', childSource: '/* c */', adminSource: '/* a */' }) + ';';
      else source = await readFile(new URL(id), 'utf8');
      const mod = new vm.SourceTextModule(source, { context, identifier: id, initializeImportMeta(meta) { meta.url = id; } });
      cache.set(id, mod);
      return mod;
    }
    const entry = await moduleFor(new URL('worker-entry.js', root).href);
    await entry.link((specifier, referring) => moduleFor(specifier.startsWith('cloudflare:') ? specifier : new URL(specifier, referring.identifier).href));
    await entry.evaluate({ timeout: 10000 });

    const worker = entry.namespace.default;
    const { handleOpenJevSystemOne } = entry.namespace.__runtimeTest;
    const WORKER_ORIGIN = ${JSON.stringify(WORKER_ORIGIN)};
    const ENDPOINT = ${JSON.stringify(ENDPOINT)};
    const ALLOWED_ORIGINS = ['null', 'https://chatgpt.com', WORKER_ORIGIN];
    const EVIL_ORIGIN = 'https://evil.example';
    const AUTH = 'Bearer openjev-token-123456';

    const okFetch = async (_url, init) => {
      assert.equal(init.headers.authorization, AUTH);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    function assertAllowedCorsHeaders(res, origin) {
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
      assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
      assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
      assert.equal(res.headers.get('access-control-allow-credentials'), null);
      assert.match(res.headers.get('vary') || '', /Origin/i);
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    }

    function assertNoCorsOrigin(res) {
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      assert.equal(res.headers.get('access-control-allow-credentials'), null);
    }

    // 1. OPTIONS preflight matrix
    for (const origin of ALLOWED_ORIGINS) {
      const res = await handleOpenJevSystemOne(new Request(ENDPOINT, {
        method: 'OPTIONS',
        headers: { origin },
      }));
      assert.equal(res.status, 204, 'OPTIONS should return 204 for ' + origin);
      assertAllowedCorsHeaders(res, origin);
      assert.equal(res.headers.get('access-control-max-age'), '86400');
    }
    for (const badHeaders of [{ origin: EVIL_ORIGIN }, {}]) {
      const res = await handleOpenJevSystemOne(new Request(ENDPOINT, {
        method: 'OPTIONS',
        headers: badHeaders,
      }));
      assert.equal(res.status, 403, 'OPTIONS should reject evil/missing origin');
      assertNoCorsOrigin(res);
    }

    // 2. Disallowed origin is rejected with 403 across all methods (POST, GET) before method/auth checks
    for (const method of ['POST', 'GET']) {
      const init = { method, headers: { origin: EVIL_ORIGIN, authorization: AUTH } };
      if (method === 'POST') init.body = JSON.stringify({ q: 1 });
      const res = await handleOpenJevSystemOne(new Request(ENDPOINT, init), {
        fetchImpl: async () => { throw new Error('must not call upstream'); },
      });
      assert.equal(res.status, 403, method + ' from evil origin must return 403');
      assertNoCorsOrigin(res);
      assert.equal((await res.json()).error.code, 'origin_not_allowed');
    }

    // 3. Non-POST (GET) for allowed origins and missing Origin -> 405 Method Not Allowed
    for (const origin of ALLOWED_ORIGINS) {
      const res = await handleOpenJevSystemOne(new Request(ENDPOINT, {
        method: 'GET',
        headers: { origin },
      }));
      assert.equal(res.status, 405, 'GET for allowed origin must return 405');
      assert.equal(res.headers.get('allow'), 'POST, OPTIONS');
      assertAllowedCorsHeaders(res, origin);
    }
    {
      const res = await handleOpenJevSystemOne(new Request(ENDPOINT, { method: 'GET' }));
      assert.equal(res.status, 405, 'GET without Origin must return 405');
      assert.equal(res.headers.get('allow'), 'POST, OPTIONS');
      assertNoCorsOrigin(res);
    }

    // 4. POST matrix (401 unauthorized, 413 payload_too_large, 200 ok) for allowed origins + missing Origin
    const oversizedBody = 'x'.repeat(512 * 1024 + 1);
    for (const origin of [...ALLOWED_ORIGINS, null]) {
      const baseHeaders = origin !== null ? { origin } : {};

      // 4a. 401 unauthorized
      const res401 = await handleOpenJevSystemOne(new Request(ENDPOINT, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ q: 1 }),
      }), { fetchImpl: async () => { throw new Error('must not fetch'); } });
      assert.equal(res401.status, 401);
      assert.equal((await res401.json()).error.code, 'unauthorized');
      if (origin !== null) assertAllowedCorsHeaders(res401, origin);
      else assertNoCorsOrigin(res401);

      // 4b. 413 payload_too_large
      const res413 = await handleOpenJevSystemOne(new Request(ENDPOINT, {
        method: 'POST',
        headers: { ...baseHeaders, authorization: AUTH },
        body: oversizedBody,
      }), { fetchImpl: async () => { throw new Error('must not fetch'); } });
      assert.equal(res413.status, 413);
      assert.equal((await res413.json()).error.code, 'payload_too_large');
      if (origin !== null) assertAllowedCorsHeaders(res413, origin);
      else assertNoCorsOrigin(res413);

      // 4c. 200 normal proxy
      const res200 = await handleOpenJevSystemOne(new Request(ENDPOINT, {
        method: 'POST',
        headers: { ...baseHeaders, authorization: AUTH },
        body: JSON.stringify({ prompt: 'hello' }),
      }), { fetchImpl: okFetch });
      assert.equal(res200.status, 200);
      assert.deepEqual(await res200.json(), { ok: true });
      if (origin !== null) assertAllowedCorsHeaders(res200, origin);
      else {
        assertNoCorsOrigin(res200);
        assert.equal(res200.headers.get('x-content-type-options'), 'nosniff');
      }
    }

    // 4d. Origin: null upstream 502 (upstream_error & upstream_payload_too_large) and 504 (upstream_timeout)
    {
      const res502Err = await handleOpenJevSystemOne(new Request(ENDPOINT, {
        method: 'POST',
        headers: { origin: 'null', authorization: AUTH },
        body: JSON.stringify({ prompt: 'err' }),
      }), { fetchImpl: async () => { throw new Error('network down'); } });
      assert.equal(res502Err.status, 502);
      assert.equal((await res502Err.json()).error.code, 'upstream_error');
      assertAllowedCorsHeaders(res502Err, 'null');

      const res502Large = await handleOpenJevSystemOne(new Request(ENDPOINT, {
        method: 'POST',
        headers: { origin: 'null', authorization: AUTH },
        body: JSON.stringify({ prompt: 'large' }),
      }), { fetchImpl: async () => new Response('y'.repeat(512 * 1024 + 1), { status: 200 }) });
      assert.equal(res502Large.status, 502);
      assert.equal((await res502Large.json()).error.code, 'upstream_payload_too_large');
      assertAllowedCorsHeaders(res502Large, 'null');

      const res504 = await handleOpenJevSystemOne(new Request(ENDPOINT, {
        method: 'POST',
        headers: { origin: 'null', authorization: AUTH },
        body: JSON.stringify({ prompt: 'slow' }),
      }), {
        timeoutMs: 15,
        fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        }),
      });
      assert.equal(res504.status, 504);
      assert.equal((await res504.json()).error.code, 'upstream_timeout');
      assertAllowedCorsHeaders(res504, 'null');
    }

    // 5. Top-level worker.fetch routing: /api/jev/systemone allows Origin: null while other endpoints stay strict
    const topOpenJevPreflight = await worker.fetch(new Request(ENDPOINT, {
      method: 'OPTIONS',
      headers: { origin: 'null' },
    }), {}, {});
    assert.equal(topOpenJevPreflight.status, 204);
    assertAllowedCorsHeaders(topOpenJevPreflight, 'null');

    const otherApiPreflight = await worker.fetch(new Request(WORKER_ORIGIN + '/api/ai/turn', {
      method: 'OPTIONS',
      headers: { origin: 'null' },
    }), {}, {});
    assert.equal(otherApiPreflight.status, 403);
    assertNoCorsOrigin(otherApiPreflight);

    const bootstrapPreflight = await worker.fetch(new Request(WORKER_ORIGIN + '/runtime/bootstrap', {
      method: 'OPTIONS',
      headers: { origin: 'null' },
    }), {}, {});
    assert.equal(bootstrapPreflight.status, 403);
    assertNoCorsOrigin(bootstrapPreflight);

    const bootstrapPost = await worker.fetch(new Request(WORKER_ORIGIN + '/runtime/bootstrap', {
      method: 'POST',
      headers: { origin: 'null', 'content-type': 'application/json' },
      body: '{}',
    }), {}, {});
    assert.equal(bootstrapPost.status, 403);
    assertNoCorsOrigin(bootstrapPost);
  `;

  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 0, `subprocess failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
});

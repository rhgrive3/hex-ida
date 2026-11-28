import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sqliteD1 } from './sqlite-d1.mjs';
import { createAuthHandler } from '../../js/auth/server/router.js';
import { AuthRepository } from '../../js/auth/server/repository.js';
import { SECRET_RE, SESSION_COOKIE, deriveSecret, hash, randomSecret } from '../../js/auth/server/primitives.js';

const BASE = 'https://hex.test';
const OWNER = '111111111111111111';

function makeAuthFixture({ nowRef = { value: 1_700_000_000_000 }, oauthStartRateLimit = null } = {}) {
  const db = sqliteD1();
  const now = () => nowRef.value;
  const env = {
    AUTH_DB: db,
    HEX_OWNER_DISCORD_ID: OWNER,
    DISCORD_CLIENT_ID: '999999999999999999',
    DISCORD_CLIENT_SECRET: 'secret-123',
    DISCORD_REDIRECT_URI: `${BASE}/auth/discord/callback`,
  };
  const handler = createAuthHandler({ now, oauthStartRateLimit });
  const repo = new AuthRepository(db, OWNER, now);
  const request = (path, { method = 'GET', body, cookie, origin, csrf, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (origin) h.origin = origin;
    if (csrf) h['x-hex-csrf'] = csrf;
    if (body !== undefined) h['content-type'] = 'application/json';
    return handler(new Request(`${BASE}${path}`, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }), env);
  };
  return { db, env, repo, handler, request, nowRef };
}

test('deriveSecret produces deterministic 43-char base64url matching SECRET_RE without altering hash()', async () => {
  const a = await deriveSecret('hex-csrf-v1:sample-token');
  const b = await deriveSecret('hex-csrf-v1:sample-token');
  const c = await deriveSecret('hex-csrf-v1:other-token');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 43);
  assert.match(a, SECRET_RE);
  const hexHash = await hash('hex-csrf-v1:sample-token');
  assert.equal(hexHash.length, 64);
  assert.match(hexHash, /^[0-9a-f]{64}$/);
});

test('multi-tab GET /api/auth/csrf returns stable 43-char base64url token and both tabs pass validateMutation', async () => {
  const f = makeAuthFixture();
  try {
    await f.repo.loginUser({ id: OWNER, username: 'owner' });
    const sessionToken = await f.repo.issueSession(OWNER, 'web');
    const cookieHeader = `${SESSION_COOKIE}=${sessionToken}`;

    const r1 = await f.request('/api/auth/csrf', { cookie: cookieHeader });
    assert.equal(r1.status, 200);
    const { csrfToken: tab1Token } = await r1.json();
    assert.match(tab1Token, SECRET_RE);

    const r2 = await f.request('/api/auth/csrf', { cookie: cookieHeader });
    assert.equal(r2.status, 200);
    const { csrfToken: tab2Token } = await r2.json();
    assert.equal(tab2Token, tab1Token);

    // Tab 1 and Tab 2 can both mutate without invalidating each other
    const m1 = await f.request('/api/admin/users', {
      method: 'POST',
      cookie: cookieHeader,
      origin: BASE,
      csrf: tab1Token,
      body: { discordId: '222222222222222222' },
    });
    assert.equal(m1.status, 201);

    const m2 = await f.request('/api/admin/users', {
      method: 'POST',
      cookie: cookieHeader,
      origin: BASE,
      csrf: tab2Token,
      body: { discordId: '333333333333333333' },
    });
    assert.equal(m2.status, 201);

    // Different session derives a different CSRF token
    const sessionToken2 = await f.repo.issueSession(OWNER, 'web');
    const r3 = await f.request('/api/auth/csrf', { cookie: `${SESSION_COOKIE}=${sessionToken2}` });
    assert.equal(r3.status, 200);
    const { csrfToken: otherSessionToken } = await r3.json();
    assert.notEqual(otherSessionToken, tab1Token);
  } finally {
    f.db.close();
  }
});

test('OAuth start endpoints enforce per-IP rate limit via cf-connecting-ip with 429, Retry-After, window reset, and Map eviction', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const f = makeAuthFixture({
    nowRef,
    oauthStartRateLimit: { windowMs: 10_000, maxRequests: 2, maxEntries: 2 },
  });
  try {
    // Missing cf-connecting-ip (even with X-Forwarded-For) skips rate limit
    for (let i = 0; i < 4; i++) {
      const res = await f.request('/auth/discord/start', {
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });
      assert.equal(res.status, 302);
    }

    // With cf-connecting-ip: 2 allowed across web + userscript start, 3rd returns 429 + Retry-After
    const ok1 = await f.request('/auth/discord/start', {
      headers: { 'cf-connecting-ip': '198.51.100.1' },
    });
    assert.equal(ok1.status, 302);

    const ok2 = await f.request('/api/auth/userscript/start', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '198.51.100.1' },
      body: { openerOrigin: 'https://chatgpt.com' },
    });
    assert.equal(ok2.status, 200);

    nowRef.value += 2_500;
    const limitedWeb = await f.request('/auth/discord/start', {
      headers: { 'cf-connecting-ip': '198.51.100.1' },
    });
    assert.equal(limitedWeb.status, 429);
    assert.deepEqual(await limitedWeb.json(), { error: 'rate-limited' });
    assert.equal(limitedWeb.headers.get('retry-after'), '8');

    const limitedUserscript = await f.request('/api/auth/userscript/start', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '198.51.100.1' },
      body: { openerOrigin: 'https://chatgpt.com' },
    });
    assert.equal(limitedUserscript.status, 429);
    assert.equal(limitedUserscript.headers.get('retry-after'), '8');

    // Fill maxEntries=2 and verify oldest IP eviction when a 3rd IP arrives
    const ip2 = await f.request('/auth/discord/start', {
      headers: { 'cf-connecting-ip': '198.51.100.2' },
    });
    assert.equal(ip2.status, 302);

    const ip3 = await f.request('/auth/discord/start', {
      headers: { 'cf-connecting-ip': '198.51.100.3' },
    });
    assert.equal(ip3.status, 302);

    // Oldest entry (198.51.100.1) was evicted so it can start again
    const afterEvict = await f.request('/auth/discord/start', {
      headers: { 'cf-connecting-ip': '198.51.100.1' },
    });
    assert.equal(afterEvict.status, 302);

    // Advance past windowMs and verify expired sweep resets counters
    nowRef.value += 11_000;
    const afterWindow = await f.request('/auth/discord/start', {
      headers: { 'cf-connecting-ip': '198.51.100.1' },
    });
    assert.equal(afterWindow.status, 302);
  } finally {
    f.db.close();
  }
});

test('AuthRepository.pruneSessions removes expired and revoked sessions, preserves active ones, and handles batchSize=1', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const f = makeAuthFixture({ nowRef });
  try {
    // Verify 0003_sessions_revoked_at.sql index exists
    const idx = await f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_revoked_at'").first();
    assert.equal(idx?.name, 'sessions_revoked_at');

    await f.repo.loginUser({ id: OWNER, username: 'owner' });
    const expired1 = await hash(randomSecret());
    const expired2 = await hash(randomSecret());
    const revoked1 = await hash(randomSecret());
    const active1 = await hash(randomSecret());

    const insert = (tokenHash, expiresAt, revokedAt = null) => f.db.prepare(
      'INSERT INTO sessions (token_hash, discord_id, kind, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(tokenHash, OWNER, 'web', nowRef.value - 10_000, expiresAt, revokedAt).run();

    await insert(expired1, nowRef.value - 5_000, null);
    await insert(expired2, nowRef.value - 1_000, null);
    await insert(revoked1, nowRef.value + 50_000, nowRef.value - 2_000);
    await insert(active1, nowRef.value + 50_000, null);

    // Boundary batchSize = 1: expiredLimit=1, revokedLimit=0
    const first = await f.repo.pruneSessions(1);
    assert.equal(first.limit, 1);
    assert.equal(first.deleted, 1);

    // Second pass prunes remaining expired + revoked while keeping active
    const second = await f.repo.pruneSessions(10);
    assert.equal(second.limit, 10);
    assert.equal(second.deleted, 2);

    const remaining = await f.db.prepare('SELECT token_hash FROM sessions').all();
    assert.deepEqual(remaining.results.map((row) => row.token_hash), [active1]);
  } finally {
    f.db.close();
  }
});

test('worker-entry OpenJev proxy bounds (413/502/504), CORS Authorization header, and scheduled partial-failure isolation', () => {
  const script = `
    import vm from 'node:vm';
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { webcrypto } from 'node:crypto';
    import { sqliteD1 } from './tests/auth/sqlite-d1.mjs';
    import { AuthRepository } from './js/auth/server/repository.js';
    import { hash, randomSecret } from './js/auth/server/primitives.js';

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
    assert.equal(typeof handleOpenJevSystemOne, 'function');

    // 1. CORS preflight exposes Authorization for CHATGPT_ORIGINS
    const preflight = await handleOpenJevSystemOne(new Request('https://hex.test/api/jev/systemone', {
      method: 'OPTIONS',
      headers: { origin: 'https://chatgpt.com' },
    }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://chatgpt.com');
    assert.match(preflight.headers.get('access-control-allow-headers') || '', /Authorization/i);

    // 2. Request body > 512 KiB (streamed without content-length) -> 413 payload_too_large & cancels stream
    let reqCancelled = false;
    let reqChunks = 0;
    const oversizedReqStream = new ReadableStream({
      pull(controller) {
        reqChunks += 1;
        controller.enqueue(new Uint8Array(300 * 1024).fill(65));
        if (reqChunks >= 4) controller.close();
      },
      cancel() { reqCancelled = true; },
    });
    const res413 = await handleOpenJevSystemOne(new Request('https://hex.test/api/jev/systemone', {
      method: 'POST',
      headers: { origin: 'https://chatgpt.com', authorization: 'Bearer token-123456' },
      body: oversizedReqStream,
      duplex: 'half',
    }), { fetchImpl: async () => { throw new Error('must not fetch'); } });
    assert.equal(res413.status, 413);
    assert.equal((await res413.json()).error.code, 'payload_too_large');
    assert.equal(reqCancelled, true);

    // 3. Upstream timeout -> 504 upstream_timeout
    const res504 = await handleOpenJevSystemOne(new Request('https://hex.test/api/jev/systemone', {
      method: 'POST',
      headers: { origin: 'https://chatgpt.com', authorization: 'Bearer token-123456' },
      body: JSON.stringify({ q: 1 }),
    }), {
      timeoutMs: 25,
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

    // 4. Upstream response > 512 KiB (streamed) -> 502 upstream_payload_too_large & cancels stream
    let upstreamCancelled = false;
    let upChunks = 0;
    const oversizedUpstream = new ReadableStream({
      pull(controller) {
        upChunks += 1;
        controller.enqueue(new Uint8Array(300 * 1024).fill(67));
        if (upChunks >= 4) controller.close();
      },
      cancel() { upstreamCancelled = true; },
    });
    const res502 = await handleOpenJevSystemOne(new Request('https://hex.test/api/jev/systemone', {
      method: 'POST',
      headers: { origin: 'https://chatgpt.com', authorization: 'Bearer token-123456' },
      body: JSON.stringify({ q: 2 }),
    }), {
      fetchImpl: async () => new Response(oversizedUpstream, { status: 200 }),
    });
    assert.equal(res502.status, 502);
    assert.equal((await res502.json()).error.code, 'upstream_payload_too_large');
    assert.equal(upstreamCancelled, true);

    // 5. Normal upstream proxy returns 200 with CORS Authorization header
    const res200 = await handleOpenJevSystemOne(new Request('https://hex.test/api/jev/systemone', {
      method: 'POST',
      headers: { origin: 'https://chatgpt.com', authorization: 'Bearer token-123456' },
      body: JSON.stringify({ ok: true }),
    }), {
      fetchImpl: async () => new Response(JSON.stringify({ result: 'ok' }), { status: 200 }),
    });
    assert.equal(res200.status, 200);
    assert.deepEqual(await res200.json(), { result: 'ok' });
    assert.match(res200.headers.get('access-control-allow-headers') || '', /Authorization/i);

    // 6. scheduled() runs pruneSessions even if pruneOAuthTransactions rejects, then rethrows failure
    const db = sqliteD1();
    try {
      const owner = '111111111111111111';
      const repo = new AuthRepository(db, owner, Date.now);
      await repo.loginUser({ id: owner, username: 'owner' });
      const expiredHash = await hash(randomSecret());
      await db.prepare('INSERT INTO sessions (token_hash, discord_id, kind, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(expiredHash, owner, 'web', Date.now() - 20_000, Date.now() - 10_000, null).run();

      // Break oauth_transactions table so pruneOAuthTransactions fails while sessions remains intact
      db.sqlite.exec('DROP TABLE oauth_transactions');

      let threw = false;
      try {
        await worker.scheduled({}, { AUTH_DB: db, HEX_OWNER_DISCORD_ID: owner });
      } catch {
        threw = true;
      }
      assert.equal(threw, true, 'scheduled must rethrow rejected cleanup failure');
      const remaining = await db.prepare('SELECT token_hash FROM sessions').all();
      assert.equal(remaining.results.length, 0, 'pruneSessions must still execute when pruneOAuthTransactions fails');
    } finally {
      db.close();
    }
  `;

  execFileSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '-e', script], {
    cwd: new URL('../../', import.meta.url),
    timeout: 20_000,
    stdio: 'pipe',
    maxBuffer: 512 * 1024,
  });
});

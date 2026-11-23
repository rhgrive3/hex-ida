import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mintAICapability, verifyAICapability, AI_CAPABILITY_TTL_MS } from '../js/auth/server/ai-capability.js';
import { AuthError } from '../js/auth/server/primitives.js';
import { createAuthHandler } from '../js/auth/server/router.js';
import { AuthRepository } from '../js/auth/server/repository.js';
import { sqliteD1 } from './auth/sqlite-d1.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = new Uint8Array(32).fill(7);
const buildId = `${'a'.repeat(24)}.${'b'.repeat(24)}`;
const subject = 'c'.repeat(64);
const otherSubject = 'd'.repeat(64);

test('Bug 1: verifyAICapability fails closed when subject is explicitly null/empty/invalid or requireSubject is true', async () => {
  const now = 1_700_000_000_000;
  const grant = await mintAICapability({ signingKey: key, buildId, subject, now });

  assert.ok(await verifyAICapability(grant.capability, { signingKey: key, buildId, now: now + 1000, subject, requireSubject: true }));
  assert.equal(await verifyAICapability(grant.capability, { signingKey: key, buildId, now: now + 1000, subject: null }), null);
  assert.equal(await verifyAICapability(grant.capability, { signingKey: key, buildId, now: now + 1000, subject: undefined }), null);
  assert.equal(await verifyAICapability(grant.capability, { signingKey: key, buildId, now: now + 1000, subject: '' }), null);
  assert.equal(await verifyAICapability(grant.capability, { signingKey: key, buildId, now: now + 1000, subject: 'not-a-sha256' }), null);
  assert.equal(await verifyAICapability(grant.capability, { signingKey: key, buildId, now: now + 1000, subject: otherSubject }), null);
  assert.equal(await verifyAICapability(grant.capability, { signingKey: key, buildId, now: now + 1000, requireSubject: true }), null);
});

test('Bug 3: mintAICapability handles sub-second remaining session TTL without 503 and returns 401 AuthError when expired', async () => {
  // Same-second sub-second remaining (600ms left)
  const nowSameSec = 1_700_000_000_200;
  const expSameSec = 1_700_000_000_800;
  const grantSameSec = await mintAICapability({ signingKey: key, buildId, subject, now: nowSameSec, sessionExpiresAt: expSameSec });
  assert.ok(grantSameSec.expiresAt <= expSameSec, 'returned expiresAt must not exceed sessionExpiresAt');
  assert.ok(await verifyAICapability(grantSameSec.capability, { signingKey: key, buildId, now: nowSameSec, subject, requireSubject: true }));
  assert.equal(await verifyAICapability(grantSameSec.capability, { signingKey: key, buildId, now: nowSameSec + 1000, subject, requireSubject: true }), null);

  // 1ms remaining across second boundary
  const nowCross = 1_700_000_000_999;
  const expCross = 1_700_000_001_000;
  const grantCross = await mintAICapability({ signingKey: key, buildId, subject, now: nowCross, sessionExpiresAt: expCross });
  assert.equal(grantCross.expiresAt, expCross);
  assert.ok(await verifyAICapability(grantCross.capability, { signingKey: key, buildId, now: nowCross, subject, requireSubject: true }));

  // Normal full TTL remains exact
  const nowExact = 1_700_000_000_000;
  const grantFull = await mintAICapability({ signingKey: key, buildId, subject, now: nowExact });
  assert.equal(grantFull.expiresAt, nowExact + AI_CAPABILITY_TTL_MS);

  // Already expired (0ms or negative remaining) throws AuthError(401), not TypeError
  for (const expiredAt of [nowSameSec, nowSameSec - 1, -Infinity, Number.NaN]) {
    await assert.rejects(
      () => mintAICapability({ signingKey: key, buildId, subject, now: nowSameSec, sessionExpiresAt: expiredAt }),
      (err) => err instanceof AuthError && err.status === 401,
    );
  }
});

test('Bug 3: /api/auth/ai-capability returns 200 (not 503) when session has <1s remaining', async () => {
  const db = sqliteD1();
  try {
    const owner = '111111111111111111';
    let currentNow = 1_700_000_000_200;
    const repo = new AuthRepository(db, owner, () => currentNow);
    await repo.loginUser({ id: owner, username: 'owner' });
    const token = await repo.issueSession(owner, 'userscript');

    // Move session expiry to 500ms after currentNow (same second)
    db.sqlite.prepare('UPDATE sessions SET expires_at = ?').run(currentNow + 500);

    const handler = createAuthHandler({ aiCapability: { signingKey: key, buildId }, now: () => currentNow });
    const env = { AUTH_DB: db, HEX_OWNER_DISCORD_ID: owner };

    const res = await handler(new Request('https://hex.test/api/auth/ai-capability', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    }), env);
    assert.equal(res.status, 200, 'sub-second remaining session must not return 503');
    const body = await res.json();
    assert.ok(typeof body.capability === 'string');
    assert.ok(body.expiresAt <= currentNow + 500);
    assert.ok(await verifyAICapability(body.capability, { signingKey: key, buildId, now: currentNow }));

    // Once expired, route returns 401 (never 503)
    currentNow += 500;
    const expiredRes = await handler(new Request('https://hex.test/api/auth/ai-capability', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    }), env);
    assert.equal(expiredRes.status, 401);
  } finally {
    db.close();
  }
});

test('Bug 1 & Bug 2: worker-entry.js path normalization blocks private/auth bypasses and rejects malformed Authorization headers', () => {
  const script = `
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { sqliteD1 } from './tests/auth/sqlite-d1.mjs';
import { AuthRepository } from './js/auth/server/repository.js';

const root = pathToFileURL(path.resolve(${JSON.stringify(repoRoot)}) + '/');
const buildId = 'a'.repeat(24) + '.' + 'b'.repeat(24);
const signingKey = Buffer.alloc(32, 7).toString('base64url');
const context = vm.createContext({
  Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
  AbortController, AbortSignal, crypto: webcrypto, console, setTimeout, clearTimeout,
  setInterval, clearInterval, atob, btoa, performance, structuredClone,
});
const cache = new Map();
async function moduleFor(id) {
  if (cache.has(id)) return cache.get(id);
  let source;
  if (id === 'cloudflare:workers') source = 'export class DurableObject { constructor() {} }';
  else if (id.endsWith('/.runtime-build/runtime-secrets.js')) source = \`export const RUNTIME_BUILD={manifest:{buildId:\${JSON.stringify('a'.repeat(24))},privileged:{buildId:\${JSON.stringify(buildId)}}},signingKey:\${JSON.stringify(signingKey)}};\`;
  else if (id.endsWith('/.runtime-build/privileged-assets.js')) source = \`export const PRIVILEGED_BUILD=\${JSON.stringify({ buildId, parentSource: '/* p */', childSource: '/* c */', adminSource: '/* a */' })};\`;
  else source = await readFile(new URL(id), 'utf8');
  const mod = new vm.SourceTextModule(source, { context, identifier: id, initializeImportMeta(meta) { meta.url = id; } });
  cache.set(id, mod);
  return mod;
}
const entry = await moduleFor(new URL('worker-entry.js', root).href);
await entry.link((specifier, referring) => moduleFor(specifier.startsWith('cloudflare:') ? specifier : new URL(specifier, referring.identifier).href));
await entry.evaluate({ timeout: 10000 });

const worker = entry.namespace.default;
const { isPrivatePath } = entry.namespace.__runtimeTest;

// Bug 2 unit checks on isPrivatePath
const blockedUnitPaths = [
  '//userscript/hex.user.template.js',
  '///js/app.js',
  '//package.json',
  '//userscript',
  '//userscript/',
  '/%2e/userscript/hex.user.template.js',
  '/%2E/js/app.js',
  '/public/%2e%2e/userscript/hex.user.template.js',
  '/%2e%2e/package.json',
  '/userscript/%2e',
  '/%2e/%2e/worker-entry.js',
  '/%2fuserscript/hex.user.template.js',
  '/js%2fapp.js',
  '/%E0%A4%A',
  '/%',
  '/%ZZ/index.html',
  '/%252e/userscript/hex.user.template.js',
  '/%5cuserscript/hex.user.template.js',
  '/%00/index.html',
];
for (const p of blockedUnitPaths) {
  assert.equal(isPrivatePath(p), true, 'isPrivatePath must block: ' + p);
}
for (const p of ['/', '/index.html', '/hex.user.js', '/assets/app.js']) {
  assert.equal(isPrivatePath(p), false, 'isPrivatePath must allow public path: ' + p);
}

// Bug 2 end-to-end checks via worker.fetch
const db = sqliteD1();
const owner = '111111111111111111';
const repo = new AuthRepository(db, owner);
const assetHits = [];
const env = {
  AUTH_DB: db,
  HEX_OWNER_DISCORD_ID: owner,
  GEMINI_API_KEY: 'fixture',
  ASSETS: { fetch(req) { assetHits.push(new URL(req.url).pathname); return new Response('public'); } },
};
try {
  const blocked404Paths = [
    ...blockedUnitPaths,
    '//admin/app.js',
    '/%61dmin/app.js',
    '//_privileged/dev/' + buildId + '/child.js',
    '//api/ai/turn',
  ];
  for (const p of blocked404Paths) {
    const res = await worker.fetch(new Request('https://hex.test' + p), env, {});
    assert.equal(res.status, 404, 'worker.fetch must block with 404: ' + p);
  }
  // Encoded dot-segments targeting auth routes are normalized by WHATWG URL to canonical auth routes (401) or blocked by prefilter (404), never reaching ASSETS
  for (const p of ['/%2e/admin/app.js', '/public/%2e%2e/admin/app.js', '/%2e/_privileged/dev/' + buildId + '/child.js']) {
    const res = await worker.fetch(new Request('https://hex.test' + p), env, {});
    assert.ok([401, 404].includes(res.status), 'auth alias must never reach ASSETS: ' + p);
  }
  assert.equal(assetHits.length, 0, 'blocked paths must never reach ASSETS');

  // Protected runtime route keeps its own authorization-before-decode boundary
  const badRuntime = await worker.fetch(new Request('https://hex.test/_runtime/%E0%A4%A', { headers: { origin: 'https://chatgpt.com' } }), env, {});
  assert.equal(badRuntime.status, 400, '/_runtime malformed percent encoding still reaches protectedRuntime 400');

  // Bug 1: Malformed Authorization header or mismatched Bearer token must NOT bypass sid verification
  await repo.loginUser({ id: owner, username: 'Owner' });
  const token1 = await repo.issueSession(owner, 'userscript');
  const token2 = await repo.issueSession(owner, 'userscript');
  const capRes = await worker.fetch(new Request('https://hex.test/api/auth/ai-capability', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token1, 'content-type': 'application/json' },
    body: '{}',
  }), env, {});
  assert.equal(capRes.status, 200);
  const { capability } = await capRes.json();

  const postTurn = (headers) => worker.fetch(new Request('https://hex.test/api/ai/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hex-ai-capability': capability, ...headers },
    body: 'null',
  }), env, {});

  // Valid matching Bearer passes gate and reaches worker validation (400 on 'null' body)
  assert.equal((await postTurn({ authorization: 'Bearer ' + token1 })).status, 400, 'matching Bearer token must pass');
  // Different valid-format Bearer fails sid binding (401)
  assert.equal((await postTurn({ authorization: 'Bearer ' + token2 })).status, 401, 'different Bearer token must fail sid binding');
  // Malformed Authorization headers must fail closed (401), never fall back to subject=null
  for (const badAuth of ['', 'Bearer ', 'Bearer short', 'Basic dXNlcjpwYXNz', 'Token ' + token1]) {
    assert.equal((await postTurn({ authorization: badAuth })).status, 401, 'malformed Authorization must fail: ' + JSON.stringify(badAuth));
  }
} finally {
  db.close();
}
`;
  execFileSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '-e', script], {
    cwd: repoRoot,
    timeout: 15000,
    stdio: 'pipe',
  });
});

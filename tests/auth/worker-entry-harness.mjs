import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { sqliteD1 } from './sqlite-d1.mjs';
import { AuthRepository } from '../../js/auth/server/repository.js';

// Execute the actual Worker module graph. Only Cloudflare's host base class and
// generated build bytes are fixtures; routing/auth/SQL are production modules.
const root = new URL('../../', import.meta.url), buildId = 'a'.repeat(24) + '.' + 'b'.repeat(24), signingKey = Buffer.alloc(32, 7).toString('base64url');
const context = vm.createContext({ Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal, crypto: webcrypto, console, setTimeout, clearTimeout, setInterval, clearInterval, atob, btoa, performance, structuredClone });
const cache = new Map();
async function moduleFor(id) {
  if (cache.has(id)) return cache.get(id);
  let source;
  if (id === 'cloudflare:workers') source = 'export class DurableObject { constructor() {} }';
  else if (id.endsWith('/.runtime-build/runtime-secrets.js')) source = `export const RUNTIME_BUILD={manifest:{buildId:${JSON.stringify('a'.repeat(24))},privileged:{buildId:${JSON.stringify(buildId)}}},signingKey:${JSON.stringify(signingKey)}};`;
  else if (id.endsWith('/.runtime-build/privileged-assets.js')) source = `export const PRIVILEGED_BUILD=${JSON.stringify({ buildId, parentSource: '/* private parent */', childSource: '/* private child */', adminSource: '/* private admin */' })};`;
  else source = await readFile(new URL(id), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: id, initializeImportMeta(meta) { meta.url = id; } });
  cache.set(id, module); return module;
}
const entry = await moduleFor(new URL('worker-entry.js', root).href);
await entry.link((specifier, referring) => moduleFor(specifier.startsWith('cloudflare:') ? specifier : new URL(specifier, referring.identifier).href));
await entry.evaluate({ timeout: 10000 });
const worker = entry.namespace.default, db = sqliteD1(), owner = '111111111111111111';
const repo = new AuthRepository(db, owner), assets = [];
const env = { AUTH_DB: db, HEX_OWNER_DISCORD_ID: owner, ASSETS: { fetch(request) { assets.push(new URL(request.url).pathname); return new Response('public backing'); } } };
const get = (path, token) => worker.fetch(new Request('https://hex.test' + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }), env, {});
try {
  const rawPaths = ['/.runtime-build/privileged-assets.js', '/.runtime/runtime.bin', '/js/auth/privileged/child-entry.js', '/js/auth/admin-app.js', '/auth-assets/admin.js', '/scripts/build-userscript.mjs', '/migrations/auth/0001_auth.sql', '/%2e%72untime-build/privileged-assets.js', '/%61dmin/app.js', '/ad%6din/app.js', '/%2561dmin/app.js'];
  for (const path of rawPaths) { const response = await get(path); assert.equal(response.status, 404, path); }
  assert.equal(assets.length, 0, 'raw private assets never reach ASSETS');
  assert.equal((await get('/admin/app.js')).status, 401);
  assert.equal((await get('/api/admin/users')).status, 401);
  const authPreflight = await worker.fetch(new Request('https://hex.test/api/auth/userscript/start', { method: 'OPTIONS', headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }), env, {});
  assert.equal(authPreflight.status, 403, 'auth preflight must not fall through to generic /api CORS');
  assert.equal(authPreflight.headers.get('access-control-allow-origin'), null);
  const genericPreflight = await worker.fetch(new Request('https://hex.test/api/ai/test', { method: 'OPTIONS', headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST' } }), env, {});
  assert.equal(genericPreflight.status, 204, 'existing generic API CORS remains unchanged');
  assert.equal(genericPreflight.headers.get('access-control-allow-origin'), 'https://chatgpt.com');
  assert.equal((await get(`/_privileged/dev/${buildId}/child.js`)).status, 401);
  for (const [id, role] of [['222222222222222222', 'free'], ['333333333333333333', 'vip']]) {
    await repo.loginUser({ id, username: role }); db.sqlite.prepare('UPDATE users SET role=? WHERE discord_id=?').run(role, id);
    const token = await repo.issueSession(id, 'userscript');
    for (const path of ['/admin/', '/admin/app.js', '/api/admin/users', `/_privileged/dev/${buildId}/parent.js`, `/_privileged/dev/${buildId}/child.js`]) assert.equal((await get(path, token)).status, 403, `${role} ${path}`);
  }
  await repo.loginUser({ id: owner, username: 'Owner' }); const token = await repo.issueSession(owner, 'userscript');
  let quotaLookups = 0;
  env.GEMINI_API_KEY = 'server-only-fixture';
  env.OPENJEV_API_KEY = 'server-only-openjev-fixture';
  env.AI_QUOTA = { getByName() { quotaLookups++; throw new Error('quota must not be reached by rejected authorization'); } };
  const aiRequest = (path, headers = {}, body = '{}') => worker.fetch(new Request('https://hex.test' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }), env, {});
  assert.equal((await aiRequest('/api/ai/turn')).status, 401, 'missing AI capability must fail before worker dispatch');
  assert.equal((await aiRequest('/api/ai/turn', { origin: 'https://chatgpt.com' })).status, 401, 'allowed CORS origin is not authorization');
  assert.equal((await aiRequest('/api/ai/turn', { 'x-hex-session': 'attacker-session' })).status, 401, 'client session id is not authorization');
  assert.equal((await aiRequest('/api/gemini')).status, 401, 'legacy provider-spend route uses the same gate');
  assert.equal((await aiRequest('/api/semantic-rank')).status, 401, 'semantic-rank uses the same provider-spend gate');
  assert.equal(quotaLookups, 0, 'rejected requests must not acquire distributed quota');
  const capResponse = await worker.fetch(new Request('https://hex.test/api/auth/ai-capability', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }), env, {});
  assert.equal(capResponse.status, 200);
  const cap = await capResponse.json();
  // Use a deterministically malformed JSON value so the assertion checks only
  // that capability admission reaches worker validation, not which missing
  // field the normalizer reports first.
  const admitted = await aiRequest('/api/ai/turn', { 'x-hex-ai-capability': cap.capability }, 'null');
  assert.equal(admitted.status, 400, 'valid capability passes admission and reaches request validation');
  const semanticAdmitted = await aiRequest('/api/semantic-rank', { 'x-hex-ai-capability': cap.capability }, 'null');
  assert.equal(semanticAdmitted.status, 400, 'semantic-rank reaches request validation only after capability admission');
  assert.equal(quotaLookups, 0, 'invalid AI payload still fails before quota after successful auth');
  const preflight = await worker.fetch(new Request('https://hex.test/api/ai/turn', { method: 'OPTIONS', headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-hex-ai-capability' } }), env, {});
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /X-Hex-AI-Capability/i);
  const privateChild = await get(`/_privileged/dev/${buildId}/child.js`, token);
  assert.equal(await privateChild.text(), '/* private child */');
  assert.equal(privateChild.headers.get('cross-origin-resource-policy'), 'same-origin');
  const privateAdmin = await get('/admin/app.js', token);
  assert.equal(await privateAdmin.text(), '/* private admin */');
  assert.equal(privateAdmin.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal((await get(`/_privileged/dev/${'c'.repeat(24)}.${'d'.repeat(24)}/child.js`, token)).status, 409);
  assert.equal(assets.length, 0);
  assert.equal((await get('/')).status, 200); assert.deepEqual(assets, ['/']);
  assert.equal((await worker.fetch(new Request('https://hex.test/'), { ASSETS: env.ASSETS }, {})).status, 200, 'missing AUTH_DB does not block Standard root');
  assert.equal((await get('/runtime/bootstrap')).status, 405, 'existing bootstrap method guard unchanged');
  console.log('Worker entry routing: PASS; actual module graph + real SQL; no private raw-asset fallback. Generated bundle bytes remain fixtures.');
} finally { db.close(); }

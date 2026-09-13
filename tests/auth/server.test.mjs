import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from './sqlite-d1.mjs';
import { createAuthHandler } from '../../js/auth/server/router.js';
import { AuthRepository } from '../../js/auth/server/repository.js';
import { ANONYMOUS_IDENTITY, capabilitiesFor, identityForUser } from '../../js/auth/capabilities.js';
import { hash, randomSecret, SESSION_COOKIE, OAUTH_COOKIE, TRANSACTION_TTL_MS } from '../../js/auth/server/primitives.js';

const BASE = 'https://hex.test', OWNER = '111111111111111111', FREE = '222222222222222222', ADMIN = '333333333333333333', VIP = '444444444444444444';
const BUILD = 'a'.repeat(24) + '.' + 'b'.repeat(24);
function setup(t, overrides = {}) {
  const db = sqliteD1(); t.after(() => db.close());
  let now = 1700000000000;
  const state = { profile: { id: FREE, username: 'user' }, mode: 'ok', calls: [], aborted: false };
  const fetchRef = async (url, init) => {
    state.calls.push({ url, init });
    if (state.mode === 'timeout') return new Promise((_, reject) => init.signal.addEventListener('abort', () => { state.aborted = true; reject(new Error('aborted')); }, { once: true }));
    if (url.endsWith('/oauth2/token')) {
      assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.equal(new URLSearchParams(init.body).get('grant_type'), 'authorization_code');
      return Response.json(state.mode === 'token-error' ? { error: 'bad' } : { access_token: 'discord-access-never-persist', refresh_token: 'discord-refresh-never-persist', token_type: 'Bearer' }, { status: state.mode === 'token-error' ? 400 : 200 });
    }
    assert.equal(url, 'https://discord.com/api/v10/users/@me');
    assert.equal(init.headers.authorization, 'Bearer discord-access-never-persist');
    return Response.json(state.profile, { status: state.mode === 'identity-error' ? 500 : 200 });
  };
  const env = { AUTH_DB: db, HEX_OWNER_DISCORD_ID: OWNER, DISCORD_CLIENT_ID: '999999999999999999', DISCORD_CLIENT_SECRET: 'mock-only-secret', DISCORD_REDIRECT_URI: `${BASE}/auth/discord/callback` };
  const handler = createAuthHandler({ privileged: { buildId: BUILD, parentSource: '// private parent', childSource: '// private child', adminSource: '// private admin' }, fetchRef, now: () => now, discordTimeoutMs: 20, ...overrides });
  const repo = new AuthRepository(db, OWNER, () => now);
  const request = (path, { method = 'GET', body, token, cookie: cookieHeader, origin, csrf, headers = {} } = {}) => {
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookieHeader) headers.cookie = cookieHeader;
    if (origin) headers.origin = origin;
    if (csrf) headers['x-hex-csrf'] = csrf;
    return handler(new Request(BASE + path, { method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env);
  };
  async function user(id, role = 'free', enabled = 1) {
    await repo.statement('INSERT INTO users (discord_id, username, role, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, `user_${id}`, role, enabled, now, now).run();
    return repo.issueSession(id, 'userscript');
  }
  async function startWeb(returnTo = '/') {
    const result = await request(`/auth/discord/start?return_to=${encodeURIComponent(returnTo)}`);
    const url = new URL(result.headers.get('location'));
    assert.equal(url.searchParams.get('scope'), 'identify');
    const binder = result.headers.get('set-cookie').split(';')[0];
    return { result, state: url.searchParams.get('state'), binder };
  }
  async function callback(start, options = {}) {
    return request(`/auth/discord/callback?state=${start.state}&code=mock-code`, { cookie: start.binder, ...options });
  }
  async function startScript() {
    const response = await request('/api/auth/userscript/start', { method: 'POST', body: { openerOrigin: 'https://chatgpt.com' } });
    assert.equal(response.status, 200);
    const data = await response.json();
    return { ...data, state: new URL(data.authorizationUrl).searchParams.get('state') };
  }
  async function scriptProof(start) {
    const response = await callback(start); assert.equal(response.status, 200);
    const text = await response.text();
    const proof = /"completionProof":"([A-Za-z0-9_-]{43})"/.exec(text)?.[1]; assert.ok(proof);
    return proof;
  }
  return { db, env, repo, state, request, user, startWeb, callback, startScript, scriptProof, advance: (ms) => { now += ms; } };
}

test('capability policy: Free/VIP/unknown/disabled fail closed; owner recovers', () => {
  for (const role of ['free', 'vip', 'invalid', '__proto__']) assert.equal(capabilitiesFor({ role, enabled: true }).canUseDevAgent, false);
  assert.equal(capabilitiesFor({ role: 'admin', enabled: false }).canManageUsers, false);
  for (const value of Object.values(capabilitiesFor({ role: 'admin', enabled: true }))) assert.equal(value, true);
  assert.equal(identityForUser({ discord_id: OWNER, role: 'free', enabled: 0 }, OWNER).admin, true);
  assert.deepEqual(identityForUser(null, OWNER), ANONYMOUS_IDENTITY);
});
test('web OAuth issues secure HEX cookie, first login Free, hashes only, state replay rejected', async (t) => {
  const f = setup(t), start = await f.startWeb('/admin/'), response = await f.callback(start);
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/admin/');
  const cookies = response.headers.getSetCookie();
  assert.match(cookies[0], /__Host-hex_session=.{43}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  assert.ok(!cookies[0].includes('Domain='));
  const row = await f.repo.user(FREE); assert.equal(row.role, 'free'); assert.equal(row.username, 'user');
  const dump = ['users', 'sessions', 'oauth_transactions'].map((name) => f.db.sqlite.prepare(`SELECT * FROM ${name}`).all());
  const serialized = JSON.stringify(dump);
  assert.ok(!serialized.includes('discord-access')); assert.ok(!serialized.includes('discord-refresh'));
  const raw = cookies[0].split(';')[0].split('=')[1]; assert.ok(!serialized.includes(raw));
  assert.equal((await f.request('/api/auth/me', { cookie: cookies[0].split(';')[0] })).status, 200);
  assert.equal((await f.callback(start)).status, 401);
});
test('web OAuth is browser-bound, rejects missing code, expiry, open redirects and state substitution', async (t) => {
  const f = setup(t), start = await f.startWeb();
  assert.equal((await f.callback(start, { cookie: undefined })).status, 401);
  assert.equal((await f.request(`/auth/discord/callback?state=${start.state}`, { cookie: start.binder })).status, 400);
  assert.equal((await f.callback({ state: randomSecret(), binder: start.binder })).status, 401);
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/admin/../evil']) assert.equal((await f.request(`/auth/discord/start?return_to=${encodeURIComponent(path)}`)).status, 400);
  f.advance(TRANSACTION_TTL_MS + 1); assert.equal((await f.callback(start)).status, 401);
});
test('OAuth preserves preregistered roles and enabled flag, updates username, restores owner', async (t) => {
  const f = setup(t); await f.user(FREE, 'vip');
  assert.equal((await f.callback(await f.startWeb())).status, 303);
  assert.equal((await f.repo.user(FREE)).role, 'vip');
  f.state.profile.username = 'renamed'; await f.callback(await f.startWeb()); assert.equal((await f.repo.user(FREE)).username, 'renamed');
  await f.repo.statement('UPDATE users SET enabled = 0 WHERE discord_id = ?', FREE).run();
  assert.equal((await f.callback(await f.startWeb())).status, 403); assert.equal((await f.repo.user(FREE)).enabled, 0);
  await f.user(OWNER, 'free', 0); f.state.profile = { id: OWNER, username: 'owner' };
  assert.equal((await f.callback(await f.startWeb())).status, 303);
  assert.equal((await f.repo.user(OWNER)).role, 'admin'); assert.equal((await f.repo.user(OWNER)).enabled, 1);
});
for (const mode of ['token-error', 'identity-error', 'timeout']) test(`OAuth ${mode} fails closed without session`, async (t) => {
  const f = setup(t); f.state.mode = mode;
  const response = await f.callback(await f.startWeb()); assert.equal(response.status, mode === 'timeout' ? 504 : 502);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.ok(!(await response.text()).includes('mock-only-secret'));
  if (mode === 'timeout') assert.equal(f.state.aborted, true);
});
test('userscript: poll is status-only; callback-browser proof required; concurrent redemption once', async (t) => {
  const f = setup(t), start = await f.startScript();
  const pairing = { transactionId: start.transactionId, pollSecret: start.pollSecret };
  let response = await f.request('/api/auth/userscript/poll', { method: 'POST', body: pairing });
  assert.deepEqual(await response.json(), { status: 'pending' });
  const proof = await f.scriptProof(start);
  // Regression: attacker owns transaction+poll secret, victim completes Discord.
  response = await f.request('/api/auth/userscript/poll', { method: 'POST', body: pairing });
  assert.deepEqual(await response.json(), { status: 'completed' });
  assert.equal((await f.request('/api/auth/userscript/complete', { method: 'POST', body: pairing })).status, 400);
  for (const invalid of [{ ...pairing, completionProof: randomSecret() }, { ...pairing, pollSecret: randomSecret(), completionProof: proof }]) assert.equal((await f.request('/api/auth/userscript/complete', { method: 'POST', body: invalid })).status, 401);
  const complete = () => f.request('/api/auth/userscript/complete', { method: 'POST', body: { ...pairing, completionProof: proof } });
  const results = await Promise.all([complete(), complete()]); assert.deepEqual(results.map((result) => result.status).sort(), [200, 401]);
  const token = (await results.find((result) => result.status === 200).json()).token;
  assert.equal((await f.request('/api/auth/me', { token })).status, 200);
  assert.equal((await f.request('/api/auth/me', { cookie: `${SESSION_COOKIE}=${token}` })).status, 401, 'kind cannot be swapped');
  assert.equal((await complete()).status, 401);
  const stored = JSON.stringify(f.db.sqlite.prepare('SELECT * FROM oauth_transactions').all());
  for (const raw of [start.pollSecret, proof, token]) assert.ok(!stored.includes(raw));
});
test('userscript proof expiry, poll-secret validation, disabled-before-complete, safe callback origin', async (t) => {
  const f = setup(t), start = await f.startScript(), proof = await f.scriptProof(start);
  const body = { transactionId: start.transactionId, pollSecret: start.pollSecret, completionProof: proof };
  assert.equal((await f.request('/api/auth/userscript/poll', { method: 'POST', body: { transactionId: start.transactionId, pollSecret: randomSecret() } })).status, 401);
  await f.repo.statement('UPDATE users SET enabled = 0 WHERE discord_id = ?', FREE).run();
  assert.equal((await f.request('/api/auth/userscript/complete', { method: 'POST', body })).status, 401);
  await f.repo.statement('UPDATE users SET enabled = 1 WHERE discord_id = ?', FREE).run();
  f.advance(120001); assert.equal((await f.request('/api/auth/userscript/complete', { method: 'POST', body })).status, 401);
  assert.equal((await f.request('/api/auth/userscript/start', { method: 'POST', body: { openerOrigin: 'https://evil.test' } })).status, 403);
});
test('sessions: current D1 role, expiry, revocation, owner effective recovery, logout', async (t) => {
  const f = setup(t), token = await f.user(ADMIN, 'admin');
  const source = `/_privileged/dev/${BUILD}/child.js`;
  assert.equal((await f.request(source, { token })).status, 200);
  await f.repo.statement("UPDATE users SET role = 'free' WHERE discord_id = ?", ADMIN).run();
  assert.equal((await f.request(source, { token })).status, 403);
  assert.equal((await (await f.request('/api/auth/me', { token })).json()).admin, false);
  await f.repo.statement('UPDATE users SET enabled = 0 WHERE discord_id = ?', ADMIN).run();
  assert.equal((await f.request('/api/auth/me', { token })).status, 401);
  const ownerToken = await f.user(OWNER, 'free', 0);
  assert.equal((await f.request('/api/admin/users', { token: ownerToken })).status, 200);
  assert.equal((await f.request('/auth/logout', { method: 'POST', body: {}, token: ownerToken })).status, 200);
  assert.equal((await f.request('/api/auth/me', { token: ownerToken })).status, 401);
  const freeToken = await f.user(FREE); f.advance(7 * 86400000 + 1); assert.equal((await f.request('/api/auth/me', { token: freeToken })).status, 401);
});
test('cookie mutation requires same-origin and valid session-bound CSRF', async (t) => {
  const f = setup(t); await f.user(OWNER, 'admin');
  const token = await f.repo.issueSession(OWNER, 'web'), cookieHeader = `${SESSION_COOKIE}=${token}`;
  const mutation = { method: 'POST', cookie: cookieHeader, body: { discordId: FREE } };
  assert.equal((await f.request('/api/admin/users', mutation)).status, 403);
  const csrf = (await (await f.request('/api/auth/csrf', { cookie: cookieHeader })).json()).csrfToken;
  assert.equal((await f.request('/api/admin/users', { ...mutation, csrf, origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.request('/api/admin/users', { ...mutation, csrf: randomSecret(), origin: BASE })).status, 403);
  assert.equal((await f.request('/api/admin/users', { ...mutation, csrf, origin: BASE })).status, 201);
  assert.equal((await f.request('/auth/logout', { method: 'POST', cookie: cookieHeader, csrf, origin: BASE, body: {} })).status, 200);
});
test('Admin API: roles, locked owner, preregistration, search, literal wildcards, bounded pagination, immutable audit', async (t) => {
  const f = setup(t), token = await f.user(OWNER, 'admin');
  assert.equal((await f.request('/api/admin/users')).status, 401);
  for (const [id, role] of [[FREE, 'free'], [VIP, 'vip']]) assert.equal((await f.request('/api/admin/users', { token: await f.user(id, role) })).status, 403);
  const options = { token, method: 'POST', body: { discordId: ADMIN } };
  assert.equal((await f.request('/api/admin/users', options)).status, 201);
  assert.equal((await f.repo.user(ADMIN)).role, 'free');
  assert.equal((await f.request('/api/admin/users', options)).status, 409);
  assert.equal((await f.request('/api/admin/users', { ...options, body: { discordId: ADMIN, role: 'admin' } })).status, 400);
  for (const role of ['vip', 'admin', 'free']) assert.equal((await f.request(`/api/admin/users/${ADMIN}`, { token, method: 'PATCH', body: { role } })).status, 200);
  assert.equal((await f.request(`/api/admin/users/${ADMIN}`, { token, method: 'PATCH', body: { enabled: false } })).status, 200);
  for (const body of [{ role: 'free' }, { enabled: false }]) assert.equal((await f.request(`/api/admin/users/${OWNER}`, { token, method: 'PATCH', body })).status, 403);
  assert.equal((await f.request(`/api/admin/users/${ADMIN}`, { token, method: 'PATCH', body: { role: 'superadmin' } })).status, 400);
  assert.equal((await f.request(`/api/admin/users/${ADMIN}`, { token, method: 'PATCH', body: { enabled: 'false' } })).status, 400);
  const search = await (await f.request(`/api/admin/users?q=${FREE}`, { token })).json(); assert.equal(search.users.length, 1);
  const username = await (await f.request(`/api/admin/users?q=user_${FREE}`, { token })).json(); assert.equal(username.users.length, 1);
  const wildcard = await (await f.request('/api/admin/users?q=%25', { token })).json(); assert.equal(wildcard.users.length, 0);
  assert.equal((await f.request('/api/admin/users?limit=1000', { token })).status, 400);
  assert.equal((await f.request('/api/admin/users?offset=99999', { token })).status, 400);
  const audit = await (await f.request('/api/admin/audit', { token })).json(); assert.equal(audit.entries.length, 5);
  assert.equal((await f.request('/api/admin/audit', { token, method: 'PATCH', body: {} })).status, 405);
  assert.throws(() => f.db.sqlite.exec('DELETE FROM audit_log'), /append-only/);
  assert.throws(() => f.db.sqlite.exec("UPDATE audit_log SET action = 'tampered'"), /append-only/);
});
test('SQL management transaction rechecks actor authority and audit rolls back on failure', async (t) => {
  const f = setup(t); await f.user(ADMIN, 'admin'); await f.user(FREE);
  const originalBatch = f.db.batch;
  f.db.batch = async (statements) => { f.db.sqlite.prepare("UPDATE users SET role = 'free' WHERE discord_id = ?").run(ADMIN); return originalBatch(statements); };
  await assert.rejects(f.repo.updateUser(ADMIN, FREE, { role: 'admin' }), /authority-changed/);
  assert.equal((await f.repo.user(FREE)).role, 'free'); assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 0);
  f.db.batch = originalBatch; await f.user(OWNER, 'admin');
  f.db.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
  await assert.rejects(f.repo.updateUser(OWNER, FREE, { role: 'vip' }), /disk failure/);
  assert.equal((await f.repo.user(FREE)).role, 'free');
});
test('private routes: admin assets and Dev source gate, wrong build, no source maps', async (t) => {
  const f = setup(t);
  assert.equal((await f.request('/admin/')).status, 302);
  assert.equal((await f.request('/admin/app.js')).status, 401);
  for (const [id, role, expected] of [[FREE, 'free', 403], [VIP, 'vip', 403], [ADMIN, 'admin', 200]]) {
    const token = await f.user(id, role);
    for (const path of ['/admin/', '/admin/app.js', `/_privileged/dev/${BUILD}/parent.js`, `/_privileged/dev/${BUILD}/child.js`]) {
      const response = await f.request(path, { token }); assert.equal(response.status, expected, path); assert.match(response.headers.get('cache-control'), /private.*no-store/); assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    }
    if (role === 'admin') {
      assert.equal((await f.request(`/_privileged/dev/${'c'.repeat(24)}.${'d'.repeat(24)}/child.js`, { token })).status, 409);
      assert.equal((await f.request('/admin/app.js.map', { token })).status, 404);
      assert.equal((await f.request('/api/auth/dev/authorize', { token, method: 'POST', body: { buildId: BUILD, policy: 'yolo' } })).status, 200);
    }
  }
});
test('malformed JSON, oversized stream, strict schema, unsupported method and missing configuration', async (t) => {
  const f = setup(t);
  assert.equal((await f.request('/api/auth/userscript/start', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await f.request('/api/auth/userscript/start', { method: 'POST', body: ' '.repeat(9000) })).status, 413);
  assert.equal((await f.request('/api/auth/userscript/start', { method: 'POST', body: [] })).status, 400);
  assert.equal((await f.request('/api/auth/userscript/start', { method: 'GET' })).status, 405);
  assert.equal((await f.request('/api/auth/me', { origin: 'null' })).status, 403);
  delete f.env.DISCORD_CLIENT_SECRET; assert.equal((await f.request('/auth/discord/start')).status, 503);
  f.env.DISCORD_CLIENT_SECRET = 'mock-only-secret'; delete f.env.HEX_OWNER_DISCORD_ID;
  assert.equal((await f.request('/api/auth/me')).status, 503, 'missing bootstrap owner must fail closed');
  f.env.HEX_OWNER_DISCORD_ID = OWNER; delete f.env.AUTH_DB; assert.equal((await f.request('/api/auth/me')).status, 503);
  assert.equal(await f.request('/api/ai/test'), null, 'unrelated Worker path untouched');
});

test('userscript auth is not browser-CORS readable from ChatGPT page JS', async (t) => {
  const f = setup(t);
  const preflight = await f.request('/api/auth/userscript/start', {
    method: 'OPTIONS',
    origin: 'https://chatgpt.com',
    headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);

  // A privileged GM transport may still carry a ChatGPT Origin header, but its
  // response deliberately has no ACAO so ordinary page JS cannot read it.
  const gmStyle = await f.request('/api/auth/userscript/start', {
    method: 'POST', origin: 'https://chatgpt.com', body: { openerOrigin: 'https://chatgpt.com' },
  });
  assert.equal(gmStyle.status, 200);
  assert.equal(gmStyle.headers.get('access-control-allow-origin'), null);
  const data = await gmStyle.json();
  assert.match(data.transactionId, /^[A-Za-z0-9_-]{43}$/);
  assert.match(data.pollSecret, /^[A-Za-z0-9_-]{43}$/);
});

test('Discord response-body stall is bounded and cancelled without persisting a session', async (t) => {
  let cancelled = false;
  const f = setup(t, { discordTimeoutMs: 15, fetchRef: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 }) });
  const response = await f.callback(await f.startWeb());
  assert.equal(response.status, 504);
  assert.equal(cancelled, true);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});
test('successful web login rotates the prior HEX session and auth never logs credentials', async (t) => {
  const logs = ['log', 'warn', 'error'].map((name) => t.mock.method(console, name, () => {}));
  const f = setup(t); await f.user(FREE);
  const old = await f.repo.issueSession(FREE, 'web'), start = await f.startWeb();
  const response = await f.callback(start, { cookie: `${start.binder}; ${SESSION_COOKIE}=${old}` });
  assert.equal(response.status, 303);
  assert.equal(await f.repo.session(await hash(old), 'web'), null);
  assert.equal((await f.repo.user(FREE)).role, 'free');
  assert.equal(logs.reduce((sum, mock) => sum + mock.mock.callCount(), 0), 0);
});

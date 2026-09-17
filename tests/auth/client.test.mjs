import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { sqliteD1 } from './sqlite-d1.mjs';
import { createAuthHandler } from '../../js/auth/server/router.js';
import { AuthRepository } from '../../js/auth/server/repository.js';
import { identityForUser, ANONYMOUS_IDENTITY } from '../../js/auth/capabilities.js';
import { createSessionClient, SessionAdminAuthProvider } from '../../js/auth/client.js';
import { createAuthTransport } from '../../js/auth/transport.js';
import { createAuthRpcServer, createAuthRpcClient } from '../../js/auth/rpc.js';
import { startParentAuth, startChildAuth } from '../../js/auth/runtime.js';
import { createAssistantExtensionHost } from '../../js/auth/assistant-host.js';
import { validCompletionMessage } from '../../js/auth/userscript-login.js';
import { DevAgentUiSettings } from '../../js/ai/dev/ui/settings.js';
import { createAgentProfileEngine } from '../../js/ai/dev/ui/engine-router.js';
import { AGENT_PROFILES } from '../../js/ai/dev/policy/agent-profile.js';
import { privilegedIdentity } from '../../scripts/auth-build-policy.mjs';

const BASE = 'https://hex.test', USER = '333333333333333333', OWNER = '111111111111111111';
const parentSource = 'export const parent=true;', childSource = '// child fixture', adminSource = '// admin fixture';
const manifest = privilegedIdentity('a'.repeat(24), parentSource, childSource, adminSource);
async function fixture(t, role = 'admin') {
  const db = sqliteD1(); t.after(() => db.close());
  const repo = new AuthRepository(db, OWNER);
  await repo.loginUser({ id: USER, username: '<img onerror=evil()>' });
  db.sqlite.prepare('UPDATE users SET role = ? WHERE discord_id = ?').run(role, USER);
  const token = await repo.issueSession(USER, 'userscript'), storage = new Map([['hex.auth.userscript.session.v1', token]]), requests = [];
  const handler = createAuthHandler({ privileged: { ...manifest, parentSource, childSource, adminSource: '//admin' }, fetchRef: () => { throw new Error('No external traffic in client tests'); } });
  const env = { AUTH_DB: db, HEX_OWNER_DISCORD_ID: OWNER };
  const manager = {
    getValue: async (key, fallback) => storage.get(key) ?? fallback,
    setValue: async (key, value) => { storage.set(key, value); },
    deleteValue: async (key) => { storage.delete(key); },
    xmlHttpRequest(options) {
      const controller = new AbortController();
      requests.push(options);
      void handler(new Request(options.url, { method: options.method, headers: options.headers, ...(options.data ? { body: options.data } : {}), signal: controller.signal }), env)
        .then(async (response) => options.onload({ status: response.status, responseText: await response.text(), responseHeaders: [...response.headers].map(([key, value]) => `${key}: ${value}`).join('\r\n'), finalUrl: options.url }))
        .catch(options.onerror);
      return { abort() { controller.abort(); options.onabort(); } };
    },
  };
  const client = createSessionClient({ apiOrigin: BASE, privilegedManifest: manifest, manager }); t.after(() => client.close());
  return { db, repo, client, manager, requests, token, storage, handler, env };
}
function stateful(role = 'admin') {
  let identity = identityForUser({ discord_id: USER, username: 'fixture', role, enabled: 1 }, OWNER);
  const listeners = new Set(), calls = [];
  const auth = {
    getIdentity: () => identity, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    initialize: async () => identity, refresh: async () => identity,
    authorize: async () => { calls.push('authorize'); if (!identity.admin) throw new Error('denied'); return identity; },
    source: async (kind) => { calls.push(kind); if (!identity.admin) throw new Error('denied'); return { ...manifest, source: kind, hash: manifest[`${kind}Hash`] }; },
    close() { calls.push('close'); }, logout: async () => {},
    set(value) { identity = identityForUser({ discord_id: USER, role: value, enabled: 1 }, OWNER); for (const fn of listeners) fn(identity); },
  };
  return { auth, calls };
}
test('actual session client + Worker SQL: private GM token, verified source, concurrent authorization, demotion and logout', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.client.initialize()).admin, true);
  assert.equal((await f.client.source('child')).source, childSource);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.client.authorize('normal')));
  assert.ok(results.every((identity) => identity.admin));
  for (const request of f.requests) {
    assert.equal(new URL(request.url).origin, BASE); assert.equal(request.anonymous, true);
    assert.equal(request.headers.authorization, `Bearer ${f.token}`);
    assert.ok(!request.url.includes(f.token));
  }
  assert.ok(!JSON.stringify(f.client).includes(f.token));
  f.db.sqlite.prepare("UPDATE users SET role='free' WHERE discord_id=?").run(USER);
  await assert.rejects(f.client.source('child'), /denied/);
  await assert.rejects(f.client.authorize('yolo'), /403/);
  assert.equal(f.client.getIdentity().admin, false);
  await f.client.logout(); assert.equal(f.storage.size, 0);
  assert.ok((await f.repo.session(await import('../../js/auth/server/primitives.js').then(({ hash }) => hash(f.token)), 'userscript')) === null);
});
test('Free/VIP sessions never fetch privileged sources; no GM storage remains anonymous', async (t) => {
  for (const role of ['free', 'vip']) {
    const f = await fixture(t, role); await f.client.initialize();
    await assert.rejects(f.client.source('parent'), /denied/);
    assert.equal(f.requests.some((request) => request.url.includes('_privileged')), false);
  }
  const client = createSessionClient({ apiOrigin: BASE, fetchRef: () => { throw new Error('must not fetch anonymous'); } });
  assert.equal((await client.initialize()).authenticated, false); client.close();
});
test('RPC carries only whitelisted identity and child source, never bearer or pairing secrets', async (t) => {
  const f = await fixture(t); await f.client.initialize();
  const { port1, port2 } = new MessageChannel(), messages = [];
  port2.addEventListener('message', (event) => messages.push(event.data));
  const server = createAuthRpcServer({ port: port1, auth: f.client, showLogin() {} });
  const child = createAuthRpcClient({ port: port2, timeoutMs: 500 });
  t.after(() => { server.close(); child.close(); port1.close(); port2.close(); });
  assert.equal((await child.refresh()).admin, true);
  assert.equal((await child.source('child')).source, childSource);
  assert.equal((await child.authorize('yolo')).admin, true);
  await assert.rejects(child.source('parent'), /not a child/);
  const serialized = JSON.stringify(messages);
  for (const forbidden of [f.token, 'pollSecret', 'completionProof', 'csrfToken', 'token_hash']) assert.ok(!serialized.includes(forbidden));
  assert.ok(!('startPairing' in child));
  f.db.sqlite.prepare("UPDATE users SET role='vip' WHERE discord_id=?").run(USER);
  await assert.rejects(child.authorize('normal'));
  assert.equal(child.getIdentity().admin, false);
});
test('production provider denies by default, clamps persisted Dev/YOLO, and retains two profiles', () => {
  assert.deepEqual(AGENT_PROFILES, ['standard', 'dev']);
  const values = new Map([['hex.ai.dev.settings.v1', JSON.stringify({ agentProfile: 'dev', decisionPolicy: 'yolo' })]]);
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const settings = new DevAgentUiSettings({ storage });
  assert.equal(settings.agentProfile, 'standard'); assert.equal(settings.decisionPolicy, 'normal');
  assert.throws(() => settings.setAgentProfile('dev'), /Admin/); assert.throws(() => settings.setDecisionPolicy('yolo'), /Admin/);
  settings.destroy();
  for (const role of ['free', 'vip']) {
    const { auth } = stateful(role), settings = new DevAgentUiSettings({ authProvider: new SessionAdminAuthProvider(auth), storage });
    assert.equal(settings.agentProfile, 'standard'); settings.destroy();
  }
});
test('real Dev router gates lifecycle after local tamper and on demotion, while Standard still runs', async () => {
  const { auth } = stateful();
  const settings = new DevAgentUiSettings({ authProvider: new SessionAdminAuthProvider(auth), storage: null });
  let runs = 0;
  const engine = createAgentProfileEngine({ standardEngine: { run: async () => 'standard' }, settings, devEngine: { run: async () => { runs++; return 'dev'; } } });
  settings.setAgentProfile('dev'); settings.setDecisionPolicy('yolo');
  assert.equal(await engine.run({ mode: 'agent' }), 'dev');
  auth.set('free'); assert.equal(settings.agentProfile, 'standard'); assert.equal(settings.decisionPolicy, 'normal');
  settings.agentProfile = 'dev'; settings.decisionPolicy = 'yolo';
  await assert.rejects(engine.run({ mode: 'agent' }), /denied/); assert.equal(runs, 1);
  settings.agentProfile = 'standard'; assert.equal(await engine.run({ mode: 'agent' }), 'standard'); settings.destroy();
});
test('actual parent/child auth initialization paths: Free no private load; Admin install before RPC/sandbox and revoke cleanup', async () => {
  for (const role of ['free', 'vip', 'admin']) {
    const { auth, calls } = stateful(role); let closes = 0;
    const parent = await startParentAuth({ apiOrigin: BASE, createClient: () => auth, createLogin: () => ({ show() {}, close() {} }), loadModule: async () => ({ installParentExtension: async () => { calls.push('install-parent'); return { close() { closes++; } }; } }) });
    calls.push('sandbox');
    if (role === 'admin') assert.deepEqual(calls.slice(0, 3), ['parent', 'install-parent', 'sandbox']);
    else assert.deepEqual(calls, ['sandbox']);
    const child = await startChildAuth({ suppliedAuth: auth, loadModule: async () => ({ installChildExtension: async () => { calls.push('install-child'); return { close() { closes++; } }; } }) });
    if (role === 'admin') { assert.ok(child.childExtension); auth.set('free'); assert.equal(parent.extension, null); assert.equal(child.childExtension, null); assert.equal(closes, 2); }
    else assert.equal(child.childExtension, null);
    child.close(); parent.close();
  }
});
test('revocation during asynchronous extension installation cannot resurrect it', async () => {
  const { auth } = stateful(); let closed = 0;
  const child = await startChildAuth({ suppliedAuth: auth, loadModule: async () => ({ installChildExtension: async () => { auth.set('free'); return { close() { closed++; } }; } }) });
  assert.equal(child.childExtension, null); assert.equal(closed, 1); child.close();
});
test('Standard facade supports frozen delegates and survives extension mount failure', async () => {
  const { auth } = stateful();
  const base = Object.freeze({ run: async () => 'standard', identity() { return this; } });
  const host = createAssistantExtensionHost(base, { auth, childExtension: { mountAssistant() { throw new Error('unavailable'); } } });
  host.mount({}, {}); assert.equal(host.engine.identity(), base); assert.equal(await host.engine.run({}), 'standard'); assert.equal(host.dev, null); host.destroy();
});
test('completion message rejects wrong origin/window/transaction/type and unexpected keys', () => {
  const popup = {}, options = { workerOrigin: BASE, transactionId: 'x'.repeat(43), popup }, event = { origin: BASE, source: popup, data: { type: 'hex.auth.complete', transactionId: options.transactionId, completionProof: 'z'.repeat(43) } };
  assert.equal(validCompletionMessage(event, options), true);
  for (const changed of [{ origin: 'https://evil.test' }, { source: {} }, { data: { ...event.data, transactionId: 'wrong' } }, { data: { ...event.data, type: 'login' } }, { data: { ...event.data, token: 'secret' } }]) assert.equal(!!validCompletionMessage({ ...event, ...changed }, options), false);
});
test('transport has finite timeout even when fetch ignores AbortSignal and rejects cross-origin paths', async () => {
  const request = createAuthTransport({ apiOrigin: BASE, timeoutMs: 10, fetchRef: () => new Promise(() => {}) });
  await assert.rejects(request('/api/auth/me'), /timed out/);
  await assert.rejects(request('//evil.test/api/auth/me'), /not allowed/);
});
test('older response cannot reauthorize after newer demotion; source hash mismatch denies', async () => {
  let count = 0, resolveOld;
  const admin = identityForUser({ discord_id: USER, username: 'u', role: 'admin', enabled: 1 }, OWNER);
  const free = identityForUser({ discord_id: USER, username: 'u', role: 'free', enabled: 1 }, OWNER);
  const client = createSessionClient({ apiOrigin: BASE, privilegedManifest: manifest, web: true, fetchRef: async () => {
    if (++count === 1) return new Promise((resolve) => { resolveOld = resolve; });
    return Response.json(free);
  } });
  const old = client.refresh(); await new Promise((resolve) => setTimeout(resolve, 0)); await client.refresh(); resolveOld(Response.json(admin)); await old;
  assert.equal(client.getIdentity().role, 'free'); client.close();
  const corrupt = createSessionClient({ apiOrigin: BASE, privilegedManifest: manifest, web: true, fetchRef: async (url) => url.includes('_privileged') ? new Response('tampered', { headers: { 'x-hex-privileged-build': manifest.buildId } }) : Response.json(admin) });
  await corrupt.initialize(); await assert.rejects(corrupt.source('child'), /integrity/); assert.equal(corrupt.getIdentity().admin, false); corrupt.close();
});

test('an older authority failure cannot be hidden by a newer success', async () => {
  let count = 0, resolveOld;
  const admin = identityForUser({ discord_id: USER, username: 'u', role: 'admin', enabled: 1 }, OWNER);
  const client = createSessionClient({ apiOrigin: BASE, privilegedManifest: manifest, web: true, fetchRef: async () => {
    if (++count === 1) return new Promise((resolve) => { resolveOld = resolve; });
    return Response.json(admin);
  } });
  const old = client.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await client.refresh()).admin, true, 'newer authority read succeeds first');
  resolveOld(Response.json({ error: 'forbidden' }, { status: 403 }));
  await old;
  assert.equal(client.getIdentity().admin, false, 'later authority failure must clamp the local lifecycle');
  client.close();
});

test('RPC client also clamps when an older identity request fails after a newer success', async (t) => {
  const admin = identityForUser({ discord_id: USER, username: 'u', role: 'admin', enabled: 1 }, OWNER);
  let calls = 0, rejectOld;
  const auth = {
    getIdentity: () => admin, subscribe: () => () => {},
    refresh: async () => {
      if (++calls === 1) return new Promise((_resolve, reject) => { rejectOld = reject; });
      return admin;
    },
    authorize: async () => admin, source: async () => { throw new Error('unused'); }, logout: async () => {},
  };
  const { port1, port2 } = new MessageChannel();
  const server = createAuthRpcServer({ port: port1, auth, showLogin() {} });
  const client = createAuthRpcClient({ port: port2, timeoutMs: 500 });
  t.after(() => { server.close(); client.close(); port1.close(); port2.close(); });
  const old = client.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await client.refresh()).admin, true);
  rejectOld(new Error('revoked'));
  await old;
  assert.equal(client.getIdentity().admin, false);
});

test('existing parent Dev RPC performs current Worker authorization before each dispatch', async (t) => {
  const { createDevWorkerParentRpc, createDevWorkerParentRpcClient } = await import('../../js/userscript/dev/parent-rpc.js');
  const f = await fixture(t); await f.client.initialize();
  const { port1, port2 } = new MessageChannel(); let calls = 0;
  const server = createDevWorkerParentRpc({ port: port1, runtime: { discover: async () => { calls++; return { workers: [] }; } }, authorize: () => f.client.authorize('normal') });
  const client = createDevWorkerParentRpcClient({ port: port2, timeoutMs: 500 });
  t.after(() => { server.close(); client.close(); port1.close(); port2.close(); });
  assert.deepEqual(await client.discover(), { workers: [] }); assert.equal(calls, 1);
  f.db.sqlite.prepare("UPDATE users SET role='free' WHERE discord_id=?").run(USER);
  await assert.rejects(client.discover(), /403/);
  assert.equal(calls, 1, 'demoted user never reaches the actual Dev runtime dispatcher');
});

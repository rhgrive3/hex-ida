import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { createSessionClient } from '../js/auth/client.js';
import { createAuthRpcServer, createAuthRpcClient } from '../js/auth/rpc.js';
import { createUserscriptLogin } from '../js/auth/userscript-login.js';
import { createAssistantExtensionHost } from '../js/auth/assistant-host.js';
import { identityForUser } from '../js/auth/capabilities.js';

const BASE = 'https://hex.test';
const KEY = 'hex.auth.userscript.session.v1';
const USER = '333333333333333333';
const OWNER = '111111111111111111';
const OLD_TOKEN = 'A'.repeat(43);
const NEW_TOKEN = 'B'.repeat(43);
const TX = 'x'.repeat(43);
const POLL = 'p'.repeat(43);
const PROOF = 'c'.repeat(43);

const ADMIN_IDENTITY = identityForUser({ discord_id: USER, username: 'admin', role: 'admin', enabled: 1 }, OWNER);
const FREE_IDENTITY = identityForUser({ discord_id: USER, username: 'free', role: 'free', enabled: 1 }, OWNER);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function respondJson(options, status, payload) {
  options.onload({
    status,
    responseText: JSON.stringify(payload),
    responseHeaders: 'content-type: application/json',
    finalUrl: options.url,
  });
}

// ---------------------------------------------------------------------------
// Bug 1 [P1]: js/auth/client.js - queued /auth/logout must send captured bearer
// ---------------------------------------------------------------------------
test('Bug 1a: queued logout() sends captured old bearer and does not revoke newly paired token', async (t) => {
  const storage = new Map([[KEY, OLD_TOKEN]]);
  const aiGate = deferred();
  const logoutAuthHeaders = [];
  const meAuthHeaders = [];

  const manager = {
    async getValue(key, fallback) { return storage.get(key) ?? fallback; },
    async setValue(key, value) { storage.set(key, value); },
    async deleteValue(key) { storage.delete(key); },
    xmlHttpRequest(options) {
      let aborted = false;
      const path = new URL(options.url).pathname;
      const finish = (status, payload) => {
        if (!aborted) respondJson(options, status, payload);
      };
      if (path === '/api/auth/me') {
        meAuthHeaders.push(options.headers?.authorization || null);
        queueMicrotask(() => finish(200, ADMIN_IDENTITY));
      } else if (path === '/api/auth/ai-capability') {
        void aiGate.promise.then(() => finish(200, { ok: true }));
      } else if (path === '/auth/logout') {
        logoutAuthHeaders.push(options.headers?.authorization || null);
        queueMicrotask(() => finish(200, { ok: true }));
      } else if (path === '/api/auth/userscript/complete') {
        queueMicrotask(() => finish(200, { token: NEW_TOKEN }));
      } else {
        queueMicrotask(() => finish(404, { error: 'not found' }));
      }
      return { abort() { aborted = true; options.onabort?.(); } };
    },
  };

  const client = createSessionClient({ apiOrigin: BASE, manager, timeoutMs: 2000 });
  t.after(() => client.close());

  assert.equal((await client.initialize()).admin, true);

  // Occupy mutationTail with an in-flight mutation.
  const pendingMutation = client.aiCapability();
  // Queue logout() while OLD_TOKEN is active.
  const logoutPromise = client.logout();
  // Concurrently completePairing() installs NEW_TOKEN before queued /auth/logout runs.
  await client.completePairing(TX, POLL, PROOF);

  // Now release the blocking mutation so the queued /auth/logout executes.
  aiGate.resolve();
  await pendingMutation;
  await logoutPromise;

  assert.deepEqual(logoutAuthHeaders, [`Bearer ${OLD_TOKEN}`], 'queued /auth/logout must revoke OLD_TOKEN, never NEW_TOKEN');
  assert.equal(storage.get(KEY), NEW_TOKEN, 'newly paired token must remain persisted');
  assert.equal((await client.refresh()).admin, true);
  assert.equal(meAuthHeaders.at(-1), `Bearer ${NEW_TOKEN}`);
});

test('Bug 1b: failed completePairing() queued /auth/logout revokes only its own failed token', async (t) => {
  const storage = new Map();
  const aiGate = deferred();
  const logoutAuthHeaders = [];
  let completeCount = 0;

  const manager = {
    async getValue(key, fallback) { return storage.get(key) ?? fallback; },
    async setValue(key, value) {
      if (value === OLD_TOKEN) throw new Error('storage write failed');
      storage.set(key, value);
    },
    async deleteValue(key) { storage.delete(key); },
    xmlHttpRequest(options) {
      let aborted = false;
      const path = new URL(options.url).pathname;
      const finish = (status, payload) => {
        if (!aborted) respondJson(options, status, payload);
      };
      if (path === '/api/auth/ai-capability') {
        void aiGate.promise.then(() => finish(200, { ok: true }));
      } else if (path === '/api/auth/userscript/complete') {
        const token = ++completeCount === 1 ? OLD_TOKEN : NEW_TOKEN;
        queueMicrotask(() => finish(200, { token }));
      } else if (path === '/auth/logout') {
        logoutAuthHeaders.push(options.headers?.authorization || null);
        queueMicrotask(() => finish(200, { ok: true }));
      } else if (path === '/api/auth/me') {
        queueMicrotask(() => finish(200, ADMIN_IDENTITY));
      }
      return { abort() { aborted = true; options.onabort?.(); } };
    },
  };

  const client = createSessionClient({ apiOrigin: BASE, manager, timeoutMs: 2000 });
  t.after(() => client.close());

  const blocking = client.aiCapability();
  const failedPairing = client.completePairing(TX, POLL, PROOF);
  // Let failedPairing hit setValue failure and enqueue /auth/logout behind blocking.
  await new Promise((r) => setTimeout(r, 20));
  // Newer pairing succeeds and installs NEW_TOKEN before queued /auth/logout runs.
  await client.completePairing(TX, POLL, PROOF);

  aiGate.resolve();
  await blocking;
  await assert.rejects(failedPairing, /Unable to save the private HEX session/);

  assert.deepEqual(logoutAuthHeaders, [`Bearer ${OLD_TOKEN}`], 'cleanup /auth/logout must revoke only the failed pairing token');
  assert.equal(storage.get(KEY), NEW_TOKEN);
  assert.equal(client.getIdentity().admin, true);
});

// ---------------------------------------------------------------------------
// Bug 2 [P1]: js/auth/client.js - old in-flight refresh() cannot invalidate completePairing()
// ---------------------------------------------------------------------------
test('Bug 2a: old in-flight refresh() failure after completePairing() does not wipe new session', async (t) => {
  const storage = new Map([[KEY, OLD_TOKEN]]);
  const oldRefreshGate = deferred();
  let meCall = 0;

  const manager = {
    async getValue(key, fallback) { return storage.get(key) ?? fallback; },
    async setValue(key, value) { storage.set(key, value); },
    async deleteValue(key) { storage.delete(key); },
    xmlHttpRequest(options) {
      let aborted = false;
      const path = new URL(options.url).pathname;
      const finish = (status, payload) => {
        if (!aborted) respondJson(options, status, payload);
      };
      if (path === '/api/auth/me') {
        const callIndex = ++meCall;
        if (callIndex === 1) {
          void oldRefreshGate.promise.then(() => finish(401, { error: 'expired' }));
        } else {
          queueMicrotask(() => finish(200, ADMIN_IDENTITY));
        }
      } else if (path === '/api/auth/userscript/complete') {
        queueMicrotask(() => finish(200, { token: NEW_TOKEN }));
      }
      return { abort() { aborted = true; options.onabort?.(); } };
    },
  };

  const client = createSessionClient({ apiOrigin: BASE, manager, timeoutMs: 2000 });
  t.after(() => client.close());

  // initialize() loads OLD_TOKEN and starts an old refresh() that hangs.
  const oldInit = client.initialize();
  await new Promise((r) => setTimeout(r, 15));

  // User completes new pairing while old refresh() is still pending.
  await client.completePairing(TX, POLL, PROOF);
  assert.equal(client.getIdentity().admin, true);
  assert.equal(storage.get(KEY), NEW_TOKEN);

  // Old refresh() now fails with 401.
  oldRefreshGate.resolve();
  await oldInit;

  assert.equal(client.getIdentity().authenticated, true, 'old refresh failure must not anonymize newly paired session');
  assert.equal(client.getIdentity().admin, true);
  assert.equal(storage.get(KEY), NEW_TOKEN);
});

test('Bug 2b: old in-flight refresh() failure during completePairing() persistence does not cancel pairing', async (t) => {
  const storage = new Map([[KEY, OLD_TOKEN]]);
  const oldRefreshGate = deferred();
  const setValueGate = deferred();
  let meCall = 0;

  const manager = {
    async getValue(key, fallback) { return storage.get(key) ?? fallback; },
    async setValue(key, value) {
      await setValueGate.promise;
      storage.set(key, value);
    },
    async deleteValue(key) { storage.delete(key); },
    xmlHttpRequest(options) {
      let aborted = false;
      const path = new URL(options.url).pathname;
      const finish = (status, payload) => {
        if (!aborted) respondJson(options, status, payload);
      };
      if (path === '/api/auth/me') {
        const callIndex = ++meCall;
        if (callIndex === 1) {
          void oldRefreshGate.promise.then(() => finish(401, { error: 'expired' }));
        } else {
          queueMicrotask(() => finish(200, ADMIN_IDENTITY));
        }
      } else if (path === '/api/auth/userscript/complete') {
        queueMicrotask(() => finish(200, { token: NEW_TOKEN }));
      }
      return { abort() { aborted = true; options.onabort?.(); } };
    },
  };

  const client = createSessionClient({ apiOrigin: BASE, manager, timeoutMs: 2000 });
  t.after(() => client.close());

  const oldInit = client.initialize();
  await new Promise((r) => setTimeout(r, 15));

  const pairing = client.completePairing(TX, POLL, PROOF);
  await new Promise((r) => setTimeout(r, 15));

  // Old refresh fails while setValue is still pending.
  oldRefreshGate.resolve();
  await oldInit;

  // Now setValue finishes.
  setValueGate.resolve();
  await pairing;

  assert.equal(storage.get(KEY), NEW_TOKEN, 'completePairing must not delete token due to stale refresh failure');
  assert.equal(client.getIdentity().admin, true);
});

// ---------------------------------------------------------------------------
// Bug 3 [P1]: js/auth/rpc.js - refreshGeneration incremented on demotion paths
// ---------------------------------------------------------------------------
test('Bug 3: RPC client increments refreshGeneration on call() timeout, authorize() failure, and logout()', async (t) => {
  // 3a: call() timeout demotion blocks stale refresh() reply
  {
    const staleRefresh = deferred();
    const auth = {
      getIdentity: () => ADMIN_IDENTITY,
      subscribe: () => () => {},
      refresh: () => staleRefresh.promise,
      authorize: async () => ADMIN_IDENTITY,
      source: async () => { throw new Error('unused'); },
      aiCapability: () => new Promise(() => {}), // hangs until timeout
      logout: async () => {},
    };
    const { port1, port2 } = new MessageChannel();
    const server = createAuthRpcServer({ port: port1, auth, showLogin() {} });
    const client = createAuthRpcClient({ port: port2, timeoutMs: 40 });
    t.after(() => { server.close(); client.close(); port1.close(); port2.close(); });

    const refreshPromise = client.refresh();
    // Trigger a separate call that times out at 40ms.
    await assert.rejects(client.aiCapability(), /timed out/);
    assert.equal(client.getIdentity().authenticated, false);

    // Late refresh reply arrives with admin identity (note: refresh itself may also time out or resolve if resolved right after aiCapability timeout).
    staleRefresh.resolve(ADMIN_IDENTITY);
    await refreshPromise;
    assert.equal(client.getIdentity().admin, false, 'stale refresh reply must not resurrect admin after call() timeout');
  }

  // 3b: authorize() failure demotion blocks stale refresh() reply
  {
    const staleRefresh = deferred();
    const auth = {
      getIdentity: () => ADMIN_IDENTITY,
      subscribe: () => () => {},
      refresh: () => staleRefresh.promise,
      authorize: async () => { throw new Error('denied'); },
      source: async () => { throw new Error('unused'); },
      aiCapability: async () => ({}),
      logout: async () => {},
    };
    const { port1, port2 } = new MessageChannel();
    const server = createAuthRpcServer({ port: port1, auth, showLogin() {} });
    const client = createAuthRpcClient({ port: port2, timeoutMs: 500 });
    t.after(() => { server.close(); client.close(); port1.close(); port2.close(); });

    const refreshPromise = client.refresh();
    await assert.rejects(client.authorize('normal'), /denied/);
    assert.equal(client.getIdentity().authenticated, false);

    staleRefresh.resolve(ADMIN_IDENTITY);
    await refreshPromise;
    assert.equal(client.getIdentity().admin, false, 'stale refresh reply must not resurrect admin after authorize() failure');
  }

  // 3c: logout() demotion blocks stale refresh() reply
  {
    const staleRefresh = deferred();
    const auth = {
      getIdentity: () => ADMIN_IDENTITY,
      subscribe: () => () => {},
      refresh: () => staleRefresh.promise,
      authorize: async () => ADMIN_IDENTITY,
      source: async () => { throw new Error('unused'); },
      aiCapability: async () => ({}),
      logout: async () => {},
    };
    const { port1, port2 } = new MessageChannel();
    const server = createAuthRpcServer({ port: port1, auth, showLogin() {} });
    const client = createAuthRpcClient({ port: port2, timeoutMs: 500 });
    t.after(() => { server.close(); client.close(); port1.close(); port2.close(); });

    const refreshPromise = client.refresh();
    await client.logout();
    assert.equal(client.getIdentity().authenticated, false);

    staleRefresh.resolve(ADMIN_IDENTITY);
    await refreshPromise;
    assert.equal(client.getIdentity().admin, false, 'stale refresh reply must not resurrect admin after logout()');
  }
});

// ---------------------------------------------------------------------------
// Bug 4 [P2]: js/auth/userscript-login.js - poll() must not abort in-flight completePairing()
// ---------------------------------------------------------------------------
function makeFakeDom() {
  const listeners = new Map();
  const makeEl = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      style: {},
      children: [],
      attributes: new Map(),
      textContent: '',
      value: '',
      disabled: false,
      onclick: null,
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      append(...nodes) { this.children.push(...nodes); },
      remove() { this.removed = true; },
    };
    return el;
  };
  const documentRef = {
    documentElement: makeEl('html'),
    createElement: (tag) => makeEl(tag),
  };
  const windowRef = {
    location: { origin: 'https://chatgpt.com', reload() {} },
    open() { return {}; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchMessage(event) {
      for (const fn of [...(listeners.get('message') || [])]) fn(event);
    },
  };
  return { windowRef, documentRef };
}

test('Bug 4: poll() failure or expiry during in-flight completePairing() does not abort login completion', async () => {
  const { windowRef, documentRef } = makeFakeDom();
  const pollGate = deferred();
  const completeGate = deferred();
  let completeSignal = null;
  let completedCount = 0;

  const auth = {
    startPairing: async () => ({
      transactionId: TX,
      pollSecret: POLL,
      authorizationUrl: 'https://discord.com/oauth2/authorize?client_id=1',
      expiresAt: Date.now() + 60000,
    }),
    pollPairing: () => pollGate.promise,
    completePairing: async (_tx, _poll, _proof, signal) => {
      completeSignal = signal;
      await completeGate.promise;
      if (signal?.aborted) throw new Error('Login was cancelled.');
    },
  };

  const ui = createUserscriptLogin({
    auth,
    apiOrigin: BASE,
    windowRef,
    documentRef,
    onComplete: () => { completedCount++; },
    intervalMs: 500,
  });

  ui.show();
  // Let startPairing resolve and first pollPairing start.
  await new Promise((r) => setTimeout(r, 15));

  // Trigger completion via postMessage while pollPairing is still in flight.
  windowRef.dispatchMessage({
    origin: BASE,
    source: null,
    data: { type: 'hex.auth.complete', transactionId: TX, completionProof: PROOF },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(completeSignal, 'completePairing should have started');
  assert.equal(completeSignal.aborted, false);

  // Now the in-flight pollPairing fails!
  pollGate.reject(new Error('transient poll failure'));
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(completeSignal.aborted, false, 'poll() failure must not abort in-flight completePairing()');

  completeGate.resolve();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(completedCount, 1, 'onComplete must fire once completePairing finishes');
  ui.close();
});

// ---------------------------------------------------------------------------
// Bug 5 [P2]: userscript/hex.user.template.js - NaN expiry must fail closed
// ---------------------------------------------------------------------------
test('Bug 5: userscript template fails closed when bootstrap expiry is NaN / invalid / non-string', async () => {
  const rawTemplate = await fs.readFile(new URL('../userscript/hex.user.template.js', import.meta.url), 'utf8');
  const buildIdMatch = rawTemplate.match(/,h="([0-9a-f]{24})"/);
  assert.ok(buildIdMatch, 'template should contain pinned buildId');
  const buildId = buildIdMatch[1];

  const runBootstrapWithExpiry = async (expiry) => {
    const code = rawTemplate.replaceAll('__HEX_ORIGIN__', BASE);
    const elements = new Map();
    const makeNode = () => ({
      id: '',
      style: {},
      dataset: {},
      textContent: '',
      title: '',
      disabled: false,
      onclick: null,
      remove() {},
      append(child) { if (child?.id) elements.set(child.id, child); },
    });
    const docEl = makeNode();
    let runtimeFetched = false;
    const context = {
      console,
      URL,
      Blob,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      ArrayBuffer,
      Number,
      String,
      Date,
      Math,
      JSON,
      Error,
      TypeError,
      RangeError,
      Promise,
      AbortController,
      DecompressionStream,
      btoa,
      atob,
      crypto: globalThis.crypto,
      setTimeout: (fn) => { queueMicrotask(fn); return 1; },
      clearTimeout: () => {},
      document: {
        readyState: 'complete',
        documentElement: docEl,
        getElementById: (id) => elements.get(id) || null,
        createElement: () => makeNode(),
        querySelectorAll: () => [],
        addEventListener() {},
      },
      location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com', pathname: '/', search: '' },
      fetch: async (url) => {
        if (String(url).includes('/_runtime/')) runtimeFetched = true;
        return new Response(JSON.stringify({ buildId, expiry, manifest: { buildId } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    context.globalThis = context;
    context.self = context;
    context.top = context;

    vm.runInNewContext(code, context);
    await new Promise((r) => setTimeout(r, 40));
    const btn = elements.get('hex-secure-loader');
    return { errorTitle: btn?.title || '', runtimeFetched };
  };

  for (const badExpiry of ['not-a-date', '', null, undefined, 9999]) {
    const res = await runBootstrapWithExpiry(badExpiry);
    assert.match(res.errorTitle, /expiry could not be verified/i, `expiry=${JSON.stringify(badExpiry)} must fail closed`);
    assert.equal(res.runtimeFetched, false);
  }

  // Valid future expiry must pass the expiry check and reach manifest validation.
  const validRes = await runBootstrapWithExpiry(new Date(Date.now() + 60_000).toISOString());
  assert.doesNotMatch(validRes.errorTitle, /expiry could not be verified/i);
  assert.match(validRes.errorTitle, /manifest version does not match/i);
});

// ---------------------------------------------------------------------------
// Bug 6 [P2]: js/auth/assistant-host.js - re-mount destroys previous mount & prevents post-destroy mount
// ---------------------------------------------------------------------------
test('Bug 6: createAssistantExtensionHost destroys previous mount on re-mount and blocks mount after destroy', () => {
  const listeners = new Set();
  const auth = {
    getIdentity: () => ADMIN_IDENTITY,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const destroyLog = [];
  let mountCount = 0;
  const childExtension = {
    mountAssistant() {
      const id = ++mountCount;
      return {
        engine: { run: async () => `dev-${id}` },
        settings: { id },
        supervisor: { id },
        destroy() { destroyLog.push(id); },
      };
    },
  };

  const host = createAssistantExtensionHost({ run: async () => 'standard' }, { auth, childExtension });
  host.mount({}, {});
  assert.equal(host.dev.settings.id, 1);
  assert.deepEqual(destroyLog, []);

  // Re-mount must destroy instance 1 before replacing it with instance 2.
  host.mount({}, {});
  assert.equal(host.dev.settings.id, 2);
  assert.deepEqual(destroyLog, [1], 'previous mounted instance must be destroyed on re-mount');

  // Host destroy must clean up instance 2 and unsubscribe.
  host.destroy();
  assert.deepEqual(destroyLog, [1, 2]);
  assert.equal(host.dev, null);
  assert.equal(listeners.size, 0);

  // Calling mount() after destroy() must be a no-op.
  host.mount({}, {});
  assert.equal(mountCount, 2, 'must not mount after host.destroy()');
  assert.equal(host.dev, null);
});

// ---------------------------------------------------------------------------
// Bug 7 [P2]: js/auth/admin-app.js - loadAudit() generation tracking prevents stale overwrite
// ---------------------------------------------------------------------------
test('Bug 7: admin-app loadAudit() ignores stale out-of-order responses', async () => {
  const adminSrc = await fs.readFile(new URL('../js/auth/admin-app.js', import.meta.url), 'utf8');
  const ids = [
    'status', 'users', 'query', 'filter', 'previous', 'next',
    'audit', 'audit-previous', 'audit-next', 'audit-refresh',
    'search', 'register', 'discord-id', 'logout', 'identity',
  ];
  const elements = new Map();
  for (const id of ids) {
    elements.set(id, {
      id,
      value: '',
      textContent: '',
      disabled: false,
      onclick: null,
      onsubmit: null,
      replaceChildren() {},
      append() {},
    });
  }

  const auditPage1Gate = deferred();
  const auditPage2Gate = deferred();

  const fetchMock = async (path) => {
    if (path === '/api/auth/me') {
      return new Response(JSON.stringify(ADMIN_IDENTITY), { status: 200 });
    }
    if (path.startsWith('/api/admin/users')) {
      return new Response(JSON.stringify({ users: [], hasMore: false }), { status: 200 });
    }
    if (path === '/api/admin/audit?limit=25&offset=0') {
      return new Response(JSON.stringify({
        entries: [{ created_at: 1700000000000, actor_discord_id: '1', target_discord_id: '2', action: 'init', old_value_json: null, new_value_json: 'init' }],
        hasMore: true,
      }), { status: 200 });
    }
    if (path === '/api/admin/audit?limit=25&offset=25') {
      const payload = await auditPage1Gate.promise;
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    if (path === '/api/admin/audit?limit=25&offset=50') {
      const payload = await auditPage2Gate.promise;
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 404 });
  };

  const context = {
    console,
    Date,
    Math,
    JSON,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    location: { assign() {} },
    fetch: fetchMock,
    document: {
      getElementById: (id) => elements.get(id),
      createElement: () => ({
        textContent: '',
        value: '',
        disabled: false,
        checked: false,
        setAttribute() {},
        append() {},
      }),
    },
  };

  vm.runInNewContext(adminSrc, context);
  // Wait for initial load (/api/auth/me -> loadUsers -> loadAudit offset=0)
  await new Promise((r) => setTimeout(r, 20));
  assert.match(elements.get('audit').textContent, /init/);

  // Click Next -> offset=25 (stale slow request)
  elements.get('audit-next').onclick();
  // Click Next again -> offset=50 (newer fast request)
  elements.get('audit-next').onclick();

  // Newer response (offset=50) resolves first
  auditPage2Gate.resolve({
    entries: [{ created_at: 1700000050000, actor_discord_id: '1', target_discord_id: '50', action: 'page-50', old_value_json: 'a', new_value_json: 'b' }],
    hasMore: false,
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(elements.get('audit').textContent, /page-50/);
  assert.equal(elements.get('audit-next').disabled, true);

  // Older response (offset=25) resolves later and must be ignored
  auditPage1Gate.resolve({
    entries: [{ created_at: 1700000025000, actor_discord_id: '1', target_discord_id: '25', action: 'stale-page-25', old_value_json: 'x', new_value_json: 'y' }],
    hasMore: true,
  });
  await new Promise((r) => setTimeout(r, 20));

  assert.match(elements.get('audit').textContent, /page-50/, 'stale audit response must not overwrite newer audit entries');
  assert.doesNotMatch(elements.get('audit').textContent, /stale-page-25/);
  assert.equal(elements.get('audit-next').disabled, true, 'stale audit response must not overwrite pagination button state');
});

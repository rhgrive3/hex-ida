import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionClient } from '../../js/auth/client.js';

const KEY = 'hex.auth.userscript.session.v1';
const A = 'A'.repeat(43);
const B = 'B'.repeat(43);
const TX_A = 'x'.repeat(43);
const TX_B = 'y'.repeat(43);
const POLL = 'p'.repeat(43);
const PROOF = 'c'.repeat(43);
const IDENTITY = {
  authenticated: true,
  discordId: '1',
  username: 'fixture',
  role: 'free',
  enabled: true,
  owner: false,
  admin: false,
  capabilities: {},
};

function authManager({ setValue }) {
  const storage = new Map();
  const events = [];
  const meAuthorizations = [];
  const manager = {
    async getValue(key, fallback) { return storage.get(key) ?? fallback; },
    setValue(key, value) { return setValue({ key, value, storage, events }); },
    async deleteValue(key) { storage.delete(key); events.push('delete'); },
    xmlHttpRequest(options) {
      let aborted = false;
      queueMicrotask(() => {
        if (aborted) return;
        const path = new URL(options.url).pathname;
        let payload = {};
        if (path === '/api/auth/userscript/complete') {
          const body = JSON.parse(options.data || '{}');
          payload = { token: body.transactionId === TX_A ? A : B };
        } else if (path === '/api/auth/me') {
          meAuthorizations.push(options.headers?.authorization || null);
          payload = IDENTITY;
        }
        options.onload({
          status: 200,
          responseText: JSON.stringify(payload),
          responseHeaders: 'content-type: application/json',
          finalUrl: options.url,
        });
      });
      return {
        abort() {
          aborted = true;
          options.onabort?.();
        },
      };
    },
  };
  return { manager, storage, events, meAuthorizations };
}

function client(manager) {
  return createSessionClient({ apiOrigin: 'https://hex.test', manager, timeoutMs: 1000 });
}

test('issue #9237: timed-out stale write cannot overwrite a later pairing or reload', { timeout: 15000 }, async (t) => {
  const f = authManager({
    setValue({ key, value, storage, events }) {
      if (value === A) {
        events.push('A-set-start');
        return new Promise((resolve) => setTimeout(() => {
          storage.set(key, value);
          events.push('A-set-landed');
          resolve();
        }, 5300));
      }
      storage.set(key, value);
      events.push('B-set-landed');
    },
  });
  const first = client(f.manager);
  t.after(() => first.close());

  await assert.rejects(first.completePairing(TX_A, POLL, PROOF), /Unable to save the private HEX session/);
  assert.equal(f.storage.get(KEY) ?? null, null, 'failed pairing must be cleaned after its late write settles');

  await first.completePairing(TX_B, POLL, PROOF);
  assert.equal(f.storage.get(KEY), B);

  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(f.storage.get(KEY), B, 'late A must never become authoritative after B succeeds');

  const reload = client(f.manager);
  t.after(() => reload.close());
  assert.equal((await reload.initialize()).authenticated, true);
  assert.equal(f.meAuthorizations.at(-1), `Bearer ${B}`, 'reload must read the newest successful session');
});

test('issue #9237: close during an older write cannot clobber a newer client generation', { timeout: 3000 }, async (t) => {
  let releaseA;
  let markAStarted;
  const aStarted = new Promise((resolve) => { markAStarted = resolve; });
  const f = authManager({
    setValue({ key, value, storage, events }) {
      if (value === A) {
        events.push('A-set-start');
        markAStarted();
        return new Promise((resolve) => {
          releaseA = () => {
            storage.set(key, value);
            events.push('A-set-landed');
            resolve();
          };
        });
      }
      storage.set(key, value);
      events.push('B-set-landed');
    },
  });
  const older = client(f.manager);
  const newer = client(f.manager);
  t.after(() => { older.close(); newer.close(); });

  const oldPairing = older.completePairing(TX_A, POLL, PROOF);
  await aStarted;
  older.close();

  const newPairing = newer.completePairing(TX_B, POLL, PROOF);
  // Give B's complete response time to reserve the newer storage generation.
  // On the buggy implementation B physically lands here before A is released.
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseA();

  await assert.rejects(oldPairing, /Login was cancelled/);
  await newPairing;
  assert.equal(f.storage.get(KEY), B, 'older close cleanup must not delete the newer session');
  assert.equal(f.events.at(-1), 'B-set-landed');
});


test('issue #9237: stale client logout preserves a newer pairing and current owner can logout', { timeout: 3000 }, async (t) => {
  const f = authManager({
    setValue({ key, value, storage, events }) {
      storage.set(key, value);
      events.push(value === A ? 'A-set-landed' : 'B-set-landed');
    },
  });
  const older = client(f.manager);
  const newer = client(f.manager);
  t.after(() => { older.close(); newer.close(); });

  await older.completePairing(TX_A, POLL, PROOF);
  assert.equal(f.storage.get(KEY), A);

  await newer.completePairing(TX_B, POLL, PROOF);
  assert.equal(f.storage.get(KEY), B);

  await older.logout();
  assert.equal(f.storage.get(KEY), B, 'stale logout must not delete a newer client session');

  await newer.logout();
  assert.equal(f.storage.has(KEY), false, 'current owner logout must delete its own persisted token');
  assert.equal(f.events.filter((event) => event === 'delete').length, 1);
});

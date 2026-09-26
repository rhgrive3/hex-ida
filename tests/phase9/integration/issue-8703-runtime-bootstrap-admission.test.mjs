import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import {
  RUNTIME_BOOTSTRAP_ADMISSION,
  abortRuntimeBootstrapIssuance,
  beginRuntimeBootstrapIssuance,
  consumeRuntimeBootstrapSession,
  finishRuntimeBootstrapIssuance,
  pruneRuntimeBootstrapState,
} from '../../../js/userscript/runtime-bootstrap-admission.js';

class MemoryStorage {
  constructor() { this.map = new Map(); this.alarm = null; }
  async get(key) { return this.map.get(key); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
  async delete(keys) {
    if (Array.isArray(keys)) { for (const key of keys) this.map.delete(key); return; }
    this.map.delete(keys);
  }
  async list({ prefix = '', limit = 1000, startAfter } = {}) {
    const result = new Map();
    const keys = [...this.map.keys()].filter((key) => key.startsWith(prefix)).sort();
    for (const key of keys) {
      if (startAfter != null && key <= startAfter) continue;
      result.set(key, structuredClone(this.map.get(key)));
      if (result.size >= limit) break;
    }
    return result;
  }
  async transaction(callback) { return callback(this); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = Number(value); }
}

function policy(overrides = {}) {
  return { ...RUNTIME_BOOTSTRAP_ADMISSION, ...overrides };
}

function requestInput(index, { bucket = 'bucket-A', expiry = 120_000 } = {}) {
  return {
    nonce: `nonce-${String(index).padStart(16, '0')}`,
    sessionId: `session-${String(index).padStart(16, '0')}`,
    requestId: `request-${String(index).padStart(16, '0')}`,
    bucket,
    expiry,
  };
}

test('#8703 Stage B: concurrency is admitted before crypto/state amplification and is deterministic', async () => {
  const storage = new MemoryStorage();
  const p = policy({ maxConcurrent: 2, maxOutstanding: 20, maxOutstandingPerBucket: 20, maxBucketPerWindow: 20 });
  const a = await beginRuntimeBootstrapIssuance(storage, requestInput(1), { now: 1_000, policy: p, randomId: () => 'lease-A' });
  const b = await beginRuntimeBootstrapIssuance(storage, requestInput(2), { now: 1_000, policy: p, randomId: () => 'lease-B' });
  const c = await beginRuntimeBootstrapIssuance(storage, requestInput(3), { now: 1_000, policy: p, randomId: () => 'lease-C' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(c, { ok: false, reason: 'bootstrap-concurrency-limit' });
  assert.equal(storage.map.has('nonce:nonce-0000000000000003'), false,
    'a rejected admission must not reserve replay state');
  assert.equal(storage.map.has('session:session-0000000000000003'), false,
    'a rejected admission must not allocate session state');
});

test('#8703 Stage B: per-authority outstanding-session cap bounds retained live state', async () => {
  const storage = new MemoryStorage();
  const p = policy({ maxConcurrent: 4, maxOutstanding: 20, maxOutstandingPerBucket: 2, maxBucketPerWindow: 20 });
  for (const [index, lease] of [[1, 'lease-1'], [2, 'lease-2']]) {
    const admitted = await beginRuntimeBootstrapIssuance(storage, requestInput(index), { now: 2_000, policy: p, randomId: () => lease });
    assert.equal(admitted.ok, true);
    assert.equal((await finishRuntimeBootstrapIssuance(storage, { leaseId: lease, sessionId: requestInput(index).sessionId, now: 2_001 })).ok, true);
  }
  const blocked = await beginRuntimeBootstrapIssuance(storage, requestInput(3), { now: 2_002, policy: p, randomId: () => 'lease-3' });
  assert.deepEqual(blocked, { ok: false, reason: 'bootstrap-bucket-outstanding-limit' });
});

test('#8703 Stage B: global retained-state proof fails closed when the bounded scan is saturated', async () => {
  const storage = new MemoryStorage();
  const p = policy({ maxConcurrent: 4, maxOutstanding: 2, maxOutstandingPerBucket: 2, maxBucketPerWindow: 20, requestSweepPages: 0 });
  for (let i = 0; i < 3; i++) {
    storage.map.set(`session:expired-${i}`, { expiry: 1, requestId: `old-${i}`, bucket: 'old', ready: true, consumed: false });
  }
  const blocked = await beginRuntimeBootstrapIssuance(storage, requestInput(9), { now: 5_000, policy: p, randomId: () => 'lease-9' });
  assert.deepEqual(blocked, { ok: false, reason: 'bootstrap-outstanding-limit' });
});

test('#8703 Stage B: replay protection and one-time runtime consumption remain intact', async () => {
  const storage = new MemoryStorage();
  const p = policy({ maxConcurrent: 4, maxOutstanding: 20, maxOutstandingPerBucket: 20, maxBucketPerWindow: 20 });
  const firstInput = requestInput(1);
  const first = await beginRuntimeBootstrapIssuance(storage, firstInput, { now: 10_000, policy: p, randomId: () => 'lease-replay' });
  assert.equal(first.ok, true);
  assert.equal((await finishRuntimeBootstrapIssuance(storage, { leaseId: first.leaseId, sessionId: firstInput.sessionId, now: 10_001 })).ok, true);

  const replay = await beginRuntimeBootstrapIssuance(storage, {
    ...requestInput(2),
    nonce: firstInput.nonce,
  }, { now: 10_002, policy: p, randomId: () => 'lease-replay-2' });
  assert.deepEqual(replay, { ok: false, reason: 'replayed-nonce' });

  const consumed = await consumeRuntimeBootstrapSession(storage, {
    sessionId: firstInput.sessionId,
    requestId: firstInput.requestId,
    now: 10_003,
  });
  assert.deepEqual(consumed, { ok: true });
  const consumedAgain = await consumeRuntimeBootstrapSession(storage, {
    sessionId: firstInput.sessionId,
    requestId: firstInput.requestId,
    now: 10_004,
  });
  assert.deepEqual(consumedAgain, { ok: false, reason: 'replayed-session' });
});

test('#8703 Stage B: aborted issuance rolls back nonce/session/lease reservations', async () => {
  const storage = new MemoryStorage();
  const p = policy({ maxConcurrent: 4, maxOutstanding: 20, maxOutstandingPerBucket: 20, maxBucketPerWindow: 20 });
  const input = requestInput(5);
  const admitted = await beginRuntimeBootstrapIssuance(storage, input, { now: 20_000, policy: p, randomId: () => 'lease-abort' });
  assert.equal(admitted.ok, true);
  assert.deepEqual(await abortRuntimeBootstrapIssuance(storage, { leaseId: admitted.leaseId, sessionId: input.sessionId }), { aborted: true });
  assert.equal(storage.map.has(`nonce:${input.nonce}`), false);
  assert.equal(storage.map.has(`session:${input.sessionId}`), false);
  assert.equal(storage.map.has(`lease:${admitted.leaseId}`), false);
});

test('#8703 Stage B: alarm-sized bounded cleanup progresses beyond the old 256-row ceiling', async () => {
  const storage = new MemoryStorage();
  for (let i = 0; i < 300; i++) {
    storage.map.set(`nonce:${String(i).padStart(4, '0')}`, { expiry: 1 });
    storage.map.set(`session:${String(i).padStart(4, '0')}`, { expiry: 1 });
  }
  const result = await pruneRuntimeBootstrapState(storage, {
    now: 100_000,
    maxPagesPerPrefix: RUNTIME_BOOTSTRAP_ADMISSION.alarmSweepPages,
  });
  assert.equal(result.deleted, 600);
  assert.equal([...storage.map.keys()].some((key) => key.startsWith('nonce:') || key.startsWith('session:')), false);
});

register('data:text/javascript,' + encodeURIComponent(`
const runtimeSecrets = ${JSON.stringify(`export const RUNTIME_BUILD = Object.freeze({
  manifest: Object.freeze({ buildId: 'phase9-test-build', assetPath: '/.runtime/runtime.test.bin', byteLength: 32 }),
  signingKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  contentKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
});`)};
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class DurableObject {}', shortCircuit: true };
  }
  if (specifier.endsWith('.runtime-build/privileged-assets.js')) {
    return { url: 'data:text/javascript,' + encodeURIComponent('export const PRIVILEGED_BUILD = Object.freeze({ buildId: "phase9-test-build", parentSource: "/* private parent */", childSource: "/* private child */", adminSource: "/* private admin */" });'), shortCircuit: true };
  }
  if (specifier.endsWith('.runtime-build/runtime-secrets.js')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(runtimeSecrets), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`));

const { __runtimeTest } = await import('../../../worker-entry.js');

function validBootstrapBody() {
  return JSON.stringify({
    nonce: 'nonce-0123456789abcdef',
    requestId: 'request-0123456789',
    sessionIdentity: 'session-identity-0123456789',
    loaderVersion: '2.0.1',
    buildId: 'phase9-test-build',
    clientPublicKey: { kty: 'EC', crv: 'P-256', x: 'AAAAAAAAAAAAAAAAAAAA', y: 'BBBBBBBBBBBBBBBBBBBB' },
  });
}

test('#8703 Stage B: endpoint quota rejection happens before expensive wrapping/signing and state reservation', async () => {
  const calls = { begin: 0, finish: 0, abort: 0 };
  let captured = null;
  const stub = {
    async beginIssue(input) { calls.begin += 1; captured = input; return { ok: false, reason: 'bootstrap-bucket-rate-limit' }; },
    async finishIssue() { calls.finish += 1; return { ok: true }; },
    async abortIssue() { calls.abort += 1; return { aborted: true }; },
  };
  const env = {
    RUNTIME_BOOTSTRAP: {
      idFromName(name) { assert.equal(name, 'runtime-v1'); return name; },
      get() { return stub; },
    },
  };
  const request = new Request('https://ida.rhgrive.workers.dev/runtime/bootstrap', {
    method: 'POST',
    headers: {
      origin: 'https://chatgpt.com',
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.10',
    },
    body: validBootstrapBody(),
  });
  const response = await __runtimeTest.runtimeBootstrap(request, env, new URL(request.url));
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'bootstrap-bucket-rate-limit' });
  assert.deepEqual(calls, { begin: 1, finish: 0, abort: 0 },
    'quota rejection must occur before wrapping/finalization and needs no rollback because no reservation was made');
  assert.equal(captured.nonce, 'nonce-0123456789abcdef');
  assert.equal(captured.requestId, 'request-0123456789');
  assert.equal(typeof captured.bucket, 'string');
  assert.notEqual(captured.bucket, '203.0.113.10', 'raw client IP must not be stored as the quota bucket key');
});

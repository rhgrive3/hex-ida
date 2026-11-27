import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { createAuthRpcServer, createAuthRpcClient } from '../js/auth/rpc.js';
import { identityForUser } from '../js/auth/capabilities.js';
import { stableDigest, deepFreeze } from '../js/core/identity/index.js';
import {
  REBUILD_VALIDATION_SCHEMA,
  createRebuildTransaction,
  materializeRebuildTransaction,
  validateRebuildTransaction,
  publishRebuildTransaction,
  evaluateF6RebuildDenominator,
} from '../js/rebuild/transaction-v2.js';

const USER = '333333333333333333';
const OWNER = '111111111111111111';
const ADMIN_IDENTITY = identityForUser({ discord_id: USER, username: 'admin', role: 'admin', enabled: 1 }, OWNER);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('P1-S11-001: stale in-flight refresh() cannot revive Admin during or after logout()', async (t) => {
  const slowRefresh = deferred();
  const slowLogout = deferred();
  const auth = {
    getIdentity: () => ADMIN_IDENTITY,
    subscribe: () => () => {},
    refresh: () => slowRefresh.promise,
    authorize: async () => ADMIN_IDENTITY,
    source: async () => { throw new Error('unused'); },
    aiCapability: async () => ({}),
    logout: () => slowLogout.promise,
  };
  const { port1, port2 } = new MessageChannel();
  const server = createAuthRpcServer({ port: port1, auth, showLogin() {} });
  const client = createAuthRpcClient({ port: port2, timeoutMs: 500 });
  t.after(() => { server.close(); client.close(); port1.close(); port2.close(); });

  const observed = [];
  client.subscribe((id) => observed.push(id));

  const refreshPromise = client.refresh();
  await new Promise((r) => setTimeout(r, 10));

  // Start logout() while refresh() is still in flight
  const logoutPromise = client.logout();
  await new Promise((r) => setTimeout(r, 10));

  // Stale refresh() resolves with Admin BEFORE logout() finishes
  slowRefresh.resolve(ADMIN_IDENTITY);
  await refreshPromise;

  assert.equal(client.getIdentity().admin, false, 'stale refresh must not revive Admin while logout is in flight');
  assert.equal(observed.some((id) => id.admin === true), false, 'subscribers must never observe Admin from stale refresh after logout started');

  slowLogout.resolve();
  await logoutPromise;
  assert.equal(client.getIdentity().admin, false);
});

test('P1-S11-001: stale in-flight refresh() cannot revive Admin after authorize() fails', async (t) => {
  const slowRefresh = deferred();
  const auth = {
    getIdentity: () => ADMIN_IDENTITY,
    subscribe: () => () => {},
    refresh: () => slowRefresh.promise,
    authorize: async () => { throw new Error('revoked'); },
    source: async () => { throw new Error('unused'); },
    aiCapability: async () => ({}),
    logout: async () => {},
  };
  const { port1, port2 } = new MessageChannel();
  const server = createAuthRpcServer({ port: port1, auth, showLogin() {} });
  const client = createAuthRpcClient({ port: port2, timeoutMs: 500 });
  t.after(() => { server.close(); client.close(); port1.close(); port2.close(); });

  const refreshPromise = client.refresh();
  await new Promise((r) => setTimeout(r, 10));

  await assert.rejects(client.authorize('normal'), /denied/);
  assert.equal(client.getIdentity().admin, false);

  slowRefresh.resolve(ADMIN_IDENTITY);
  await refreshPromise;
  assert.equal(client.getIdentity().admin, false, 'stale refresh must not revive Admin after authorize() failure');
});

test('P1-S11-001: stale in-flight refresh() cannot revive Admin after call() timeout', async (t) => {
  const slowRefresh = deferred();
  const hangingCall = deferred();
  const auth = {
    getIdentity: () => ADMIN_IDENTITY,
    subscribe: () => () => {},
    refresh: () => slowRefresh.promise,
    authorize: async () => ADMIN_IDENTITY,
    source: async () => { throw new Error('unused'); },
    aiCapability: () => hangingCall.promise,
    logout: async () => {},
  };
  const { port1, port2 } = new MessageChannel();
  const server = createAuthRpcServer({ port: port1, auth, showLogin() {} });
  const client = createAuthRpcClient({ port: port2, timeoutMs: 40 });
  t.after(() => { server.close(); client.close(); port1.close(); port2.close(); });

  // Use a separate manual responder so refresh can resolve AFTER aiCapability times out
  const { port1: p1, port2: p2 } = new MessageChannel();
  const pendingRequests = [];
  p1.addEventListener('message', (event) => {
    pendingRequests.push(event.data);
  });
  p1.start();
  const timedClient = createAuthRpcClient({ port: p2, timeoutMs: 30 });
  t.after(() => { timedClient.close(); p1.close(); p2.close(); });

  // Start refresh (will hang until we manually reply later)
  // Actually, refresh uses the same timeoutMs (30ms), so start aiCapability first (times out at t=30ms),
  // start refresh at t=15ms (would time out at t=45ms), let aiCapability time out at t=30ms, then reply to refresh at t=35ms!
  const capPromise = timedClient.aiCapability();
  await new Promise((r) => setTimeout(r, 15));
  const refreshPromise = timedClient.refresh();
  await new Promise((r) => setTimeout(r, 5));

  // Wait for aiCapability to time out (at ~30ms), which triggers demote() + refreshGeneration++
  await assert.rejects(capPromise, /timed out/);
  assert.equal(timedClient.getIdentity().admin, false);

  // Now reply to the still-in-flight refresh BEFORE its own timeout expires
  const refreshReq = pendingRequests.find((m) => m.method === 'identity');
  assert.ok(refreshReq, 'identity request should have been sent');
  p1.postMessage({
    protocol: 'hex-auth-rpc-v1',
    kind: 'result',
    id: refreshReq.id,
    method: 'identity',
    result: ADMIN_IDENTITY,
  });

  await refreshPromise;
  assert.equal(timedClient.getIdentity().admin, false, 'stale refresh must not revive Admin after another call() timed out');
});

test('P2-S14-001: forged validation object with valid public stableDigest is rejected by publishRebuildTransaction and evaluateF6RebuildDenominator', async () => {
  const source = Uint8Array.of(1, 2, 3, 4);
  const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

  const transaction = createRebuildTransaction({
    binaryId: 'binary:elf:p2-s14-001',
    sourceHash: digest(source),
    format: 'elf',
    architecture: 'arm64',
    loaderVersion: 'loader:elf:p2-s14-001',
    operations: [{ id: 'grow', offset: 1, before: [2], after: [9, 8], provenance: { source: 'test' } }],
    impact: { layoutMoving: true, relocations: true, branchRanges: true, unwind: true, importsExports: true, signature: true },
    requireIndependentOracle: false,
  });
  const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
  assert.equal(materialized.status, 'materialized');

  // Construct a forged validation object with a completely valid public digest
  const forgedPayload = {
    schemaVersion: REBUILD_VALIDATION_SCHEMA,
    transactionId: transaction.transactionId,
    binaryId: transaction.binaryId,
    format: transaction.format,
    architecture: transaction.architecture,
    loaderVersion: transaction.loaderVersion,
    sourceHash: transaction.sourceHash,
    outputHash: materialized.outputHash,
    outputIdentity: materialized.outputIdentity,
    requiredValidators: [...transaction.requiredValidators],
    validators: transaction.requiredValidators.map((validator) => ({
      validator,
      executed: true,
      status: 'passed',
      reason: null,
      detail: null,
    })),
    allRequiredExecuted: true,
    status: 'valid',
    failures: [],
    discovery: null,
    independentDifferential: 'unavailable',
    independentOracleTrusted: false,
  };
  const forgedValidation = deepFreeze({
    ...forgedPayload,
    validationId: `rebuild-validation:${stableDigest(forgedPayload)}`,
  });

  let promoted = false;
  const forgedPub = await publishRebuildTransaction(materialized, forgedValidation, {
    atomicPromote: async () => {
      promoted = true;
      return {
        atomic: true,
        committed: true,
        protocol: 'transactional-store',
        publicationIdentity: 'artifact:forged',
        transactionId: materialized.transactionId,
        outputHash: materialized.outputHash,
        outputIdentity: materialized.outputIdentity,
      };
    },
  });
  assert.equal(forgedPub.status, 'rejected');
  assert.equal(forgedPub.reason, 'rebuild-v2-validation-not-green');
  assert.equal(promoted, false, 'atomicPromote must never be called for forged validation');

  const forgedF6 = evaluateF6RebuildDenominator({ transaction, validation: forgedValidation });
  assert.equal(forgedF6.cells['transaction-identity'].status, 'blocking');

  // Legitimate validation passes, while a cloned copy of the legitimate validation is rejected
  const genuineValidation = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse: () => ({
      ok: true,
      format: transaction.format,
      architecture: transaction.architecture,
      loaderVersion: transaction.loaderVersion,
      sourceHash: transaction.sourceHash,
      outputHash: materialized.outputHash,
    }),
    validators: Object.fromEntries(
      ['layout', 'relocations', 'branch-ranges', 'unwind', 'imports-exports', 'signature-consequence']
        .map((name) => [name, () => ({ ok: true })]),
    ),
  });
  assert.equal(genuineValidation.status, 'valid');
  assert.equal(Object.isFrozen(genuineValidation), true);

  const clonedValidation = deepFreeze(structuredClone(genuineValidation));
  const clonedPub = await publishRebuildTransaction(materialized, clonedValidation, {
    atomicPromote: async () => {
      promoted = true;
      return {
        atomic: true,
        committed: true,
        protocol: 'transactional-store',
        publicationIdentity: 'artifact:cloned',
        transactionId: materialized.transactionId,
        outputHash: materialized.outputHash,
        outputIdentity: materialized.outputIdentity,
      };
    },
  });
  assert.equal(clonedPub.status, 'rejected');
  assert.equal(clonedPub.reason, 'rebuild-v2-validation-not-green');
  assert.equal(promoted, false, 'atomicPromote must never be called for cloned validation');

  const genuinePub = await publishRebuildTransaction(materialized, genuineValidation, {
    atomicPromote: async () => ({
      atomic: true,
      committed: true,
      protocol: 'transactional-store',
      publicationIdentity: 'artifact:genuine',
      transactionId: materialized.transactionId,
      outputHash: materialized.outputHash,
      outputIdentity: materialized.outputIdentity,
    }),
  });
  assert.equal(genuinePub.status, 'published');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { AI_QUOTA, acquireQuotaState, normalizeQuotaState, releaseQuotaState } from '../js/ai/quota.js';
import { acquireDistributedQuota } from '../js/ai/provider/worker-transport.js';
import { DevSupervisorEngineV0 } from '../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DEV_TOOL_ERROR_HISTORY_KIND } from '../js/ai/dev/supervisor/tool-error-recovery.js';
import {
  DEV_RUNTIME_ACTIVATION_TOOL,
  DEV_RUNTIME_IDENTITY_TOOL,
  DEV_SELF_UPDATE_HISTORY_KIND,
  DEV_SELF_UPDATE_STATE,
  DevSelfUpdateGate,
} from '../js/ai/dev/bootstrap/self-update-gate.js';
import { ProposalStore } from '../js/ai/proposals.js';
import { AIError } from '../js/ai/schema.js';
import { validateSchema } from '../js/ai/validation.js';
import { stableDigest } from '../js/core/identity/index.js';

const OLD_COMMIT = 'a'.repeat(40);
const NEW_COMMIT = 'b'.repeat(40);
const OLD_BUILD = '1'.repeat(24);
const NEW_BUILD = '2'.repeat(24);

// 1. [P1] js/ai/quota.js — deep clock rollback concurrency enforcement
test('1. quota enforces concurrency limits during deep clock rollback without dropping new leases', () => {
  const initial = {
    windowStarted: 200_000,
    count: 0,
    sessions: {},
    leases: {},
  };

  // Clock rolled back to 0, where now + leaseMs (120_000) <= windowStarted (200_000).
  const first = acquireQuotaState(initial, { now: 0, sessionId: 's1', token: 't1' }, AI_QUOTA);
  assert.equal(first.result.allowed, true);
  assert.equal(first.result.active, 1);
  assert.equal(first.result.sessionActive, 1);
  assert.ok(first.state.leases.t1.expiresAt > first.state.windowStarted);

  const second = acquireQuotaState(first.state, { now: 0, sessionId: 's1', token: 't2' }, AI_QUOTA);
  assert.equal(second.result.allowed, true);
  assert.equal(second.result.active, 2);
  assert.equal(second.result.sessionActive, 2);
  assert.ok(second.state.leases.t1, 'first lease must survive normalizeQuotaState under deep rollback');
  assert.ok(second.state.leases.t2, 'second lease must be present');

  // Session concurrency limit (2) must now block a third concurrent lease.
  const third = acquireQuotaState(second.state, { now: 0, sessionId: 's1', token: 't3' }, AI_QUOTA);
  assert.equal(third.result.allowed, false);
  assert.equal(third.result.reason, 'concurrency');
  assert.equal(third.result.sessionActive, 2);
  assert.ok(third.result.retryAfterMs > 0);

  // Other sessions can still acquire up to ipConcurrencyLimit (4), then block.
  const fourth = acquireQuotaState(third.state, { now: 0, sessionId: 's2', token: 't4' }, AI_QUOTA);
  assert.equal(fourth.result.allowed, true);
  const fifth = acquireQuotaState(fourth.state, { now: 0, sessionId: 's2', token: 't5' }, AI_QUOTA);
  assert.equal(fifth.result.allowed, true);
  const sixth = acquireQuotaState(fifth.state, { now: 0, sessionId: 's3', token: 't6' }, AI_QUOTA);
  assert.equal(sixth.result.allowed, false);
  assert.equal(sixth.result.reason, 'concurrency');
  assert.equal(sixth.result.active, 4);

  // Releasing a lease frees the slot during rollback.
  const released = releaseQuotaState(sixth.state, 't1', 0, AI_QUOTA);
  assert.equal(released.released, true);
  const retry = acquireQuotaState(released.state, { now: 0, sessionId: 's1', token: 't7' }, AI_QUOTA);
  assert.equal(retry.result.allowed, true);

  // Already-expired leases (expiresAt <= windowStarted) are still dropped under rollback.
  const pruned = normalizeQuotaState({
    windowStarted: 200_000,
    count: 1,
    sessions: {},
    leases: { expired: { sessionId: 's1', expiresAt: 150_000 } },
  }, 0, AI_QUOTA);
  assert.deepEqual(pruned.leases, {});
});

// 2. [P1] js/ai/provider/worker-transport.js — pre-aborted signal, race-safe orphan release, listener cleanup
test('2a. acquireDistributedQuota does not invoke stub.acquire when request.signal is already aborted', async () => {
  let acquireCalls = 0;
  let releaseCalls = 0;
  const controller = new AbortController();
  controller.abort();

  const request = {
    headers: new Headers({ 'cf-connecting-ip': '203.0.113.10' }),
    signal: controller.signal,
  };
  const env = {
    AI_QUOTA: {
      getByName: () => ({
        acquire: async () => { acquireCalls += 1; return { allowed: true, token: 'tok-1' }; },
        release: async () => { releaseCalls += 1; },
      }),
    },
  };

  const out = await acquireDistributedQuota(request, env, 'sess-1');
  assert.equal(out.lease, null);
  assert.equal(out.response.status, 503);
  assert.equal(acquireCalls, 0, 'stub.acquire must never be called for a pre-aborted request');
  assert.equal(releaseCalls, 0);
});

test('2b. acquireDistributedQuota releases orphan lease even when acquirePromise resolves in same turn as abort', async () => {
  const releasedTokens = [];
  let resolveAcquire;
  const controller = new AbortController();

  const request = {
    headers: new Headers({ 'cf-connecting-ip': '203.0.113.11' }),
    signal: controller.signal,
  };
  const env = {
    AI_QUOTA: {
      getByName: () => ({
        acquire: () => new Promise((resolve) => { resolveAcquire = resolve; }),
        release: async (token) => { releasedTokens.push(token); },
      }),
    },
  };

  const pending = acquireDistributedQuota(request, env, 'sess-race');
  // Abort and resolve acquire in the exact same turn so disconnect wins Promise.race
  // while acquirePromise's .then microtask is also queued in the same turn.
  controller.abort();
  resolveAcquire({ allowed: true, token: 'tok-same-turn' });

  const out = await pending;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(out.lease, null);
  assert.equal(out.response.status, 503);
  assert.deepEqual(releasedTokens, ['tok-same-turn'], 'orphan lease must be released exactly once');
});

test('2c. acquireDistributedQuota removes abort listener on normal completion', async () => {
  const listeners = new Set();
  const fakeSignal = {
    aborted: false,
    addEventListener(event, fn) {
      if (event === 'abort') listeners.add(fn);
    },
    removeEventListener(event, fn) {
      if (event === 'abort') listeners.delete(fn);
    },
  };
  const request = {
    headers: new Headers({ 'cf-connecting-ip': '203.0.113.12' }),
    signal: fakeSignal,
  };
  const env = {
    AI_QUOTA: {
      getByName: () => ({
        acquire: async () => ({ allowed: true, token: 'tok-ok' }),
        release: async () => {},
      }),
    },
  };

  const out = await acquireDistributedQuota(request, env, 'sess-clean');
  assert.equal(out.response, null);
  assert.equal(out.lease.token, 'tok-ok');
  assert.equal(listeners.size, 0, 'abort listener must be removed after normal completion');
});

// 3. [P1] js/ai/dev/supervisor/dev-supervisor-engine-v0.js & self-update-gate.js
test('3a. model tool dev.runtime.require_activation cannot overwrite or downgrade an armed reload-required gate', async () => {
  let skillRan = false;
  const supervisor = new DevSupervisorV0({
    workerClient: {
      enabled: true,
      runtimeIdentity: async () => ({ commit: OLD_COMMIT, buildId: OLD_BUILD, userscriptVersion: '2.0.1' }),
      skillRun: async () => { skillRan = true; return { ran: true }; },
    },
    idFactory: (kind) => `track8-${kind}`,
    now: () => '2026-11-24T00:00:00.000Z',
  });
  const settings = { decisionPolicy: 'normal', lastRun: null, setLastRun(run) { this.lastRun = run; } };

  const decisions = [
    // Model attempts to overwrite the host-armed gate with the currently running OLD runtime identity
    // and downgrade requireReinitialization to false.
    {
      type: 'tool',
      tool: DEV_RUNTIME_ACTIVATION_TOOL,
      arguments: {
        expectedCommit: OLD_COMMIT,
        expectedBuildId: OLD_BUILD,
        capabilities: ['unrelated.tool'],
        requireReinitialization: false,
        reason: 'downgrade attempt',
      },
      purpose: 'attempt to overwrite armed gate',
    },
    // Model reads identity hoping it now matches the downgraded expectation.
    {
      type: 'tool',
      tool: DEV_RUNTIME_IDENTITY_TOOL,
      arguments: {},
      purpose: 'read stale identity',
    },
    // Model attempts to invoke the gated capability.
    {
      type: 'tool',
      tool: 'chatgpt.skill.run',
      arguments: { skillId: 'project.create', program: 'probe' },
      purpose: 'attempt gated capability',
    },
    { type: 'final', answer: 'blocked', completedTasks: [], remaining: [] },
  ];

  const prompts = [];
  let idx = 0;
  const bridge = {
    async request(prompt) {
      prompts.push(String(prompt));
      return JSON.stringify(decisions[Math.min(idx++, decisions.length - 1)]);
    },
  };

  const engine = new DevSupervisorEngineV0({ supervisor, settings, bridge });
  // Host arms the gate with NEW_COMMIT / NEW_BUILD and requireReinitialization: true.
  engine.requireRuntimeActivation({
    expectedCommit: NEW_COMMIT,
    expectedBuildId: NEW_BUILD,
    capabilities: ['chatgpt.skill.run'],
    requireReinitialization: true,
    reason: 'host-armed self-update',
  });

  const result = await engine.run({ goal: 'test self-update gate defense', conversationId: 'conv-track8-gate' });
  assert.equal(result.answer, 'blocked');
  assert.equal(skillRan, false, 'gated capability must not execute');

  const status = engine.runtimeActivationStatus();
  assert.equal(status.state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED);
  assert.equal(status.expected.commit, NEW_COMMIT);
  assert.equal(status.expected.buildId, NEW_BUILD);
  assert.equal(status.requiresReinitialization, true);
  assert.deepEqual([...status.gatedCapabilities], ['chatgpt.skill.run']);

  const historyOf = (i) => {
    const match = prompts[i].match(/<HEX_DEV_DATA>\n([\s\S]*?)\n<\/HEX_DEV_DATA>/);
    assert.ok(match);
    return JSON.parse(match[1]).history;
  };
  assert.equal(historyOf(1).at(-1).kind, DEV_TOOL_ERROR_HISTORY_KIND);
  assert.equal(historyOf(1).at(-1).tool, DEV_RUNTIME_ACTIVATION_TOOL);
  assert.equal(historyOf(3).at(-1).kind, DEV_SELF_UPDATE_HISTORY_KIND);
  assert.equal(historyOf(3).at(-1).tool, 'chatgpt.skill.run');
});

test('3b. DevSelfUpdateGate rejects allowOverwrite:false while reload-required and rejects relaxing requireReinitialization', () => {
  const gate = new DevSelfUpdateGate();
  gate.requireActivation({
    expectedCommit: NEW_COMMIT,
    expectedBuildId: NEW_BUILD,
    requireReinitialization: true,
    capabilities: ['chatgpt.skill.run'],
  });
  const snapshot = gate.status();

  assert.throws(
    () => gate.requireActivation(
      { expectedCommit: OLD_COMMIT, expectedBuildId: OLD_BUILD, requireReinitialization: false },
      { allowOverwrite: false },
    ),
    /dev-self-update-gate-already-armed/,
  );
  assert.deepEqual(gate.status(), snapshot);

  assert.throws(
    () => gate.requireActivation({
      expectedCommit: NEW_COMMIT,
      expectedBuildId: NEW_BUILD,
      requireReinitialization: false,
    }),
    /dev-self-update-gate-downgrade-rejected/,
  );
  assert.deepEqual(gate.status(), snapshot);
});

// 4. [P1] js/ai/proposals.js — decodePersistedValue bounds & restoredPendingRecord invariants
test('4a. restorePersistedPending rejects oversized sparse array and excessive depth in executionPayload', () => {
  const evidenceStore = { has: (id) => id === 'ev_1' };
  const store = new ProposalStore({ evidenceStore, binding: () => ({ project: 'p1' }) });
  const base = store.create({
    kind: 'rename',
    target: { address: '0x1000' },
    before: { name: 'old' },
    after: { name: 'new' },
    evidenceIds: ['ev_1'],
  });
  const [persisted] = store.persistedActions();

  // Giant sparse array in executionPayload: ['array', 0, 100000000, []]
  const giantSparsePayload = JSON.stringify({
    version: 1,
    target: ['array', 0, 100_000_000, []],
    before: ['null'],
    after: ['null'],
  });
  const restored1 = new ProposalStore({ evidenceStore, binding: () => ({ project: 'p1' }) });
  const t0 = Date.now();
  restored1.restorePersistedPending([{ ...persisted, id: 'p_giant', executionPayload: giantSparsePayload }]);
  assert.ok(Date.now() - t0 < 200, 'giant sparse array decode must reject quickly');
  assert.equal(restored1.has('p_giant'), false);

  // Deeply nested executionPayload (> 128 levels)
  let deepNode = ['null'];
  for (let i = 0; i < 160; i++) {
    deepNode = ['array', 160 - i, 1, [['0', deepNode]]];
  }
  const deepPayload = JSON.stringify({
    version: 1,
    target: deepNode,
    before: ['null'],
    after: ['null'],
  });
  const restored2 = new ProposalStore({ evidenceStore, binding: () => ({ project: 'p1' }) });
  restored2.restorePersistedPending([{ ...persisted, id: 'p_deep', executionPayload: deepPayload }]);
  assert.equal(restored2.has('p_deep'), false);

  // Oversized sparse array on executionDisplayExact path
  const giantSparse = new Array(1_000_000);
  const restored3 = new ProposalStore({ evidenceStore, binding: () => ({ project: 'p1' }) });
  const t1 = Date.now();
  restored3.restorePersistedPending([{
    ...base,
    id: 'p_display_giant',
    target: giantSparse,
    executionDisplayExact: true,
    targetRevision: 'dummy',
    afterRevision: 'dummy',
  }]);
  assert.ok(Date.now() - t1 < 200, 'oversized display record must reject in O(1)');
  assert.equal(restored3.has('p_display_giant'), false);
});

test('4b. restorePersistedPending enforces rejectStructFieldTargetOverride and hasProjectAnnotationTargetId', () => {
  const evidenceStore = { has: (id) => id === 'ev_1' };
  const binding = () => ({ project: 'p1' });
  const bindingRevision = stableDigest(`o{"project":s${JSON.stringify('p1')}}`);

  // Forge a struct-field record whose `after` overrides `offset`
  const sfTarget = ['object', 0, 1, [['struct', ['string', 'Foo']], ['offset', ['number', 0]]]];
  const sfBefore = ['object', 0, 1, [['type', ['string', 'int']]]];
  const sfAfter = ['object', 0, 1, [['type', ['string', 'long']], ['offset', ['number', 8]]]];
  const sfExecPayload = JSON.stringify({ version: 1, target: sfTarget, before: sfBefore, after: sfAfter });
  const forgedStructField = {
    id: 'forged_sf',
    kind: 'struct-field',
    status: 'pending',
    createdAt: '2026-11-24T00:00:00.000Z',
    evidenceIds: ['ev_1'],
    bindingRevision,
    revision: stableDigest(`o{"type":s${JSON.stringify('int')}}`),
    targetRevision: stableDigest(JSON.stringify(sfTarget)),
    afterRevision: stableDigest(JSON.stringify(sfAfter)),
    executionPayload: sfExecPayload,
  };
  const store1 = new ProposalStore({ evidenceStore, binding });
  store1.restorePersistedPending([forgedStructField]);
  assert.equal(store1.has('forged_sf'), false, 'struct-field with target override in after must not be restored');

  // Forge a project-annotation record missing a non-empty string target.id
  const paTarget = ['object', 0, 1, [['id', ['string', '']]]];
  const paBefore = ['null'];
  const paAfter = ['string', 'note'];
  const paExecPayload = JSON.stringify({ version: 1, target: paTarget, before: paBefore, after: paAfter });
  const forgedProjectAnnotation = {
    id: 'forged_pa',
    kind: 'project-annotation',
    status: 'pending',
    createdAt: '2026-11-24T00:00:00.000Z',
    evidenceIds: ['ev_1'],
    bindingRevision,
    revision: stableDigest('n'),
    targetRevision: stableDigest(JSON.stringify(paTarget)),
    afterRevision: stableDigest(JSON.stringify(paAfter)),
    executionPayload: paExecPayload,
  };
  const store2 = new ProposalStore({ evidenceStore, binding });
  store2.restorePersistedPending([forgedProjectAnnotation]);
  assert.equal(store2.has('forged_pa'), false, 'project-annotation without non-empty target.id must not be restored');
});

// 5. [P2] js/ai/proposals.js — admitBoundedProposalState O(1) early rejection
test('5. admitBoundedProposalState rejects giant sparse arrays in O(1) without looping', () => {
  const store = new ProposalStore({ evidenceStore: { has: () => true } });
  const giantArray = new Array(50_000_000);
  const start = Date.now();
  assert.throws(
    () => store.create({
      kind: 'comment',
      target: { address: '0x1000' },
      before: giantArray,
      after: 'c',
      evidenceIds: ['ev_1'],
    }),
    (err) => err instanceof AIError && err.type === 'tool_failed' && /budget/i.test(err.message),
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `expected O(1) rejection (<100ms), took ${elapsed}ms`);
});

// 6. [P2] js/ai/validation.js — schema.minItems validation
test('6. validateSchema enforces schema.minItems on arrays', () => {
  const schema = { type: 'array', minItems: 2, maxItems: 3, items: { type: 'integer' } };

  const empty = validateSchema([], schema);
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((e) => e.includes('too few items')));

  const one = validateSchema([1], schema);
  assert.equal(one.ok, false);
  assert.ok(one.errors.some((e) => e.includes('too few items')));

  assert.equal(validateSchema([1, 2], schema).ok, true);
  assert.equal(validateSchema([1, 2, 3], schema).ok, true);

  const four = validateSchema([1, 2, 3, 4], schema);
  assert.equal(four.ok, false);
  assert.ok(four.errors.some((e) => e.includes('too many items')));

  assert.equal(validateSchema([], { type: 'array', minItems: 0 }).ok, true);
});

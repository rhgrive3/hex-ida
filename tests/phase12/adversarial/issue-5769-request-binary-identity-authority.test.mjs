// Regression for #5769: request-supplied binary identity is an assertion/fallback,
// never authority over a strong live workbench binding. A mismatch must fail
// before any session/store/planner side effect, while an explicit request
// identity remains usable when the live workbench is genuinely unbound.
import assert from 'node:assert/strict';
import test from 'node:test';

import { AIRuntime } from '../../../js/ai/runtime.js';
import { assertLiveBindingsUnchanged } from '../../../js/ai/control/runtime-support.js';
import { createTurnSnapshot, createSnapshotContext, resolveBinaryIdentity } from '../../../js/ai/control/snapshot.js';
import { createHexToolRegistry } from '../../../js/ai/tools/index.js';

const strongIdentity = (hash) => ({
  id: `content:${hash}`,
  kind: 'content-derived',
  confidence: 'strong',
  state: 'ready',
  algorithm: 'existing-hash',
  hash,
  legacyId: null,
});

function makeSpySessionStore() {
  const calls = { get:0, create:0, update:0, updateMemory:0, appendMessage:0 };
  const sessions = new Map();
  return {
    calls,
    async get(id) { calls.get++; return sessions.get(id) || null; },
    async create(input) {
      calls.create++;
      const session = {
        id: input.id || 'session-created',
        ...input,
        messages: [],
        investigationMemory: input.investigationMemory || {},
        confirmedFindings: [], hypotheses: [], rejectedHypotheses: [], proposedActions: [],
      };
      sessions.set(session.id, session);
      return session;
    },
    async update(id, patch) {
      calls.update++;
      const current = sessions.get(id) || { id, messages: [], investigationMemory: {} };
      const next = { ...current, ...patch };
      sessions.set(id, next);
      return next;
    },
    async updateMemory(id, patch) {
      calls.updateMemory++;
      const current = sessions.get(id) || { id, messages: [], investigationMemory: {} };
      const next = { ...current, investigationMemory: { ...(current.investigationMemory || {}), ...patch } };
      sessions.set(id, next);
      return next;
    },
    async appendMessage(id, message) {
      calls.appendMessage++;
      const current = sessions.get(id) || { id, messages: [], investigationMemory: {} };
      const next = { ...current, messages: [...(current.messages || []), message] };
      sessions.set(id, next);
      return next;
    },
  };
}

test('#5769 live strong identity is the snapshot authority over stale request identity', () => {
  const local = { binaryHash:'bbbb', binaryId:'live-B' };
  const requested = { binaryIdentity:strongIdentity('aaaa') };
  const identity = resolveBinaryIdentity(local, requested);
  assert.equal(identity.id, 'content:bbbb');
  assert.equal(identity.hash, 'bbbb');
  assert.throws(() => createTurnSnapshot(local, requested), (error) => error?.type === 'scope_violation');
});

test('#5769 matching request identity preserves the live strong binding', () => {
  const snapshot = createTurnSnapshot(
    { binaryHash:'bbbb', binaryId:'live-B' },
    { binaryIdentity:strongIdentity('bbbb') },
  );
  assert.equal(snapshot.binaryId, 'content:bbbb');
  assert.equal(snapshot.binaryIdentity.hash, 'bbbb');
});

test('#5769 no request identity keeps normal live authority', () => {
  const snapshot = createTurnSnapshot({ binaryHash:'bbbb', binaryId:'live-B' }, {});
  assert.equal(snapshot.binaryId, 'content:bbbb');
});

test('#5769 a strong live content hash outranks weak local/request fallback identities', () => {
  const snapshot = createTurnSnapshot({
    binaryHash:'bbbb',
    binaryIdentity:{ id:'fallback:old.bin:0', kind:'fallback', confidence:'weak', state:'hash-unavailable', legacyId:'old.bin:0' },
  }, { binaryId:'stale-request.bin:0' });
  assert.equal(snapshot.binaryId, 'content:bbbb');
  assert.equal(snapshot.binaryIdentitySource, 'live');
});

test('#5769 stale request binaryHash is also rejected before side effects', async () => {
  const sessionStore = makeSpySessionStore();
  const runtime = new AIRuntime({ context:{ binaryHash:'bbbb' }, sessionStore, planner:false });
  await assert.rejects(
    () => runtime.turn({ mode:'chat', goal:'hash assertion', binaryHash:'aaaa' }),
    (error) => error?.type === 'scope_violation',
  );
  assert.deepEqual(sessionStore.calls, { get:0, create:0, update:0, updateMemory:0, appendMessage:0 });
});

test('#5769 mismatch rejects before session lookup/write and planner execution', async () => {
  const sessionStore = makeSpySessionStore();
  let plannerCalls = 0;
  const runtime = new AIRuntime({
    context: { binaryHash:'bbbb', binaryId:'live-B' },
    sessionStore,
    planner: async () => { plannerCalls++; return { candidates:[], missingEvidence:[] }; },
  });
  await assert.rejects(
    () => runtime.turn({
      mode:'agent', goal:'audit binding', sessionId:'session-A',
      binaryIdentity:strongIdentity('aaaa'),
    }),
    (error) => error?.type === 'scope_violation',
  );
  assert.deepEqual(sessionStore.calls, {
    get:0, create:0, update:0, updateMemory:0, appendMessage:0,
  }, 'a stale request binding must be rejected before any session/store side effect');
  assert.equal(plannerCalls, 0, 'planner must not observe a mismatched workbench/request binding');
  assert.equal(runtime.storeNamespaces.size, 0, 'wrong-binary store namespace must not be created');
});

test('#5769 request identity remains an explicit fallback when live binding is unbound', async () => {
  const sessionStore = makeSpySessionStore();
  const runtime = new AIRuntime({ context:{}, sessionStore, planner:false });
  const result = await runtime.turn({
    mode:'chat', goal:'fallback binding', binaryIdentity:strongIdentity('aaaa'),
  });
  assert.equal(result.mode, 'chat');
  assert.equal(sessionStore.calls.create, 1);
  const created = await sessionStore.get('session-created');
  assert.equal(created.binaryId, 'content:aaaa');
});

test('#5769 actual createHexToolRegistry sees the live-authoritative snapshot context', async () => {
  const local = {
    binaryHash:'bbbb', binaryId:'live-B', analysisRevision:'analysis:1',
    currentAddress:0x2000n,
    selection:{ start:0x2000n, end:0x2004n, instructions:[] },
  };
  const snapshot = createTurnSnapshot(local, { binaryIdentity:strongIdentity('bbbb') });
  const context = createSnapshotContext(local, snapshot);
  const registry = createHexToolRegistry(context);
  const observed = await registry.execute('get_selection_context', {}, { scope:'binary' });
  assert.equal(registry.observationStore.binding().binaryIdentity, 'content:bbbb');
  assert.equal(observed.result.functionAddress, '0x2000');
  assert.equal(observed.result.found, true);
});

test('#5769 request-fallback snapshot still rejects a later live binary binding change', () => {
  const local = {};
  const snapshot = createTurnSnapshot(local, { binaryIdentity:strongIdentity('aaaa') });
  assert.equal(snapshot.binaryIdentitySource, 'request-fallback');
  assert.doesNotThrow(() => assertLiveBindingsUnchanged(local, snapshot));
  local.binaryHash = 'bbbb';
  assert.throws(
    () => assertLiveBindingsUnchanged(local, snapshot),
    (error) => error?.type === 'scope_violation',
  );
});

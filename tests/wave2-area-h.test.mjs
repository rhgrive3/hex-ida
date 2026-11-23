import test from 'node:test';
import assert from 'node:assert/strict';

import { InstrumentationProvider } from '../js/runtime/instrumentation-provider.js';
import { DebuggerProvider } from '../js/runtime/debugger-provider.js';
import { DebugSession, DebugSessionManager } from '../js/runtime/session.js';
import { TraceProvider } from '../js/runtime/trace-provider.js';
import { createRuntimeObservation } from '../js/runtime/authority.js';
import { compareExpected, HypothesisVerifier } from '../js/dynamic/experiments.js';
import { selectorFromSymbol } from '../js/apple/selector-stubs.js';
import {
  APPLE_KNOWLEDGE_SCHEMA,
  APPLE_KNOWLEDGE_MATRIX_VERSION,
  APPLE_KNOWLEDGE_FORMAT_MATRIX,
  APPLE_KNOWLEDGE_PROVIDER_ID,
  APPLE_KNOWLEDGE_PROVIDER_VERSION,
  parseSerializedAppleKnowledge,
} from '../js/apple/knowledge.js';

const BINARY_ID = 'sha256:' + 'a'.repeat(40);

/* ── [W2-H-#1 P1] materializeRuntimeValue preserves plain object `length` ── */
test('[W2-H-#1] InstrumentationProvider preserves plain object length property in event payloads', async () => {
  let emit = null;
  const backend = {
    id: 'inst-length',
    onEvent(cb) { emit = cb; return () => {}; },
  };
  const provider = new InstrumentationProvider(backend, { id: 'inst-length-p' });
  const session = await provider.openSession({ binaryId: BINARY_ID, targetIdentity: 'proc:1', sessionNonce: 'n:1' });

  const ev = emit({
    kind: 'memory-read',
    epoch: 1,
    payload: { address: '0x1000', length: 64, nested: { length: 12, label: 'ok' } },
  });
  assert.ok(ev, 'event should be admitted');
  assert.equal(ev.payload.length, 64);
  assert.equal(ev.payload.nested.length, 12);
  assert.equal(ev.payload.nested.label, 'ok');
  await session.close();
});

/* ── [W2-H-#2 P1] materializeRuntimeValue fails closed on SharedArrayBuffer / non-plain objects ── */
test('[W2-H-#2] InstrumentationProvider rejects SharedArrayBuffer and non-plain objects instead of laundering to {}', async () => {
  let emit = null;
  const backend = {
    id: 'inst-sab',
    onEvent(cb) { emit = cb; return () => {}; },
  };
  const provider = new InstrumentationProvider(backend, { id: 'inst-sab-p' });
  const session = await provider.openSession({ binaryId: BINARY_ID, targetIdentity: 'proc:2', sessionNonce: 'n:2' });

  const sab = new SharedArrayBuffer(16);
  assert.throws(
    () => emit({ kind: 'trace-marker', epoch: 1, payload: { buf: sab } }),
    (err) => err?.code === 'runtime-event-unsupported-value',
  );

  class CustomBox { constructor(v) { this.v = v; } }
  assert.throws(
    () => emit({ kind: 'trace-marker', epoch: 1, payload: { box: new CustomBox(42) } }),
    (err) => err?.code === 'runtime-event-unsupported-value',
  );
  await session.close();
});

/* ── [W2-H-#3 P1] compareExpected evaluates stop.kind === 'cancelled' before !expected ── */
test('[W2-H-#3] compareExpected and HypothesisVerifier treat cancelled null-expected case as unsupported/cancelled, not complete', async () => {
  const cmp = compareExpected(
    { id: 'case:ptr', expected: null },
    { stop: { kind: 'cancelled', message: 'aborted' }, memoryDelta: [], memoryAfter: [], returnValue: null },
  );
  assert.equal(cmp.status, 'unsupported');
  assert.equal(cmp.reason, 'execution-cancelled');

  const ac = new AbortController();
  ac.abort('user-cancelled');
  let launches = 0;
  const verifier = new HypothesisVerifier({
    launch: async () => { launches++; return {}; },
    resume: async () => ({ stop: { kind: 'normal' }, memoryDelta: [], memoryAfter: [], returnValue: 0 }),
  });
  const experiment = {
    id: 'exp-cancel',
    functionAddress: 0x1000n,
    cases: [
      { id: 'c1', input: { arguments: [0x2000n, 1n] }, initialState: { objectBase: 0x2000n, fields: [] }, watch: [], expected: null },
      { id: 'c2', input: { arguments: [0x2000n, 2n] }, initialState: { objectBase: 0x2000n, fields: [] }, watch: [], expected: null },
    ],
  };
  const res = await verifier.verify(experiment, { signal: ac.signal });
  assert.equal(launches, 0);
  assert.equal(res.coverage.cancelled, true);
  assert.equal(res.coverage.complete, false);
  assert.equal(res.cases.length, 1);
  assert.ok(res.coverage.reasons.includes('cancelled'));
});

/* ── [W2-H-#4 P1] selectorFromSymbol excludes objc_msgSend_* ABI variant suffixes ── */
test('[W2-H-#4] selectorFromSymbol excludes ABI variant suffixes (stret, fpret, fp2ret, debug, noarg)', () => {
  for (const sym of [
    '_objc_msgSend_stret',
    '_objc_msgSend_fpret',
    '_objc_msgSend_fp2ret',
    '_objc_msgSend_debug',
    '_objc_msgSend_noarg',
    'objc_msgSend_stret',
    '_objc_msgSend_stret_fixup',
    '_objc_msgSend_fixup',
    '_objc_msgSend_stub',
  ]) {
    assert.equal(selectorFromSymbol(sym), null, `expected null for ABI variant ${sym}`);
  }
  assert.equal(selectorFromSymbol('_objc_msgSend$initWithFrame:'), 'initWithFrame:');
  assert.equal(selectorFromSymbol('objc_msgSend$sharedInstance'), 'sharedInstance');
  assert.equal(selectorFromSymbol('_objc_msgSend_fixup_alloc'), 'alloc');
});

/* ── [W2-H-#5 P1] TraceProvider preserves module.identityState === 'mismatch' ── */
test('[W2-H-#5] TraceProvider preserves explicit mismatch identityState instead of overwriting with unresolved', async () => {
  const provider = new TraceProvider({
    recordingId: 'rec-mismatch',
    binaryId: BINARY_ID,
    modules: [
      {
        bindingKey: 'mod-mismatch',
        runtimeBase: 0x10000n,
        runtimeSize: 0x4000n,
        binaryId: BINARY_ID,
        identityState: 'mismatch',
        identityEvidenceIds: ['ev-1'],
      },
      {
        bindingKey: 'mod-unresolved',
        runtimeBase: 0x20000n,
        runtimeSize: 0x4000n,
        identityState: 'unresolved',
      },
    ],
    events: [],
  });
  const session = await provider.openSession({ binaryId: BINARY_ID, targetIdentity: 'proc:trace', sessionNonce: 'trace:1' });
  const mismatchMod = session.modules.get('mod-mismatch');
  const unresolvedMod = session.modules.get('mod-unresolved');
  assert.equal(mismatchMod.identityState, 'mismatch');
  assert.equal(mismatchMod.binaryId, null);
  assert.equal(unresolvedMod.identityState, 'unresolved');
  await session.close();
});

/* ── [W2-H-#6 P2] authority.js typeTagged handles cyclic payloads (TypeError) and Date(NaN) without RangeError ── */
test('[W2-H-#6] createRuntimeObservation handles invalid Date(NaN) without RangeError and rejects cyclic payload with TypeError', () => {
  const baseBinding = {
    providerIdentity: 'prov:test',
    runtimeInstanceIdentity: 'inst:test',
    targetIdentity: 'proc:test',
    targetProfileId: 'arm64-apple-darwin',
    binaryIdentity: BINARY_ID,
    buildIdentity: 'build:test',
    moduleIdentity: 'mod:test',
    loadMappingIdentity: 'map:test',
    sessionIdentity: 'sess:test',
    capabilityVersion: '1.0.0',
    sequence: 1,
    timestamp: new Date().toISOString(),
  };
  const obs = createRuntimeObservation({
    ...baseBinding,
    kind: 'trace-marker',
    payload: { when: new Date(Number.NaN) },
  });
  assert.ok(obs.observationId.startsWith('runtime-observation:v3:'));

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => createRuntimeObservation({ ...baseBinding, kind: 'trace-marker', payload: cyclic }),
    (err) => err instanceof TypeError && /runtime-observation-cyclic-payload/.test(err.message),
  );
});

/* ── [W2-H-#7 P2] compareExpected validates integer inputs before BigInt() ── */
test('[W2-H-#7] compareExpected returns inconclusive on non-integer field offset or values instead of throwing SyntaxError/TypeError', () => {
  const badOffset = compareExpected(
    { expected: { field: { offset: 'not-an-int', value: 10, bits: 64 } } },
    { stop: { kind: 'normal' }, memoryAfter: [{ offset: 0n, size: 8, value: 10n }] },
  );
  assert.equal(badOffset.status, 'inconclusive');
  assert.equal(badOffset.reason, 'invalid-expected-field-offset');

  const badObserved = compareExpected(
    { expected: { field: { offset: 8, value: 10, bits: 64 } } },
    { stop: { kind: 'normal' }, memoryAfter: [{ offset: 8n, size: 8, value: 'bad-hex' }] },
  );
  assert.equal(badObserved.status, 'inconclusive');
  assert.equal(badObserved.reason, 'observed-field-value-not-an-integer');

  const badWanted = compareExpected(
    { expected: { field: { offset: 8, value: { bad: true }, bits: 64 } } },
    { stop: { kind: 'normal' }, memoryAfter: [{ offset: 8n, size: 8, value: 10n }] },
  );
  assert.equal(badWanted.status, 'inconclusive');
  assert.equal(badWanted.reason, 'observed-field-value-not-an-integer');
});

/* ── [W2-H-#8 P2] parseSerializedAppleKnowledge preserves assertedComplete ── */
test('[W2-H-#8] parseSerializedAppleKnowledge preserves original serializedEvidence.assertedComplete', () => {
  const cells = Object.fromEntries([
    'dyldCache', 'chainedFixups', 'swift', 'objc', 'pointerAuthentication', 'codeSigning',
  ].map((name) => [name, {
    status: 'unknown',
    version: null,
    evidence: name === 'codeSigning' ? { validity: 'unknown', authoritativeValidation: null } : {},
    reasons: ['serialized-evidence-requires-source-reparse'],
    complete: false,
  }]));
  const payload = {
    schema: APPLE_KNOWLEDGE_SCHEMA,
    matrixVersion: APPLE_KNOWLEDGE_MATRIX_VERSION,
    formatMatrix: APPLE_KNOWLEDGE_FORMAT_MATRIX,
    provider: { id: APPLE_KNOWLEDGE_PROVIDER_ID, version: APPLE_KNOWLEDGE_PROVIDER_VERSION },
    identity: { binaryIdentity: 'sha256:test', sliceIdentity: 'thin:arm64', authoritative: false },
    cells,
    complete: false,
    reasons: ['serialized-evidence-requires-source-reparse'],
    serializedEvidence: { authority: 'untrusted', assertedComplete: true },
  };
  const reparsed = parseSerializedAppleKnowledge(JSON.stringify(payload));
  assert.equal(reparsed.complete, false);
  assert.equal(reparsed.serializedEvidence.assertedComplete, true);
});

/* ── [W2-H-#9 P2] Epoch handoff overflow rolls back external adapter or closes session ── */
test('[W2-H-#9] Epoch handoff overflow rolls back adapter/backend when setEpoch exists, and closes session when rollback is unavailable', async () => {
  // 1. DebugSession: rollback via setEpoch(prevEpoch)
  {
    let adapterEpoch = 1;
    let emit = null;
    const adapter = {
      id: 'dbg-sess-rb',
      kind: 'mock',
      capabilities: {},
      setEpoch(e) {
        adapterEpoch = e;
        if (e === 2) {
          for (let i = 0; i < 4097; i++) emit({ kind: 'trace-marker', epoch: 2, seq: i });
        }
      },
      async connect() { return {}; },
      async disconnect() {},
      onEvent(cb) { emit = cb; return () => {}; },
    };
    const session = new DebugSession(adapter);
    await session.connect();
    assert.throws(() => session.newEpoch(), (err) => err?.code === 'runtime-epoch-handoff-overflow');
    assert.equal(session.epoch, 1);
    assert.equal(adapterEpoch, 1);
    assert.equal(session.closed, false);
    await session.disconnect();
  }

  // 2. DebugSession: nextEpoch (no rollback) -> closes session
  {
    let emit = null;
    const adapter = {
      id: 'dbg-sess-close',
      kind: 'mock',
      capabilities: {},
      nextEpoch() {
        for (let i = 0; i < 4097; i++) emit({ kind: 'trace-marker', epoch: 2, seq: i });
      },
      async connect() { return {}; },
      async disconnect() {},
      onEvent(cb) { emit = cb; return () => {}; },
    };
    const session = new DebugSession(adapter);
    await session.connect();
    assert.throws(() => session.newEpoch(), (err) => err?.code === 'runtime-epoch-handoff-overflow');
    assert.equal(session.closed, true);
  }

  // 3. DebuggerProvider: rollback via setEpoch(prevEpoch)
  {
    let adapterEpoch = 1;
    let emit = null;
    const adapter = {
      id: 'dbg-prov-rb',
      kind: 'mock',
      capabilities: {},
      setEpoch(e) {
        adapterEpoch = e;
        if (e === 2) {
          for (let i = 0; i < 5; i++) emit({ kind: 'trace-marker', epoch: 2, timestamp: i });
        }
      },
      async connect() { return {}; },
      async disconnect() {},
      onEvent(cb) { emit = cb; return () => {}; },
    };
    const provider = new DebuggerProvider(adapter, { events: { maxEvents: 3 } });
    const session = await provider.openSession({ binaryId: BINARY_ID, targetIdentity: 'proc:dbg', sessionNonce: 'dbg:1' });
    assert.throws(() => session.newProviderEpoch(), (err) => err?.code === 'runtime-epoch-handoff-overflow');
    assert.equal(session.epoch, 1);
    assert.equal(adapterEpoch, 1);
    await session.close();
  }

  // 4. InstrumentationProvider: rollback via backend.setEpoch(prevEpoch), and close on rollback failure
  {
    let backendEpoch = 1;
    let emit = null;
    const backend = {
      id: 'inst-rb',
      setEpoch(e) {
        backendEpoch = e;
        if (e === 2) {
          for (let i = 0; i < 5; i++) emit({ kind: 'trace-marker', epoch: 2, timestamp: i });
        }
      },
      onEvent(cb) { emit = cb; return () => {}; },
    };
    const provider = new InstrumentationProvider(backend, { events: { maxEvents: 3 } });
    const session = await provider.openSession({ binaryId: BINARY_ID, targetIdentity: 'proc:inst1', sessionNonce: 'inst:1' });
    assert.throws(() => session.newProviderEpoch(), (err) => err?.code === 'runtime-epoch-handoff-overflow');
    assert.equal(session.epoch, 1);
    assert.equal(backendEpoch, 1);
    await session.close();
  }

  {
    let emit = null;
    const backend = {
      id: 'inst-close',
      setEpoch(e) {
        if (e === 2) {
          for (let i = 0; i < 5; i++) emit({ kind: 'trace-marker', epoch: 2, timestamp: i });
        } else if (e === 1) {
          throw new Error('rollback failed');
        }
      },
      onEvent(cb) { emit = cb; return () => {}; },
    };
    const provider = new InstrumentationProvider(backend, { events: { maxEvents: 3 } });
    const session = await provider.openSession({ binaryId: BINARY_ID, targetIdentity: 'proc:inst2', sessionNonce: 'inst:2' });
    assert.throws(() => session.newProviderEpoch(), (err) => err?.code === 'runtime-epoch-handoff-overflow');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(session.closed, true);
  }
});

/* ── [W2-H-#10 P2] DebugSession fail-closed newEpoch() invokes & clears _onClosed ── */
test('[W2-H-#10] DebugSession fail-closed newEpoch() invokes onClosed and evicts session from DebugSessionManager', async () => {
  const manager = new DebugSessionManager();
  const closedCalls = [];
  let emit = null;
  let disconnectCalls = 0;
  const adapter = {
    id: 'dbg-mgr-close',
    kind: 'mock',
    capabilities: {},
    nextEpoch() {
      for (let i = 0; i < 4097; i++) emit({ kind: 'trace-marker', epoch: 2, seq: i });
    },
    async connect() { return {}; },
    async disconnect() { disconnectCalls++; },
    onEvent(cb) { emit = cb; return () => {}; },
  };

  const session = manager.create(adapter, { onClosed: (s) => { closedCalls.push(s); } });
  await session.connect();
  assert.equal(manager.current, session);
  assert.equal(manager.sessions.has(session.id), true);

  assert.throws(() => session.newEpoch(), (err) => err?.code === 'runtime-epoch-handoff-overflow');
  assert.equal(session.closed, true);
  assert.equal(disconnectCalls, 1);
  assert.equal(manager.sessions.has(session.id), false);
  assert.equal(manager.current, null);
  assert.equal(closedCalls.length, 1);
  assert.equal(closedCalls[0], session);

  // Subsequent disconnect/close must be a no-op and not double-invoke onClosed.
  await session.disconnect();
  assert.equal(await manager.close(session.id), false);
  assert.equal(closedCalls.length, 1);
});

/* ── [W2-H-#11 P2] InstrumentationProvider awaits async backend.setEpoch rollback before clearing epochTransitionPending ── */
test('[W2-H-#11] InstrumentationProvider awaits async rollback before clearing epochTransitionPending or rejecting', async () => {
  // 1. Async rollback resolves: concurrent newProviderEpoch() is blocked until rollback settles, then next epoch works.
  {
    let emit = null;
    let resolveRollback = null;
    let rollbackStarted = false;
    let rollbackSettled = false;
    let allowCleanEpoch2 = false;
    let backendEpoch = 1;
    const backend = {
      id: 'inst-async-rb-ok',
      setEpoch(e) {
        backendEpoch = e;
        if (e === 2 && !allowCleanEpoch2) {
          for (let i = 0; i < 5; i++) emit({ kind: 'trace-marker', epoch: 2, timestamp: i });
          return Promise.resolve();
        }
        if (e === 1) {
          rollbackStarted = true;
          return new Promise((resolve) => {
            resolveRollback = () => {
              rollbackSettled = true;
              resolve();
            };
          });
        }
        return Promise.resolve();
      },
      onEvent(cb) { emit = cb; return () => {}; },
    };
    const provider = new InstrumentationProvider(backend, { events: { maxEvents: 3 } });
    const session = await provider.openSession({ binaryId: BINARY_ID, targetIdentity: 'proc:async1', sessionNonce: 'async:1' });

    let transitionSettled = false;
    const transitionPromise = session.newProviderEpoch().then(
      () => { transitionSettled = true; },
      (err) => { transitionSettled = true; throw err; },
    );

    // Let setEpoch(2) resolve and enter endHandoffWindow -> setEpoch(1)
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(rollbackStarted, true);
    assert.equal(rollbackSettled, false);
    assert.equal(transitionSettled, false, 'newProviderEpoch must not reject before async rollback finishes');

    assert.throws(
      () => session.newProviderEpoch(),
      (err) => err?.code === 'runtime-epoch-transition-active',
      'concurrent newProviderEpoch must be rejected while async rollback is in flight',
    );

    resolveRollback();
    await assert.rejects(transitionPromise, (err) => err?.code === 'runtime-epoch-handoff-overflow');
    assert.equal(rollbackSettled, true);
    assert.equal(session.epoch, 1);
    assert.equal(backendEpoch, 1);
    assert.equal(session.closed, false);

    // Subsequent transition succeeds cleanly once rollback has settled.
    allowCleanEpoch2 = true;
    const nextEpoch = await session.newProviderEpoch();
    assert.equal(nextEpoch, 2);
    await session.close();
  }

  // 2. Async rollback rejects: concurrent newProviderEpoch() blocked while pending, session closes, then rejects with overflow.
  {
    let emit = null;
    let rejectRollback = null;
    let rollbackStarted = false;
    const backend = {
      id: 'inst-async-rb-fail',
      setEpoch(e) {
        if (e === 2) {
          for (let i = 0; i < 5; i++) emit({ kind: 'trace-marker', epoch: 2, timestamp: i });
          return Promise.resolve();
        }
        if (e === 1) {
          rollbackStarted = true;
          return new Promise((_, reject) => { rejectRollback = reject; });
        }
        return Promise.resolve();
      },
      onEvent(cb) { emit = cb; return () => {}; },
    };
    const provider = new InstrumentationProvider(backend, { events: { maxEvents: 3 } });
    const session = await provider.openSession({ binaryId: BINARY_ID, targetIdentity: 'proc:async2', sessionNonce: 'async:2' });

    let transitionSettled = false;
    const transitionPromise = session.newProviderEpoch().catch((err) => {
      transitionSettled = true;
      throw err;
    });

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(rollbackStarted, true);
    assert.equal(transitionSettled, false);
    assert.throws(
      () => session.newProviderEpoch(),
      (err) => err?.code === 'runtime-epoch-transition-active',
    );

    rejectRollback(new Error('async rollback failed'));
    await assert.rejects(transitionPromise, (err) => err?.code === 'runtime-epoch-handoff-overflow');
    assert.equal(session.closed, true);
  }
});

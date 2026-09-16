// Regression for #8692: provider mutation wrappers installed the session
// operation controller and captured the starting epoch too late. A
// pre-aborted request still reached the side-effecting backend call (and was
// only rejected afterwards, orphaning the mutation with no intervention
// record), and InstrumentationProvider.replace()/writeMemory() awaited
// mutation authorization before any operation token or epoch existed, so an
// epoch transition, close, or caller abort during authorization let the
// request execute and be recorded in the next generation. The repair unit is
// the single lifecycle/freshness authority established synchronously before
// the first await: pre-call throwIfStale checks, authorization bound to the
// captured session/epoch identity, and the retained completion-time check.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';
import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const isStale = (error) => error?.code === 'runtime-session-stale';

function debuggerFixture() {
  const calls = { register: [], memory: [] };
  const adapter = {
    id: 'mutation-8692-debug',
    kind: 'debugger',
    connected: false,
    epoch: 0,
    capabilities: { modules: false, writeRegisters: true, writeMemory: true },
    setEpoch(value) { this.epoch = value; },
    async connect() { this.connected = true; },
    async disconnect() { this.connected = false; },
    async writeRegister(name, value, threadId, options = {}) {
      calls.register.push({ name, value, signalAborted: options?.signal?.aborted });
      return { ok: true };
    },
    async writeMemory(address, bytes, options = {}) {
      calls.memory.push({ address, signalAborted: options?.signal?.aborted });
      return { ok: true };
    },
  };
  return { adapter, calls };
}

function instrumentationFixture({ authorizeMutation } = {}) {
  const calls = { probe: [], remove: [], intercept: [], replace: [], write: [], read: [] };
  const backend = {
    id: 'mutation-8692-inst',
    version: '1',
    async connect() {},
    async disconnect() {},
    async installProbe(spec, options = {}) {
      const handle = `probe-${calls.probe.length + 1}`;
      calls.probe.push({ spec, signalAborted: options?.signal?.aborted });
      return { handle };
    },
    async removeProbe(handle, options = {}) {
      calls.remove.push({ handle, signalAborted: options?.signal?.aborted });
      return { removed: true };
    },
    async intercept(spec, options = {}) {
      const handle = `intercept-${calls.intercept.length + 1}`;
      calls.intercept.push({ spec, signalAborted: options?.signal?.aborted });
      return { handle };
    },
    async replace(target, replacement, options = {}) {
      calls.replace.push({ target, signalAborted: options?.signal?.aborted });
      return { replaced: true };
    },
    async writeMemory(address, bytes, options = {}) {
      calls.write.push({ address, signalAborted: options?.signal?.aborted });
      return { written: bytes?.byteLength ?? 0 };
    },
    async readMemory(address, size, options = {}) {
      calls.read.push({ address, signalAborted: options?.signal?.aborted });
      return new Uint8Array(size);
    },
  };
  const provider = new InstrumentationProvider(backend, authorizeMutation ? { authorizeMutation } : {});
  return { backend, calls, provider };
}

const abortedSignal = (reason) => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

test('#8692 pre-aborted debugger writes never reach the adapter', async () => {
  const { adapter, calls } = debuggerFixture();
  const session = await new DebuggerProvider(adapter).openSession({ binaryId: 'bin-8692', sessionNonce: 'debug-pre-abort' });
  const facet = session.facets.debugger;

  await assert.rejects(
    facet.writeRegister('x0', 1n, { signal: abortedSignal('cancel-before-call') }),
    isStale,
  );
  assert.equal(calls.register.length, 0, 'an already-cancelled register write must not call the adapter');
  assert.equal(facet.interventions.all().length, 0);

  await assert.rejects(
    facet.writeMemory(0x1000n, new Uint8Array([1]), { signal: abortedSignal('cancel-before-call') }),
    isStale,
  );
  assert.equal(calls.memory.length, 0, 'an already-cancelled memory write must not call the adapter');
  assert.equal(facet.interventions.all().length, 0);
  assert.equal(session.controllers.size, 0, 'rejected operations must release their session controllers');

  // A normal current-epoch write still works after the rejected ones.
  const ok = await facet.writeRegister('x1', 2n);
  assert.deepEqual(ok.result, { ok: true });
  assert.equal(calls.register.length, 1);
  assert.equal(facet.interventions.all().length, 1);
  await session.close();
});

test('#8692 pre-aborted instrumentation probe/intercept operations never reach the backend', async () => {
  const { calls, provider } = instrumentationFixture();
  const session = await provider.openSession({ binaryId: 'bin-8692', sessionNonce: 'inst-pre-abort' }, { connect: false });
  const facet = session.facets.instrumentation;

  await assert.rejects(facet.installProbe({ address: 0x1000n }, { signal: abortedSignal('cancel') }), isStale);
  await assert.rejects(facet.intercept({ address: 0x2000n }, { signal: abortedSignal('cancel') }), isStale);
  await assert.rejects(facet.removeProbe('probe-1', { signal: abortedSignal('cancel') }), isStale);
  assert.equal(calls.probe.length, 0, 'no orphan probe installation for a cancelled request');
  assert.equal(calls.intercept.length, 0);
  assert.equal(calls.remove.length, 0, 'no untracked removal for a cancelled request');
  assert.equal(facet.interventions.all().length, 0);
  assert.equal(session.controllers.size, 0);

  // Success path still records the handle/intervention and removal works.
  const installed = await facet.installProbe({ address: 0x3000n });
  assert.equal(installed.intervention.kind, 'probe-install');
  assert.equal(calls.probe.length, 1);
  const removed = await facet.removeProbe('probe-1');
  assert.equal(removed.intervention.kind, 'probe-remove');
  assert.equal(calls.remove.length, 1);
  assert.equal(facet.interventions.all().length, 2);
  await session.close();
});

test('#8692 pre-aborted authorized replace/writeMemory fail before authorization and backend', async () => {
  let authorizeCalls = 0;
  const { calls, provider } = instrumentationFixture({
    authorizeMutation: async () => { authorizeCalls += 1; return true; },
  });
  const session = await provider.openSession({ binaryId: 'bin-8692', sessionNonce: 'inst-auth-pre-abort' }, { connect: false });
  const facet = session.facets.instrumentation;

  await assert.rejects(
    facet.writeMemory(0x2000n, new Uint8Array([0xaa]), { signal: abortedSignal('cancel-before-call') }),
    isStale,
  );
  await assert.rejects(
    facet.replace(0x1000n, { hook: true }, { signal: abortedSignal('cancel-before-call') }),
    isStale,
  );
  assert.equal(calls.write.length, 0, 'backend mutation must never be invoked after cancellation');
  assert.equal(calls.replace.length, 0);
  assert.equal(authorizeCalls, 0, 'the chosen policy fails pre-aborted requests before authorization');
  assert.equal(facet.interventions.all().length, 0);
  assert.equal(session.controllers.size, 0);
  await session.close();
});

test('#8692 caller abort while authorization is pending prevents backend invocation', async () => {
  const authGate = deferred();
  const { calls, provider } = instrumentationFixture({ authorizeMutation: () => authGate.promise });
  const session = await provider.openSession({ binaryId: 'bin-8692', sessionNonce: 'inst-abort-during-auth' }, { connect: false });
  const facet = session.facets.instrumentation;

  const caller = new AbortController();
  const pending = facet.writeMemory(0x2000n, new Uint8Array([0xaa]), {
    signal: caller.signal,
    authorizationContext: { ticket: 'generation-one-request' },
  });
  await Promise.resolve();
  caller.abort('caller-cancel-during-authorization');
  authGate.resolve(true);

  await assert.rejects(pending, isStale);
  assert.equal(calls.write.length, 0, 'cancellation while authorization is pending must prevent the backend call');
  assert.equal(facet.interventions.all().length, 0);
  assert.equal(session.controllers.size, 0);
  await session.close();
});

test('#8692 epoch transition while authorization is pending invalidates the old-generation request', async () => {
  const authGate = deferred();
  const observedAuth = [];
  const { calls, provider } = instrumentationFixture({
    authorizeMutation: async (request) => { observedAuth.push({ sessionEpoch: request.sessionEpoch, runtimeSessionId: request.runtimeSessionId }); return authGate.promise; },
  });
  const session = await provider.openSession({ binaryId: 'bin-8692', sessionNonce: 'inst-epoch-during-auth' }, { connect: false });
  const facet = session.facets.instrumentation;

  assert.equal(session.epoch, 1);
  const pending = facet.writeMemory(0x2000n, new Uint8Array([0xaa]), { authorizationContext: { ticket: 'old-generation' } });
  await Promise.resolve();
  session.newProviderEpoch('target-generation-changed');
  assert.equal(session.epoch, 2);
  authGate.resolve(true);

  await assert.rejects(pending, isStale);
  assert.equal(calls.write.length, 0, 'an authorization begun in epoch 1 must not execute in epoch 2');
  assert.equal(facet.interventions.all().length, 0);
  assert.deepEqual(observedAuth, [{ sessionEpoch: 1, runtimeSessionId: session.runtimeSessionId }],
    'authorization receives the canonical captured session/epoch identity');
  assert.equal(session.controllers.size, 0);
  await session.close();
});

test('#8692 session close while authorization is pending prevents backend invocation', async () => {
  const authGate = deferred();
  const { calls, provider } = instrumentationFixture({ authorizeMutation: () => authGate.promise });
  const session = await provider.openSession({ binaryId: 'bin-8692', sessionNonce: 'inst-close-during-auth' }, { connect: false });
  const facet = session.facets.instrumentation;

  const pending = facet.replace(0x1000n, { hook: true });
  await Promise.resolve();
  await session.close();
  authGate.resolve(true);

  await assert.rejects(pending, isStale);
  assert.equal(calls.replace.length, 0);
  assert.equal(facet.interventions.all().length, 0);
});

test('#8692 authorization denial and throw release the session controller', async () => {
  const { calls, provider } = instrumentationFixture({ authorizeMutation: async () => false });
  const session = await provider.openSession({ binaryId: 'bin-8692', sessionNonce: 'inst-deny' }, { connect: false });
  const facet = session.facets.instrumentation;

  await assert.rejects(
    facet.writeMemory(0x2000n, new Uint8Array([1])),
    (error) => error?.code === 'permission-denied',
  );
  assert.equal(calls.write.length, 0);
  assert.equal(session.controllers.size, 0, 'denied authorization must not leak an operation controller');

  const throwing = instrumentationFixture({ authorizeMutation: async () => { throw new Error('authority backend down'); } });
  const session2 = await throwing.provider.openSession({ binaryId: 'bin-8692', sessionNonce: 'inst-throw' }, { connect: false });
  await assert.rejects(
    session2.facets.instrumentation.writeMemory(0x2000n, new Uint8Array([1])),
    /authority backend down/,
  );
  assert.equal(throwing.calls.write.length, 0);
  assert.equal(session2.controllers.size, 0, 'a thrown authorization must not leak an operation controller');
  await session.close();
  await session2.close();
});

test('#8692 normal current-epoch authorized mutation succeeds, records once, and binds identity', async () => {
  const observed = [];
  const { calls, provider } = instrumentationFixture({
    authorizeMutation: async (request) => { observed.push(request); return true; },
  });
  const session = await provider.openSession({ binaryId: 'bin-8692', sessionNonce: 'inst-happy' }, { connect: false });
  const facet = session.facets.instrumentation;

  const result = await facet.writeMemory(0x3000n, new Uint8Array([9, 9]));
  assert.deepEqual(result.result, { written: 2 });
  assert.equal(calls.write.length, 1);
  assert.equal(calls.write[0].signalAborted, false);
  assert.equal(facet.interventions.all().length, 1, 'the fresh mutation records exactly one intervention');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].kind, 'memory-write');
  assert.equal(observed[0].sessionEpoch, 1);
  assert.equal(observed[0].runtimeSessionId, session.runtimeSessionId);
  assert.equal(session.controllers.size, 0, 'the successful operation releases its controller');
  await session.close();
});

test('#8692 mid-flight epoch change still fails closed for abort-ignoring backends (#5696 retained)', async () => {
  const { calls, provider } = instrumentationFixture();
  const session = await provider.openSession({ binaryId: 'bin-8692', sessionNonce: 'inst-midflight' }, { connect: false });
  const facet = session.facets.instrumentation;

  const gate = deferred();
  provider.backend.installProbe = async (spec, options = {}) => {
    calls.probe.push({ spec, signalAborted: options?.signal?.aborted });
    return gate.promise;
  };

  const pending = facet.installProbe({ address: 0x4000n });
  assert.equal(calls.probe.length, 1, 'the fresh request reaches the backend exactly once');
  assert.equal(calls.probe[0].signalAborted, false);
  session.newProviderEpoch('midflight-switch');
  gate.resolve({ handle: 'probe-1' }); // the backend ignores cancellation and completes anyway
  await assert.rejects(pending, isStale, 'the completion-time check must still reject stale late completions');
  assert.equal(facet.interventions.all().length, 0);
  await session.close();
});

test('#8692 readMemory honors pre-abort without changing normal behavior', async () => {
  const { calls, provider } = instrumentationFixture();
  const session = await provider.openSession({ binaryId: 'bin-8692', sessionNonce: 'inst-read' }, { connect: false });
  const facet = session.facets.instrumentation;

  await assert.rejects(
    facet.readMemory(0x1000n, 4, { signal: abortedSignal('cancel') }),
    isStale,
  );
  assert.equal(calls.read.length, 0, 'a cancelled read must not reach the backend either');
  const bytes = await facet.readMemory(0x1000n, 4);
  assert.equal(bytes.length, 4);
  assert.equal(calls.read.length, 1);
  await session.close();
});

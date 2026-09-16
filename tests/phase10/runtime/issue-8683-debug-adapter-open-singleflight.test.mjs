// Regression for #8683: DebugAdapterRuntimeProvider.openSession() claimed
// `activeSession` only after awaiting `adapter.connect()`, so two concurrent
// opens both passed the `adapter-in-use` guard, both mutated the shared
// adapter epoch, both connected, and the last writer owned the provider. The
// untracked orphan session still believed it owned the connection, so closing
// it disconnected the tracked/current session's transport while the platform
// kept presenting that session as ready. The claim is now reserved
// synchronously before the first epoch/connect mutation, and the close
// closure only touches the shared transport while the session still holds
// ownership.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugAdapterRuntimeProvider } from '../../../js/runtime/provider.js';
import { RuntimeProviderPlatform } from '../../../js/runtime/provider-platform.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function mockAdapter({ id = 'mock-8683', modules = false, gated = true } = {}) {
  const gates = [];
  const adapter = {
    id,
    kind: 'debugger',
    capabilities: { modules },
    connected: false,
    epoch: 0,
    connectCalls: 0,
    disconnectCalls: 0,
    setEpochCalls: 0,
    subscribeCalls: 0,
    unsubscribeCalls: 0,
    setEpoch(value) { this.epoch = value; this.setEpochCalls += 1; },
    async connect() {
      this.connectCalls += 1;
      if (!gated) {
        this.connected = true;
        return;
      }
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      this.connected = true;
    },
    async disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
    },
    onEvent() {
      this.subscribeCalls += 1;
      return () => { this.unsubscribeCalls += 1; };
    },
  };
  return {
    adapter,
    gates,
    release: (index = 0) => gates[index].resolve(),
    rejectGate: (index, error) => gates[index].reject(error),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const req = (nonce) => ({ binaryId: 'binary-8683', processKey: 'proc-8683', sessionNonce: nonce });

test('#8683 concurrent openSession claims ownership before the first await', async () => {
  const { adapter, release } = mockAdapter();
  const provider = new DebugAdapterRuntimeProvider(adapter, { id: 'adapter:mock-8683' });

  const first = provider.openSession(req('s1'));
  await tick();
  assert.equal(adapter.connectCalls, 1, 'the first open must start exactly one connect');
  assert.equal(adapter.epoch, 1, 'the opening session owns the adapter epoch');
  assert.equal(provider.activeSession?.state, 'opening', 'the reservation is visible before connect resolves');

  await assert.rejects(
    provider.openSession(req('s2')),
    (error) => error?.code === 'adapter-in-use',
    'the second concurrent open must fail closed on adapter-in-use',
  );
  assert.equal(adapter.connectCalls, 1, 'the rejected open must never reach adapter.connect()');
  assert.equal(adapter.setEpochCalls, 1, 'the rejected open must not mutate the shared adapter epoch');
  assert.equal(adapter.epoch, 1, 'the rejected open must not advance the adapter epoch');
  assert.equal(provider.sessionEpoch, 1, 'the rejected open must not advance the provider session epoch');

  release();
  const session = await first;
  assert.equal(session.state, 'ready');
  assert.equal(provider.activeSession, session, 'only one live session may exist');

  await session.close();
  assert.equal(adapter.disconnectCalls, 1, 'the sole admitted session disconnects exactly once');
  assert.equal(adapter.connected, false);
  assert.equal(provider.activeSession, null);
});

test('#8683 rejected concurrent open leaves platform state consistent end to end', async () => {
  const { adapter, release } = mockAdapter();
  const platform = new RuntimeProviderPlatform();
  platform.registerDebugAdapter(adapter, { id: 'adapter:mock-8683' });
  const provider = platform.provider('adapter:mock-8683');

  const first = platform.openSession('adapter:mock-8683', req('s1'));
  const secondRejected = assert.rejects(
    platform.openSession('adapter:mock-8683', req('s2')),
    (error) => error?.code === 'adapter-in-use',
    'the second concurrent platform open must fail closed before a second connect',
  );
  await secondRejected;
  await tick();
  assert.equal(adapter.connectCalls, 1, 'no second connect through the platform path');
  assert.equal(adapter.epoch, 1, 'the rejected open does not advance the epoch through the platform path');

  release();
  const session = await first;
  assert.equal(session.state, 'ready');
  assert.equal(platform.sessions.size, 1, 'the platform records only the admitted session');
  assert.equal(platform.current, session);
  assert.equal(provider.activeSession, session);
  assert.equal(adapter.subscribeCalls, 1, 'event subscription occurs only for the admitted session');
  assert.equal(adapter.connected, true);

  await session.close();
  assert.equal(platform.sessions.size, 0);
  assert.equal(platform.current, null);
  assert.equal(provider.activeSession, null);
  assert.equal(adapter.connected, false);
  assert.equal(adapter.disconnectCalls, 1);
  assert.equal(adapter.unsubscribeCalls, 1);
});

test('#8683 failed connect releases the reservation for a later fresh open', async () => {
  const { adapter, release, rejectGate } = mockAdapter({ id: 'mock-8683-fail' });
  const provider = new DebugAdapterRuntimeProvider(adapter, { id: 'adapter:mock-8683-fail' });

  const first = provider.openSession(req('failed'));
  await tick();
  rejectGate(0, new Error('connect rejected'));
  await assert.rejects(first, /connect rejected/);
  assert.equal(provider.activeSession, null, 'the failed open must release the reservation');

  const retry = provider.openSession(req('retry'));
  await tick();
  assert.equal(adapter.connectCalls, 2, 'a fresh open after the failure is admitted');
  assert.equal(adapter.epoch, 2, 'the retry advances the session epoch exactly once');
  release(1);
  const session = await retry;
  assert.equal(session.state, 'ready');
  await session.close();
  assert.equal(adapter.disconnectCalls, 2, 'cleanup disconnect for the failed attempt plus the admitted close');
  assert.equal(adapter.connected, false);
  assert.equal(provider.activeSession, null);
});

test('#8683 a stale session close cannot disconnect a successor session', async () => {
  const { adapter } = mockAdapter({ id: 'mock-8683-stale', gated: false });
  const provider = new DebugAdapterRuntimeProvider(adapter, { id: 'adapter:mock-8683-stale' });
  const orphan = await provider.openSession(req('orphan'));
  assert.equal(orphan.state, 'ready');

  // Replay the exact pre-fix corruption state: the last-writer-wins race left
  // an unclosed orphan while a successor owned the provider. The orphan must
  // no longer be able to tear down the successor's shared transport.
  provider.activeSession = null;
  const successor = await provider.openSession(req('successor'));
  assert.equal(successor.state, 'ready');
  assert.equal(adapter.connected, true);

  await orphan.close();
  assert.equal(adapter.disconnectCalls, 0, 'a session without ownership must never call adapter.disconnect()');
  assert.equal(adapter.connected, true, 'the stale orphan close must not disconnect the successor transport');
  assert.equal(successor.closed, false);
  assert.equal(successor.state, 'ready');
  assert.equal(provider.activeSession, successor);

  await successor.close();
  assert.equal(adapter.disconnectCalls, 0, 'neither the stale orphan nor the successor that never claimed the connection disconnects it');
  assert.equal(adapter.connected, true);
  assert.equal(provider.activeSession, null);
  assert.equal(successor.closed, true);
});

test('#8683 connect:false honors the same single-session reservation', async () => {
  const { adapter } = mockAdapter({ id: 'mock-8683-deferred', gated: false });
  const provider = new DebugAdapterRuntimeProvider(adapter, { id: 'adapter:mock-8683-deferred' });
  const session = await provider.openSession(req('deferred'), { connect: false });

  assert.equal(session.state, 'ready');
  assert.equal(session.capabilityState, 'unnegotiated');
  assert.equal(session.negotiated, false);
  assert.deepEqual(session.facets, {}, 'a deferred session must not publish negotiated facets');
  assert.equal(adapter.connectCalls, 0);

  await assert.rejects(
    provider.openSession(req('second')),
    (error) => error?.code === 'adapter-in-use',
    'the deferred session must reserve the single live session against any later open',
  );
  assert.equal(adapter.connectCalls, 0);

  await session.close();
  assert.equal(adapter.disconnectCalls, 0, 'a deferred session never claimed the connection and must not disconnect');
  assert.equal(provider.activeSession, null);

  const reopened = await provider.openSession(req('reopened'));
  assert.equal(reopened.state, 'ready');
  assert.equal(reopened.capabilityState, 'negotiated');
  assert.equal(adapter.connectCalls, 1);
  await reopened.close();
  assert.equal(adapter.disconnectCalls, 1);
});

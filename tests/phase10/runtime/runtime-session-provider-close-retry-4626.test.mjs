import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugSession, DebugSessionManager } from '../../../js/runtime/session.js';
import { RuntimeProviderSession, wrapDebugAdapterAsRuntimeProvider } from '../../../js/runtime/provider.js';

class FlakyDisconnectAdapter {
  constructor({ failures = 0 } = {}) {
    this.kind = 'flaky';
    this.capabilities = { connect: true, disconnect: true, threads: false, modules: false };
    this.connected = false;
    this.disconnectAttempts = 0;
    this.failures = failures;
    this.epoch = 1;
  }
  async connect() { this.connected = true; return { ok: true }; }
  async disconnect() {
    this.disconnectAttempts++;
    if (this.disconnectAttempts <= this.failures) throw new Error('transient adapter disconnect failure');
    this.connected = false;
    return { ok: true };
  }
}

test('P10 DebugSession.disconnect commits closed only after adapter disconnect succeeds (#4626)', async () => {
  const adapter = new FlakyDisconnectAdapter({ failures: 1 });
  const observed = [];
  const session = new DebugSession(adapter, {
    binaryHash: 'bin-4626',
    onClosed: (closed) => observed.push(closed),
  });
  await session.connect();

  await assert.rejects(session.disconnect(), /transient adapter disconnect failure/);
  assert.equal(adapter.disconnectAttempts, 1);
  assert.equal(session.closed, false, 'failed disconnect must remain retryable');
  assert.equal(observed.length, 0, 'failed disconnect must not fire onClosed');

  await session.disconnect();
  assert.equal(adapter.disconnectAttempts, 2);
  assert.equal(session.closed, true);
  assert.equal(observed.length, 1);
  assert.equal(adapter.connected, false);
  assert.equal(await session.disconnect(), undefined, 'successful disconnect remains idempotent');
  assert.equal(adapter.disconnectAttempts, 2);
});

test('P10 DebugSession.disconnect single-flights concurrent disconnects (#4626)', async () => {
  const adapter = new FlakyDisconnectAdapter();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = adapter.disconnect.bind(adapter);
  let entered = 0;
  adapter.disconnect = async () => { entered++; await gate; return original(); };

  const session = new DebugSession(adapter, { binaryHash: 'bin-4626' });
  await session.connect();

  const first = session.disconnect();
  const second = session.disconnect();
  await Promise.resolve();
  assert.equal(entered, 1, 'backend disconnect must run once while a disconnect is in flight');
  release();
  await Promise.all([first, second]);
  assert.equal(entered, 1);
  assert.equal(adapter.disconnectAttempts, 1);
  assert.equal(session.closed, true);
});

test('P10 DebugSessionManager.close retains failed sessions until disconnect succeeds (#4626)', async () => {
  const manager = new DebugSessionManager();
  const adapter = new FlakyDisconnectAdapter({ failures: 1 });
  const session = manager.create(adapter, { binaryHash: 'bin-4626' });
  await session.connect();
  assert.equal(manager.get(session.id), session);
  assert.equal(manager.current, session);

  await assert.rejects(manager.close(session.id), /transient adapter disconnect failure/);
  assert.equal(manager.get(session.id), session, 'failed close must keep the manager handle for retry');
  assert.equal(manager.current, session);

  assert.equal(await manager.close(session.id), true);
  assert.equal(adapter.disconnectAttempts, 2);
  assert.equal(manager.get(session.id), null);
  assert.equal(manager.current, null);
});

test('P10 RuntimeProviderSession.close commits closed only after _close succeeds (#4626)', async () => {
  let attempts = 0;
  const session = new RuntimeProviderSession({
    provider: { descriptor: () => ({ id: 'close-retry', version: '1', kind: 'test', facets: [] }) },
    request: { binaryId: 'binary-4626', sessionNonce: 'n1' },
    close: async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient runtime close failure');
    },
  });
  session.setState('ready');

  await assert.rejects(session.close(), /transient runtime close failure/);
  assert.equal(attempts, 1);
  assert.equal(session.closed, false, 'failed close must keep the session retryable');
  assert.equal(session.state, 'closing');

  await session.close();
  assert.equal(attempts, 2);
  assert.equal(session.closed, true);
  assert.equal(session.state, 'closed');
  await session.close();
  assert.equal(attempts, 2, 'successful close remains idempotent');
});

test('P10 compat provider retains activeSession when adapter disconnect fails (#4626)', async () => {
  const adapter = new FlakyDisconnectAdapter();
  const provider = wrapDebugAdapterAsRuntimeProvider(adapter, { id: 'compat-4626' });
  const session = await provider.openSession({ binaryId: 'binary-4626', sessionNonce: 'n1' });
  assert.equal(adapter.connected, true);

  adapter.failures = 1;
  await assert.rejects(session.close(), /transient adapter disconnect failure/);
  assert.equal(session.closed, false, 'failed compat close must keep the session retryable');
  assert.equal(provider.activeSession, session, 'failed compat close must retain activeSession for retry');

  await session.close();
  assert.equal(adapter.disconnectAttempts, 2);
  assert.equal(session.closed, true);
  assert.equal(provider.activeSession, null);
});

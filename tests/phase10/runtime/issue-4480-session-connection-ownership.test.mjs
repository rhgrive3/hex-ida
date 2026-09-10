import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';
import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';
import { DebugAdapterRuntimeProvider } from '../../../js/runtime/provider.js';

function debugAdapter({ connected = false, failConnect = false } = {}) {
  return {
    id: 'debug-4480',
    kind: 'generic',
    capabilities: { modules: false },
    connected,
    connectCalls: 0,
    disconnectCalls: 0,
    async connect() {
      this.connectCalls += 1;
      this.connected = true;
      if (failConnect) throw new Error('connect failed');
    },
    async disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
    },
  };
}

test('#4480 DebugAdapterRuntimeProvider does not disconnect a borrowed connection', async () => {
  const adapter = debugAdapter({ connected: true });
  const provider = new DebugAdapterRuntimeProvider(adapter);
  const session = await provider.openSession({ binaryId: 'binary-4480' }, { connect: false });

  await session.close();
  assert.equal(adapter.connectCalls, 0);
  assert.equal(adapter.disconnectCalls, 0);
  assert.equal(adapter.connected, true);
  assert.equal(provider.activeSession, null);
});

test('#4480 DebugAdapterRuntimeProvider disconnects only a connection it opened', async () => {
  const adapter = debugAdapter();
  const provider = new DebugAdapterRuntimeProvider(adapter);
  const session = await provider.openSession({ binaryId: 'binary-4480-owned' });

  await session.close();
  assert.equal(adapter.connectCalls, 1);
  assert.equal(adapter.disconnectCalls, 1);
  assert.equal(adapter.connected, false);
});

test('#4480 failed provider-owned connect still receives cleanup', async () => {
  const adapter = debugAdapter({ failConnect: true });
  const provider = new DebugAdapterRuntimeProvider(adapter);

  await assert.rejects(
    provider.openSession({ binaryId: 'binary-4480-failed' }),
    /connect failed/,
  );
  assert.equal(adapter.disconnectCalls, 1);
  assert.equal(provider.activeSession, null);
});

test('#4480 InstrumentationProvider does not disconnect a borrowed backend', async () => {
  let connectCalls = 0;
  let disconnectCalls = 0;
  const backend = {
    id: 'instrumentation-4480',
    async connect() { connectCalls += 1; },
    async disconnect() { disconnectCalls += 1; },
  };
  const provider = new InstrumentationProvider(backend);
  const session = await provider.openSession({ binaryId: 'binary-4480' }, { connect: false });

  await session.close();
  assert.equal(connectCalls, 0);
  assert.equal(disconnectCalls, 0);
  assert.equal(provider.activeSession, null);
});

test('#4480 EmulatorProvider does not disconnect a borrowed engine', async () => {
  let connectCalls = 0;
  let disconnectCalls = 0;
  const engine = {
    async execute() { return { termination: 'return' }; },
    async connect() { connectCalls += 1; },
    async disconnect() { disconnectCalls += 1; },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'binary-4480' }, { connect: false });

  await session.close();
  assert.equal(connectCalls, 0);
  assert.equal(disconnectCalls, 0);
  assert.equal(provider.activeSession, null);
});

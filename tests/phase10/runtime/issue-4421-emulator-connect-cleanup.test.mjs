import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

function baseEngine(overrides = {}) {
  return {
    id: 'issue-4421-engine',
    async execute() { return { termination: 'return' }; },
    async connect() {},
    async disconnect() {},
    ...overrides,
  };
}

test('#4421 successful connect still returns a ready session and disconnects on close', async () => {
  let connectCalls = 0;
  let disconnectCalls = 0;
  const engine = baseEngine({
    async connect() { connectCalls++; },
    async disconnect() { disconnectCalls++; },
  });
  const provider = new EmulatorProvider(engine);

  const session = await provider.openSession({ binaryId: 'binary-4421', sessionNonce: 'success' });
  assert.equal(session.state, 'ready');
  await session.close();
  assert.equal(connectCalls, 1);
  assert.equal(disconnectCalls, 1);
  assert.equal(provider.activeSession, null);
});

test('#4421 sync connect throw disconnects and preserves the connect error', async () => {
  const connectError = new Error('sync handshake failed');
  let disconnectCalls = 0;
  const engine = baseEngine({
    connect() { throw connectError; },
    async disconnect() { disconnectCalls++; },
  });
  const provider = new EmulatorProvider(engine);

  await assert.rejects(
    provider.openSession({ binaryId: 'binary-4421', sessionNonce: 'sync-failure' }),
    (error) => error === connectError,
  );
  assert.equal(disconnectCalls, 1);
  assert.equal(provider.activeSession, null);
});

test('#4421 async connect rejection disconnects and preserves the connect error', async () => {
  const connectError = new Error('async handshake failed');
  let disconnectCalls = 0;
  const engine = baseEngine({
    async connect() { throw connectError; },
    async disconnect() { disconnectCalls++; },
  });
  const provider = new EmulatorProvider(engine);

  await assert.rejects(
    provider.openSession({ binaryId: 'binary-4421', sessionNonce: 'async-failure' }),
    (error) => error === connectError,
  );
  assert.equal(disconnectCalls, 1);
  assert.equal(provider.activeSession, null);
});

test('#4421 a partially connected engine is released after connect fails', async () => {
  let connected = false;
  let disconnectCalls = 0;
  const engine = baseEngine({
    async connect() {
      connected = true;
      throw new Error('resource handshake failed');
    },
    async disconnect() {
      disconnectCalls++;
      connected = false;
    },
  });
  const provider = new EmulatorProvider(engine);

  await assert.rejects(provider.openSession({ binaryId: 'binary-4421', sessionNonce: 'partial' }), /resource handshake failed/);
  assert.equal(disconnectCalls, 1);
  assert.equal(connected, false);
  assert.equal(provider.activeSession, null);
});

test('#4421 disconnect failure does not replace the connect error or retain provider ownership', async () => {
  const connectError = new Error('original connect error');
  const disconnectError = new Error('disconnect failed');
  let disconnectFail = true;
  let connectCalls = 0;
  let disconnectCalls = 0;
  const engine = baseEngine({
    async connect() {
      connectCalls++;
      if (connectCalls === 1) throw connectError;
    },
    async disconnect() {
      disconnectCalls++;
      if (disconnectFail) throw disconnectError;
    },
  });
  const provider = new EmulatorProvider(engine);

  await assert.rejects(
    provider.openSession({ binaryId: 'binary-4421', sessionNonce: 'disconnect-failure' }),
    (error) => error === connectError,
  );
  assert.equal(disconnectCalls, 1);
  assert.equal(provider.activeSession, null);

  disconnectFail = false;
  const retry = await provider.openSession({ binaryId: 'binary-4421', sessionNonce: 'retry' });
  assert.equal(retry.state, 'ready');
  await retry.close();
  assert.equal(disconnectCalls, 2);
});

test('#4421 connect:false does not claim or disconnect an engine connection', async () => {
  let connectCalls = 0;
  let disconnectCalls = 0;
  const engine = baseEngine({
    async connect() { connectCalls++; },
    async disconnect() { disconnectCalls++; },
  });
  const provider = new EmulatorProvider(engine);

  const session = await provider.openSession({ binaryId: 'binary-4421', sessionNonce: 'borrowed' }, { connect: false });
  await session.close();
  assert.equal(connectCalls, 0);
  assert.equal(disconnectCalls, 0);
  assert.equal(provider.activeSession, null);
});

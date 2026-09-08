import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';
import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve=res; reject=rej; });
  return { promise, resolve, reject };
}

test('P10 InstrumentationProvider claims activeSession before async open work (#4716)', async () => {
  const gate=deferred();
  let connectCalls=0;
  let subscribeCalls=0;
  let unsubscribeCalls=0;
  let moduleCalls=0;
  const backend={
    id:'instrumentation-open-4716',
    async connect() { connectCalls++; await gate.promise; },
    onEvent() { subscribeCalls++; return () => { unsubscribeCalls++; }; },
    async getModules() { moduleCalls++; return []; },
    async disconnect() {},
  };
  const provider=new InstrumentationProvider(backend);

  const first=provider.openSession({ binaryId:'bin-4716', sessionNonce:'first' });
  await Promise.resolve();
  assert.equal(connectCalls,1);
  assert.equal(provider.activeSession?.state,'opening');
  await assert.rejects(
    provider.openSession({ binaryId:'bin-4716', sessionNonce:'second' }),
    (error) => error?.code==='runtime-session-active',
  );

  gate.resolve();
  const session=await first;
  assert.equal(session.state,'ready');
  assert.equal(connectCalls,1);
  assert.equal(subscribeCalls,1);
  assert.equal(moduleCalls,1);
  await session.close();
  assert.equal(unsubscribeCalls,1);
  assert.equal(provider.activeSession,null);
});

test('P10 EmulatorProvider claims activeSession before async open work (#4716)', async () => {
  const gate=deferred();
  let connectCalls=0;
  let disconnectCalls=0;
  const engine={
    id:'emulator-open-4716',
    async connect() { connectCalls++; await gate.promise; },
    async disconnect() { disconnectCalls++; },
    async execute() { return { termination:'return' }; },
  };
  const provider=new EmulatorProvider(engine);

  const first=provider.openSession({ binaryId:'bin-4716', sessionNonce:'first' });
  await Promise.resolve();
  assert.equal(connectCalls,1);
  assert.equal(provider.activeSession?.state,'opening');
  await assert.rejects(
    provider.openSession({ binaryId:'bin-4716', sessionNonce:'second' }),
    (error) => error?.code==='runtime-session-active',
  );

  gate.resolve();
  const session=await first;
  assert.equal(session.state,'ready');
  assert.equal(connectCalls,1);
  await session.close();
  assert.equal(disconnectCalls,1);
  assert.equal(provider.activeSession,null);
});

test('P10 provider open failure releases ownership for a later open (#4716)', async () => {
  let fail=true;
  let disconnectCalls=0;
  const backend={
    id:'instrumentation-retry-open-4716',
    async connect() { if (fail) throw new Error('connect failed once'); },
    async disconnect() { disconnectCalls++; },
  };
  const provider=new InstrumentationProvider(backend);

  await assert.rejects(
    provider.openSession({ binaryId:'bin-4716', sessionNonce:'failed' }),
    /connect failed once/,
  );
  assert.equal(provider.activeSession,null);
  assert.equal(disconnectCalls,1);

  fail=false;
  const session=await provider.openSession({ binaryId:'bin-4716', sessionNonce:'retry' });
  assert.equal(session.state,'ready');
  await session.close();
  assert.equal(provider.activeSession,null);
});

test('P10 EmulatorProvider open failure releases ownership for a later open (#4716)', async () => {
  let fail=true;
  let disconnectCalls=0;
  const engine={
    id:'emulator-retry-open-4716',
    async connect() { if (fail) throw new Error('connect failed once'); },
    async disconnect() { disconnectCalls++; },
    async execute() { return { termination:'return' }; },
  };
  const provider=new EmulatorProvider(engine);

  await assert.rejects(
    provider.openSession({ binaryId:'bin-4716', sessionNonce:'failed' }),
    /connect failed once/,
  );
  assert.equal(provider.activeSession,null);
  assert.equal(disconnectCalls,1);

  fail=false;
  const session=await provider.openSession({ binaryId:'bin-4716', sessionNonce:'retry' });
  assert.equal(session.state,'ready');
  await session.close();
  assert.equal(provider.activeSession,null);
});

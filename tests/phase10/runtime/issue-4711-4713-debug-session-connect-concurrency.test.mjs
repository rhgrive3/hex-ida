import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugSession } from '../../../js/runtime/session.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve=res; reject=rej; });
  return { promise, resolve, reject };
}

function adapterFixture(overrides = {}) {
  const listeners = new Set();
  const adapter = {
    id:'connect-concurrency-fixture',
    kind:'fixture',
    capabilities:{ modules:false, threads:false },
    connected:false,
    connectCalls:0,
    disconnectCalls:0,
    subscribeCalls:0,
    unsubscribeCalls:0,
    async connect() { this.connectCalls++; this.connected=true; return { ok:true }; },
    onEvent(listener) {
      this.subscribeCalls++;
      listeners.add(listener);
      return () => { this.unsubscribeCalls++; listeners.delete(listener); };
    },
    async disconnect() { this.disconnectCalls++; this.connected=false; },
    ...overrides,
  };
  return adapter;
}

test('P10 DebugSession coalesces concurrent connect calls and releases one subscription (#4713)', async () => {
  const gate=deferred();
  const adapter=adapterFixture({
    async connect() { this.connectCalls++; await gate.promise; this.connected=true; return { ok:true }; },
  });
  const session=new DebugSession(adapter,{ id:'connect-coalesce-4713' });

  const first=session.connect({ caller:'first' });
  const second=session.connect({ caller:'second' });
  await Promise.resolve();
  assert.equal(adapter.connectCalls,1);

  gate.resolve();
  const results=await Promise.all([first,second]);
  assert.deepEqual(results,[{ ok:true },{ ok:true }]);
  assert.equal(adapter.subscribeCalls,1);
  assert.equal(session.connected,true);

  await session.disconnect();
  assert.equal(adapter.disconnectCalls,1);
  assert.equal(adapter.unsubscribeCalls,1);
});

test('P10 DebugSession rejects and cleans a connect invalidated by disconnect (#4711)', async () => {
  const gate=deferred();
  const adapter=adapterFixture({
    async connect() { this.connectCalls++; await gate.promise; this.connected=true; return { ok:true }; },
  });
  const session=new DebugSession(adapter,{ id:'connect-stale-4711' });

  const connecting=session.connect();
  await Promise.resolve();
  await session.disconnect();
  assert.equal(session.closed,true);
  assert.equal(session.connected,false);

  gate.resolve();
  await assert.rejects(connecting,(error) => error?.code==='stale-session-connect');
  assert.equal(adapter.subscribeCalls,0,'stale connect must not create an event subscription');
  assert.equal(adapter.unsubscribeCalls,0);
  assert.equal(adapter.disconnectCalls,2,'stale adapter connection receives best-effort cleanup');
  assert.equal(adapter.connected,false);
  assert.equal(session.connected,false);
});

test('P10 DebugSession clears in-flight connect after failure so retry remains possible (#4713)', async () => {
  let fail=true;
  const adapter=adapterFixture({
    async connect() {
      this.connectCalls++;
      if (fail) { fail=false; throw new Error('connect failed once'); }
      this.connected=true;
      return { ok:true };
    },
  });
  const session=new DebugSession(adapter,{ id:'connect-retry-4713' });

  await assert.rejects(session.connect(),/connect failed once/);
  assert.equal(session.connected,false);
  assert.deepEqual(await session.connect(),{ ok:true });
  assert.equal(adapter.connectCalls,2);
  assert.equal(adapter.subscribeCalls,1);
  await session.disconnect();
  assert.equal(adapter.unsubscribeCalls,1);
});

test('P10 DebugSession rejects a connect invalidated while its refresh is pending (#4711)', async () => {
  const modulesGate=deferred();
  const modulesStarted=deferred();
  const disconnectGate=deferred();
  const disconnectStarted=deferred();
  const adapter=adapterFixture({
    capabilities:{ modules:true, threads:false },
    async getModules() {
      modulesStarted.resolve();
      await modulesGate.promise;
      return [{ id:'stale-module' }];
    },
    async disconnect() {
      this.disconnectCalls++;
      disconnectStarted.resolve();
      await disconnectGate.promise;
      this.connected=false;
    },
  });
  const session=new DebugSession(adapter,{ id:'connect-refresh-stale-4711' });
  session.modules=[{ id:'before-connect' }];

  const connecting=session.connect();
  await modulesStarted.promise;
  assert.equal(adapter.subscribeCalls,1,'connect must reach the refresh after publishing one subscription');

  const disconnecting=session.disconnect();
  await disconnectStarted.promise;
  modulesGate.resolve();

  await assert.rejects(connecting,(error) => error?.code==='stale-session-connect');
  assert.deepEqual(session.modules,[{ id:'before-connect' }],'generation-invalidated refresh must not publish stale modules');
  assert.equal(adapter.disconnectCalls,1,'connect must not race the in-flight disconnect with a second cleanup disconnect');
  assert.equal(session.closed,false,'disconnect remains pending until its adapter operation completes');

  disconnectGate.resolve();
  await disconnecting;
  assert.equal(session.closed,true);
  assert.equal(session.connected,false);
  assert.equal(adapter.unsubscribeCalls,1,'final disconnect must release the connect-owned subscription exactly once');
});

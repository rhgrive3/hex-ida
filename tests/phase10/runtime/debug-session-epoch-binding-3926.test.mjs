import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeAnalysisPlatform } from '../../../js/runtime/index.js';
import { DebugSession } from '../../../js/runtime/session.js';

function adapterFixture() {
  let listener = null;
  const epochs = [];
  return {
    id:'epoch-fixture',
    kind:'fixture',
    capabilities:{ modules:false, threads:false },
    connected:false,
    epochs,
    setEpoch(epoch) { epochs.push(epoch); },
    async connect() { this.connected=true; return { adapter:this.id, capabilities:this.capabilities }; },
    onEvent(callback) { listener=callback; return () => { listener=null; }; },
    emit(event) { return listener?.(event); },
    async disconnect() { this.connected=false; },
  };
}

function traceAdapterFixture(trace) {
  return {
    id:'trace-epoch-fixture',
    kind:'fixture',
    capabilities:{ modules:false, threads:false, launch:false, attach:false, resume:false, traceFunction:true, replay:false },
    async trace(options) { return trace(options); },
    async disconnect() {},
  };
}

test('P10 DebugSession rejects unbound and stale epoch events (#3926)', () => {
  const adapter = adapterFixture();
  const session = new DebugSession(adapter,{ id:'epoch-direct' });

  assert.equal(session.acceptEvent({ type:'branch', epoch:1, pc:'0x1000' }), true);
  assert.equal(session.acceptEvent({ type:'branch', pc:'0x1001' }), false);
  assert.equal(session.acceptEvent({ type:'branch', pc:'0x1002' }, 1), true);
  assert.equal(session.traces.snapshot().events.length,2);

  assert.equal(session.newEpoch(),2);
  assert.equal(session.traces.snapshot().events.length,0);
  assert.equal(session.acceptEvent({ type:'branch', epoch:1, pc:'0x2000' }), false);
  assert.equal(session.acceptEvent({ type:'branch', pc:'0x2001' }, 1), false);
  assert.equal(session.acceptEvent({ type:'branch', epoch:2, pc:'0x2002' }), true);
  assert.equal(session.acceptEvent({ type:'branch', pc:'0x2003' }, 2), true);
  assert.deepEqual(session.traces.snapshot().events.map((event)=>event.pc),['0x2002','0x2003']);
});

test('P10 DebugSession binds untagged adapter callbacks to subscription epoch (#3926)', async () => {
  const adapter = adapterFixture();
  const session = new DebugSession(adapter,{ id:'epoch-subscription' });

  await session.connect();
  assert.deepEqual(adapter.epochs,[1]);
  assert.equal(adapter.emit({ type:'call', pc:'0x3000' }), true);
  assert.equal(session.traces.snapshot().events.length,1);

  assert.equal(session.newEpoch(),2);
  assert.deepEqual(adapter.epochs,[1,2]);
  assert.equal(session.traces.snapshot().events.length,0);

  // The callback was registered under epoch 1. Missing identity must not be rebound to epoch 2.
  assert.equal(adapter.emit({ type:'call', pc:'0x3001' }), false);
  assert.equal(session.traces.snapshot().events.length,0);

  // A producer-supplied current epoch remains authoritative even on a long-lived subscription.
  assert.equal(adapter.emit({ type:'call', epoch:2, pc:'0x3002' }), true);
  assert.deepEqual(session.traces.snapshot().events.map((event)=>event.pc),['0x3002']);

  await session.disconnect();
});

test('P10 traceFunction accepts same-epoch untagged trace ingress (#3926)', async () => {
  const adapter = traceAdapterFixture(async () => ({ events:[{ type:'branch', address:'0x4000', next:'0x4004' }] }));
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  const session = await platform.startSession({ adapter, connect:false });

  const result = await platform.traceFunction(0x4000);

  assert.deepEqual(session.traces.snapshot().events.map((event)=>event.address),['0x4000']);
  assert.equal(result.evidence.length,1);
  assert.equal(platform.evidence.length,1);
});

test('P10 traceFunction rejects untagged trace from a pre-cutover operation (#3926)', async () => {
  let releaseTrace;
  let markTraceStarted;
  const traceStarted = new Promise((resolve) => { markTraceStarted=resolve; });
  const traceReady = new Promise((resolve) => { releaseTrace=resolve; });
  const adapter = traceAdapterFixture(async () => {
    markTraceStarted();
    await traceReady;
    return { events:[{ type:'branch', address:'0x5000', next:'0x5004' }] };
  });
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  const session = await platform.startSession({ adapter, connect:false });

  const pending = platform.traceFunction(0x5000);
  await traceStarted;
  assert.equal(session.newEpoch(),2);
  releaseTrace();
  await assert.rejects(pending, (error) => {
    assert.equal(error?.code,'session-epoch-changed');
    return true;
  });

  assert.equal(session.traces.snapshot().events.length,0);
  assert.equal(platform.evidence.length,0);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { resetAppRuntime, runtimePlatformForApp, traceAppFunction } from '../../../js/runtime/app-runtime.js';
import { RuntimeAnalysisPlatform } from '../../../js/runtime/index.js';
import { createRuntimeAgentTools } from '../../../js/runtime-evidence/index.js';
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

test('P10 traceFunction rejects explicitly stale events before fact/evidence publication (#3926)', async () => {
  const adapter = traceAdapterFixture(async () => ({
    events:[{ type:'branch', epoch:1, address:'0x6000', next:'0xDEAD' }],
  }));
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  const session = await platform.startSession({ adapter, connect:false });

  assert.equal(session.newEpoch(),2);
  await assert.rejects(platform.traceFunction(0x6000), (error) => {
    assert.equal(error?.code,'session-epoch-event-mismatch');
    return true;
  });

  assert.equal(session.traces.snapshot().events.length,0);
  assert.equal(platform.evidence.length,0);
});

function appFixture() {
  const fileInfo = {
    hash:'trace-app-hash',
    slices:[{ info:{ uuid:'trace-app-slice', architecture:'arm64' } }],
  };
  return {
    store:{
      get(key) {
        if (key === 'fileInfo') return fileInfo;
        if (key === 'sliceIndex') return 0;
        if (key === 'regions') return [];
        return null;
      },
    },
    backend:{
      async readAt() { return { found:false, bytes:null }; },
      async fetchChunk() { return { mn:[], ops:[] }; },
    },
    symbols:null,
  };
}

function throwingEpochEvent(address) {
  let reads = 0;
  const event = { type:'branch', address, next:address + 4n };
  Object.defineProperty(event,'epoch',{
    enumerable:false,
    get() {
      reads += 1;
      throw new Error('epoch getter must not be re-read after rejection');
    },
  });
  return { event, reads:() => reads };
}

function assertEpochMismatch(error) {
  assert.equal(error?.code,'session-epoch-event-mismatch');
  assert.equal(error?.details?.traceEpoch,1);
  assert.equal(error?.details?.eventEpoch,null);
  assert.equal(error?.details?.reason,'event-epoch-invalid');
  return true;
}

test('P10 trace_function preserves the mismatch diagnostic for a throwing epoch getter (#3926)', async () => {
  const { event, reads } = throwingEpochEvent(0x7000n);
  const adapter = traceAdapterFixture(async () => ({ events:[event] }));
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  const session = await platform.startSession({ adapter, connect:false });

  await assert.rejects(
    createRuntimeAgentTools(platform).trace_function(0x7000n),
    assertEpochMismatch,
  );

  assert.equal(reads(),1);
  assert.equal(session.traces.snapshot().events.length,0);
  assert.equal(platform.evidence.length,0);
});

test('P10 traceAppFunction preserves the mismatch diagnostic for a throwing epoch getter (#3926)', async () => {
  const app = appFixture();
  const platform = await runtimePlatformForApp(app);
  const adapter = platform.currentSession().adapter;
  const { event, reads } = throwingEpochEvent(0x7100n);

  // Keep the app-level wrapper on the trace path while replacing only the
  // sandbox execution result with the malformed event fixture.
  adapter.launch = async () => ({});
  adapter.resume = async () => ({});
  adapter.trace = async () => ({ events:[event] });

  try {
    await assert.rejects(
      traceAppFunction(app,0x7100n),
      assertEpochMismatch,
    );
    assert.equal(reads(),1);
    assert.equal(platform.currentSession().traces.snapshot().events.length,0);
    assert.equal(platform.evidence.length,0);
  } finally {
    await resetAppRuntime(app);
  }
});

test('P10 traceFunction rejects mixed valid/stale batches without retaining a prefix (#3926)', async () => {
  const adapter = traceAdapterFixture(async () => ({
    events:[
      { type:'branch', epoch:2, address:0x7200n, next:0x7204n },
      { type:'branch', epoch:1, address:0x7204n, next:0x7208n },
    ],
  }));
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  const session = await platform.startSession({ adapter, connect:false });

  assert.equal(session.newEpoch(),2);
  await assert.rejects(platform.traceFunction(0x7200n), (error) => {
    assert.equal(error?.code,'session-epoch-event-mismatch');
    assert.equal(error?.details?.traceEpoch,2);
    assert.equal(error?.details?.eventEpoch,null);
    assert.equal(error?.details?.reason,'event-epoch-mismatch');
    return true;
  });

  assert.equal(session.traces.snapshot().events.length,0);
  assert.equal(platform.evidence.length,0);
});

test('P10 trace batch rejection exposes a structured reason for each failure class (#3926)', async () => {
  const direct = new DebugSession(adapterFixture(),{ id:'batch-reason' });
  assert.deepEqual(direct.acceptEvents({ events:'not-an-array' }),{ ok:false, reason:'events-not-array' });
  await direct.disconnect();
  assert.deepEqual(direct.acceptEvents([]),{ ok:false, reason:'closed-session' });

  const cases = [
    {
      trace:async () => ({ events:{ type:'branch' } }),
      code:'session-trace-invalid',
      reason:'events-not-array',
    },
    {
      trace:async () => ({ events:[{ type:'branch', epoch:1, value:undefined }] }),
      code:'session-trace-not-wire-safe',
      reason:'wire-unsafe',
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const adapter = traceAdapterFixture(scenario.trace);
    const platform = new RuntimeAnalysisPlatform({ symbolic:false });
    const session = await platform.startSession({ adapter, connect:false });

    await assert.rejects(platform.traceFunction(0x7300n + BigInt(index)), (error) => {
      assert.equal(error?.code,scenario.code);
      assert.equal(error?.details?.reason,scenario.reason);
      assert.equal(error?.details?.eventEpoch,null);
      return true;
    });
    assert.equal(session.traces.snapshot().events.length,0);
    assert.equal(platform.evidence.length,0);
  }
});

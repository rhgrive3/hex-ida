import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugSession } from '../../../js/runtime/session.js';

function adapterFixture() {
  return {
    id:'wire-safe-fixture',
    kind:'fixture',
    capabilities:{ modules:false, threads:false },
    async disconnect() {},
  };
}

test('P10 DebugSession rejects cyclic trace events before retention (#3909)', () => {
  const session = new DebugSession(adapterFixture(), { id:'wire-cycle' });

  const self = { type:'branch', epoch:1, address:0x1000n };
  self.self = self;
  assert.equal(session.acceptEvent(self), false);

  const a = { type:'call', epoch:1 };
  const b = { type:'return' };
  a.next = b;
  b.next = a;
  assert.equal(session.acceptEvent(a), false);

  assert.equal(session.traces.snapshot().events.length,0);
  assert.doesNotThrow(() => session.serialize());
  assert.doesNotThrow(() => session.replayShape());
});

test('P10 DebugSession preserves wire-safe trace values (#3909)', () => {
  const session = new DebugSession(adapterFixture(), { id:'wire-values' });
  const shared = { label:'shared' };
  const event = {
    type:'memory-write',
    epoch:1,
    address:0x2000n,
    bytes:new Uint8Array([1,2,3,4]),
    left:shared,
    right:shared,
  };

  assert.equal(session.acceptEvent(event), true);
  const snapshot = session.traces.snapshot();
  assert.equal(snapshot.events.length,1);
  assert.equal(snapshot.events[0].address,0x2000n);
  assert.deepEqual([...snapshot.events[0].bytes],[1,2,3,4]);
  assert.deepEqual(snapshot.events[0].left,{label:'shared'});
  assert.deepEqual(snapshot.events[0].right,{label:'shared'});
  assert.doesNotThrow(() => session.serialize());
  assert.doesNotThrow(() => session.replayShape());
});

test('P10 DebugSession snapshots caller accessors once before retaining traces (#3909)', () => {
  const session = new DebugSession(adapterFixture(), { id:'wire-getter' });
  let reads = 0;
  const event = { type:'branch', epoch:1 };
  Object.defineProperty(event,'payload',{
    enumerable:true,
    get() {
      reads += 1;
      return reads === 1 ? { target:'0x3000' } : event;
    },
  });

  assert.equal(session.acceptEvent(event), true);
  assert.equal(reads,1);
  assert.deepEqual(session.traces.snapshot().events[0].payload,{target:'0x3000'});
  assert.doesNotThrow(() => session.serialize());
  assert.doesNotThrow(() => session.replayShape());
});

test('P10 DebugSession fails closed on values the wire codec cannot serialize (#3909)', () => {
  const session = new DebugSession(adapterFixture(), { id:'wire-invalid' });

  assert.equal(session.acceptEvent({ type:'branch', epoch:1, meta:new Date(0) }), false);
  assert.equal(session.acceptEvent({ type:'branch', epoch:1, value:undefined }), false);
  assert.equal(session.acceptEvent({ type:'branch', epoch:1, value:Infinity }), false);

  assert.equal(session.traces.snapshot().events.length,0);
  assert.doesNotThrow(() => session.serialize());
  assert.doesNotThrow(() => session.replayShape());
});

test('P10 DebugSession retains captured epoch behavior for untagged safe events (#3909)', () => {
  const session = new DebugSession(adapterFixture(), { id:'wire-epoch' });
  assert.equal(session.acceptEvent({ type:'branch', pc:'0x4000' },1), true);
  assert.equal(session.newEpoch(),2);
  assert.equal(session.acceptEvent({ type:'branch', pc:'0x4004' },1), false);
  assert.equal(session.acceptEvent({ type:'branch', pc:'0x4008' },2), true);
  assert.deepEqual(session.traces.snapshot().events.map((event)=>event.pc),['0x4008']);
});

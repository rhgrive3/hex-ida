import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';
import { TraceRingBuffer } from '../js/trace/ring-buffer.js';

const io = {
  fetch: async () => ({ mn:'ret', ops:'' }),
  read: async () => null,
  isExecutable: () => true,
  symbolFor: () => null,
};

function fakeResult(trace, extra = {}) {
  return {
    trace,
    traceMeta:{ truncated:false, dropped:0, limit:4000 },
    steps:trace.length,
    takenBranches:[],
    touchedFields:[],
    before:[],
    after:[],
    modifiedObjectRanges:[],
    returnValue:0n,
    stopped:null,
    ...extra,
  };
}

// The adapter must slice memory summaries at a run boundary even though memory
// events never appear in the emulator control trace.
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address:0x1000n, objectAsArg0:false });

  // First run: one store reaches the launch-scoped trace buffer.
  adapter.traceBuffer.push({ type:'memory-write', address:0x6000n, size:1, before:0n, after:1n });
  const first = adapter._normalizeResult(fakeResult([{ addr:0x1000n, text:'nop' }]));
  assert.equal(first.stores.length, 1);
  assert.equal(first.loads.length, 0);
  assert.equal(first.calls.length + first.returns.length, 0);
  assert.equal(first.branches.length, 0);

  // Second run in the same launch generation: no new memory access, so the
  // previous generation's store must not replay into this result.
  const second = adapter._normalizeResult(fakeResult([{ addr:0x1004n, text:'nop' }]));
  assert.equal(second.stores.length, 0, 'previous segment store must not replay into a later resume');
  assert.equal(second.loads.length, 0);
  assert.deepEqual(second.trace.events.filter((e) => e.type === 'memory-write').length, 1,
    'the cumulative trace snapshot still holds the historical memory event');

  // Third run: only the new store is reported.
  adapter.traceBuffer.push({ type:'memory-write', address:0x6008n, size:1, before:0n, after:2n });
  adapter.traceBuffer.push({ type:'memory-read', address:0x6010n, size:1, region:'object', value:5n });
  const third = adapter._normalizeResult(fakeResult([{ addr:0x1008n, text:'nop' }]));
  assert.deepEqual(third.stores.map((s) => String(s.address)), [String(0x6008n)]);
  assert.deepEqual(third.loads.map((l) => String(l.address)), [String(0x6010n)]);
  await adapter.disconnect();
}

// Ring eviction across a run boundary must not corrupt the new segment summary:
// monotonic seen counters stay comparable even when old events were evicted.
{
  const adapter = new LocalFunctionSandboxAdapter(io, { trace:{ maxEvents:16 } });
  await adapter.connect();
  await adapter.launch({ address:0x1000n, objectAsArg0:false });

  // First run: 20 stores evict themselves from the 16-slot ring.
  for (let i = 0; i < 20; i++) adapter.traceBuffer.push({ type:'memory-write', address:0x6000n + BigInt(i), size:1, before:0n, after:BigInt(i) });
  const first = adapter._normalizeResult(fakeResult(Array.from({ length:20 }, (_, i) => ({ addr:0x1000n + BigInt(i * 4), text:'nop' }))));
  assert.equal(first.stores.length, 16, 'events still retained by the ring belong to this run; only truly evicted ones are gone');
  assert.equal(first.trace.incomplete, true, 'ring eviction still marks the cumulative trace incomplete');

  // Second run: no new memory events; evicted history must not leak back in.
  const second = adapter._normalizeResult(fakeResult([{ addr:0x1100n, text:'nop' }]));
  assert.equal(second.stores.length, 0);
  await adapter.disconnect();
}

// launch()/disconnect() reset the memory run boundary with the buffer itself.
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address:0x1000n, objectAsArg0:false });
  adapter.traceBuffer.push({ type:'memory-write', address:0x6000n, size:1, before:0n, after:1n });
  const preLaunch = adapter._normalizeResult(fakeResult([{ addr:0x1000n, text:'nop' }]));
  assert.equal(preLaunch.stores.length, 1);

  await adapter.launch({ address:0x1000n, objectAsArg0:false });
  const postRelaunch = adapter._normalizeResult(fakeResult([{ addr:0x1000n, text:'nop' }]));
  assert.equal(postRelaunch.stores.length, 0, 'a fresh launch generation starts with a clean memory boundary');
  await adapter.disconnect();
}

// The ring buffer records the monotonic push sequence for boundary bookkeeping
// while keeping it out of public snapshots.
{
  const ring = new TraceRingBuffer({ maxEvents:16 });
  ring.push({ type:'memory-write', address:1n });
  ring.push({ type:'memory-write', address:2n });
  ring.push({ type:'memory-write', address:3n });
  ring.push({ type:'memory-write', address:4n });
  ring.push({ type:'memory-write', address:5n });
  assert.equal(ring.seen, 5, 'seen counts every push attempt, accepted or evicted');
  const snap = ring.snapshot();
  assert.ok(snap.events.every((e) => e.__seen === undefined), '__seen is internal bookkeeping and must not leak into snapshots');
  ring.clear();
  assert.equal(ring.seen, 0);
}

console.log('issue #6301 stale memory events across multiple resumes: PASS');

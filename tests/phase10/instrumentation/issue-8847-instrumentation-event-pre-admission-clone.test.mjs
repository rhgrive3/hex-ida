import assert from 'node:assert/strict';
import test from 'node:test';

import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

const binaryId = 'bin_sha256_' + '9a'.repeat(32);

function openProvider(options = {}) {
  return new InstrumentationProvider({ id: 'fixture-backend' }, {
    id: 'fixture-provider',
    events: { maxBytes: 1024, maxEvents: 8, ...options },
  });
}

async function openSession(provider) {
  return provider.openSession({ binaryId, targetIdentity: 'process:1', sessionNonce: 'inst:8847' }, { connect: false });
}

// #8847: the provider-owned envelope snapshot must be bounded so a deep or
// oversized hostile event is cheaply rejected by the event budget instead of
// running the old unbounded recursion into a native stack overflow / unbounded
// allocation before the normalizer's events.maxBytes is ever consulted.
test('#8847 a deep hostile event is dropped, never a native stack overflow', async () => {
  const session = await openSession(openProvider());
  let payload = { leaf: true };
  for (let i = 0; i < 50000; i += 1) payload = { next: payload };
  let result;
  assert.doesNotThrow(() => {
    result = session.facets.instrumentation.events.ingest({
      type: 'instrumentation-observation', epoch: 1, streamId: 'thread:1', sequence: 1, payload,
    });
  }, 'deep ingress must not throw before the budget (previously "Maximum call stack size exceeded")');
  assert.equal(result, null, 'over-budget deep event is dropped, not materialized');
  const batch = session.facets.instrumentation.events.flush();
  assert.equal(batch.events.some((event) => event.kind === 'instrumentation-observation'), false,
    'the hostile event is not published');
  await session.close();
});

test('#8847 an oversized flat byte/array payload is rejected before full allocation', async () => {
  const session = await openSession(openProvider());
  assert.equal(session.facets.instrumentation.events.ingest({
    type: 'instrumentation-observation', epoch: 1, streamId: 'thread:1', sequence: 1,
    payload: { blob: new Uint8Array(64 * 1024) },
  }), null, 'a byte view larger than maxBytes is dropped, not cloned');
  assert.equal(session.facets.instrumentation.events.ingest({
    type: 'instrumentation-observation', epoch: 1, streamId: 'thread:1', sequence: 2,
    payload: { rows: new Array(200000).fill('aaaaaaaaaa') },
  }), null, 'an array far larger than maxBytes is dropped, not cloned');
  // A following well-formed small event is still admitted, proving the drop is a
  // per-event admission decision and did not poison the session ingest path.
  const ok = session.facets.instrumentation.events.ingest({
    type: 'instrumentation-observation', epoch: 1, streamId: 'thread:1', sequence: 3, payload: { call: 'foo' },
  });
  assert.ok(ok, 'normal ingress still works after an over-budget drop');
  await session.close();
});

test('#8847 within-budget events keep owned-snapshot semantics', async () => {
  const session = await openSession(openProvider());
  const backendPayload = { call: 'foo' };
  const event = session.facets.instrumentation.events.ingest({
    type: 'instrumentation-observation', epoch: 1, streamId: 'thread:1', sequence: 1, payload: backendPayload,
  });
  assert.ok(event, 'a small event is admitted');
  assert.equal(event.kind, 'instrumentation-observation');
  backendPayload.call = 'MUTATED';
  const batch = session.facets.instrumentation.events.flush();
  const observed = batch.events.find((item) => item.kind === 'instrumentation-observation');
  assert.equal(observed.payload.call, 'foo', 'queued event is an owned snapshot of the original bytes');
  await session.close();
});

test('#8847 the bound does not change the shape the provider must preserve (#4778 parity)', async () => {
  // A DataView stays an owned DataView over a non-aliased buffer, and the whole
  // envelope is snapshot once, exactly as the pre-admission-ownership contract
  // (#4778) requires; #8847 only adds a ceiling, it does not weaken ownership.
  const backing = new Uint8Array([0xaa, 0x11, 0x22, 0x33, 0xbb]);
  const view = new DataView(backing.buffer, 1, 3);
  let filtered = null;
  const provider = new InstrumentationProvider({ id: 'fixture-backend' }, {
    id: 'shape-provider', events: { maxBytes: 4096 },
    eventFilter(event) { filtered = event; return true; },
  });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:2', sessionNonce: 'inst:8847b' }, { connect: false });
  session.facets.instrumentation.events.ingest({
    type: 'instrumentation-observation', epoch: 1, streamId: 'thread:1', sequence: 1,
    payload: { view, note: 'x' },
  });
  assert.ok(filtered.payload.view instanceof DataView, 'the owned envelope keeps the DataView kind');
  assert.notEqual(filtered.payload.view.buffer, view.buffer, 'and does not alias caller storage');
  backing.fill(0);
  assert.deepEqual(Array.from(new Uint8Array(filtered.payload.view.buffer, filtered.payload.view.byteOffset, filtered.payload.view.byteLength)), [0x11, 0x22, 0x33]);
  await session.close();
});

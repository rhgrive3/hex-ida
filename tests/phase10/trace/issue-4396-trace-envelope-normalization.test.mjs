import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeLegacyRuntimeEvent } from '../../../js/runtime/events.js';
import { TraceProvider } from '../../../js/runtime/trace-provider.js';

const binaryId = 'bin_sha256_' + '43'.repeat(32);

function recording(events) {
  return {
    recordingId: 'recording:issue-4396',
    schemaVersion: '1',
    sourceProvider: 'fixture-tracer',
    sourceProviderVersion: '1',
    binaryId,
    completeness: 'complete',
    events,
  };
}

async function replay(events) {
  const provider = new TraceProvider(recording(events), { id: 'trace-provider-4396' });
  const session = await provider.openSession();
  const batch = await session.facets.trace.replay();
  await session.close();
  return batch.events;
}

test('issue #4396: protocol envelope preserves event kind, data payload, and outer metadata', async () => {
  const [event] = await replay([{
    type: 'event',
    event: 'paused',
    data: { reason: 'breakpoint', threadKey: 'data-thread' },
    streamId: 'outer-stream',
    sequence: 7,
    timestamp: '2026-09-06T00:00:00Z',
    threadKey: 'outer-thread',
    completeness: 'complete',
  }]);

  assert.equal(event.kind, 'paused');
  assert.deepEqual(event.payload, { reason: 'breakpoint', threadKey: 'data-thread' });
  assert.equal(event.streamId, 'outer-stream');
  assert.equal(event.sequence, 7);
  assert.equal(event.timestamp, '2026-09-06T00:00:00Z');
  assert.equal(event.threadKey, 'outer-thread');
});

test('issue #4396: module and memory protocol envelopes retain their data', async () => {
  const events = await replay([
    {
      type: 'event',
      event: 'module-load',
      data: {
        moduleBindingKey: 'main',
        runtimeBase: '0x1000',
        runtimeSize: '0x1000',
      },
    },
    {
      type: 'event',
      event: 'memory-write',
      data: {
        address: '0x1010',
        value: 1,
      },
    },
  ]);

  assert.deepEqual(events.map((event) => event.kind), ['module-load', 'memory-write']);
  assert.equal(events[0].moduleBindingKey, 'main');
  assert.deepEqual(events[0].payload, {
    moduleBindingKey: 'main',
    runtimeBase: '0x1000',
    runtimeSize: '0x1000',
  });
  assert.deepEqual(events[1].payload, { address: '0x1010', value: 1 });
});

test('issue #4396: legacy non-envelope trace records keep existing semantics', async () => {
  const [event] = await replay([{
    kind: 'call',
    streamId: 'thread-1',
    payload: { target: '0x1234' },
  }]);

  assert.equal(event.kind, 'call');
  assert.equal(event.streamId, 'thread-1');
  assert.equal(event.sequence, 0);
  assert.deepEqual(event.payload, { target: '0x1234' });
});

test('issue #4396: unknown protocol event names fail closed without discarding data', async () => {
  const [event] = await replay([{
    type: 'event',
    event: 'vendor-special',
    data: { marker: 1 },
  }]);

  assert.equal(event.kind, 'trace-marker');
  assert.deepEqual(event.payload, { marker: 1 });
});

test('issue #4396: TraceProvider envelope fields agree with the shared legacy normalizer', async () => {
  const envelope = {
    type: 'event',
    event: 'memory-write',
    data: {
      address: '0x2000',
      value: 9,
      threadKey: 'data-thread',
    },
    streamId: 'stream-9',
    sequence: 9,
    providerEventId: 'provider-event-9',
    timestamp: '2026-09-06T00:00:09Z',
    processKey: 'process-9',
    threadKey: 'thread-9',
    moduleBindingKey: 'module-9',
    moduleGeneration: 2,
    observationMode: 'observed',
    completeness: 'complete',
    predecessorIds: ['event-8'],
    interventionIds: ['intervention-9'],
  };

  const [traceEvent] = await replay([envelope]);
  const sharedEvent = normalizeLegacyRuntimeEvent(envelope, {
    runtimeSessionId: traceEvent.runtimeSessionId,
    providerId: traceEvent.providerId,
    providerVersion: traceEvent.providerVersion,
    sessionEpoch: traceEvent.sessionEpoch,
    completeness: 'complete',
  });

  for (const field of [
    'eventId',
    'streamId',
    'sequence',
    'providerEventId',
    'timestamp',
    'processKey',
    'threadKey',
    'moduleBindingKey',
    'moduleGeneration',
    'kind',
    'observationMode',
    'completeness',
  ]) {
    assert.deepEqual(traceEvent[field], sharedEvent[field], field);
  }
  assert.deepEqual(traceEvent.payload, sharedEvent.payload);
  assert.deepEqual(traceEvent.predecessorIds, sharedEvent.predecessorIds);
  assert.deepEqual(traceEvent.interventionIds, sharedEvent.interventionIds);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeEvidenceBridge } from '../../../js/runtime/evidence-bridge.js';
import { RuntimeEventNormalizer, createRuntimeEvent } from '../../../js/runtime/events.js';

const context = {
  runtimeSessionId: 'runtime-4568',
  providerId: 'provider-4568',
  providerVersion: '1',
  sessionEpoch: 1,
};

function repeatedEvent(timestamp, overrides = {}) {
  return createRuntimeEvent({
    ...context,
    kind: 'memory-read',
    payload: { address: '0x1000', value: 1 },
    timestamp,
    ...overrides,
  });
}

test('#4568 fallback auto eventId distinguishes repeated observations by timestamp', () => {
  const first = repeatedEvent('2026-09-03T00:00:00.000Z');
  const second = repeatedEvent('2026-09-03T00:00:01.000Z');

  assert.notEqual(first.eventId, second.eventId);
});

test('#4568 repeated timestamped events survive normalizer -> evidence bridge without ID conflict', () => {
  const normalizer = new RuntimeEventNormalizer(context);
  assert.ok(normalizer.push({
    type: 'memory-read',
    timestamp: '2026-09-03T00:00:00.000Z',
    payload: { address: '0x1000', value: 1 },
  }));
  assert.ok(normalizer.push({
    type: 'memory-read',
    timestamp: '2026-09-03T00:00:01.000Z',
    payload: { address: '0x1000', value: 1 },
  }));

  const batch = normalizer.flush();
  assert.equal(batch.events.length, 2);

  const bridge = new RuntimeEvidenceBridge();
  const first = bridge.eventToEvidence(batch.events[0], null, { binaryId: 'bin-4568' });
  const second = bridge.eventToEvidence(batch.events[1], null, { binaryId: 'bin-4568' });

  assert.notEqual(first.id, second.id);
  assert.equal(bridge.graph.allNodes().length, 2);
});

test('#4568 providerEventId remains the authoritative retransmission identity', () => {
  const normalizer = new RuntimeEventNormalizer(context);
  const first = normalizer.push({
    type: 'memory-read',
    providerEventId: 'provider-event-7',
    timestamp: '2026-09-03T00:00:00.000Z',
    payload: { address: '0x1000', value: 1 },
  });
  const duplicate = normalizer.push({
    type: 'memory-read',
    providerEventId: 'provider-event-7',
    timestamp: '2026-09-03T00:00:01.000Z',
    payload: { address: '0x1000', value: 2 },
  });

  assert.ok(first);
  assert.equal(duplicate, null);
});

test('#4568 streamId + sequence remains the authoritative retransmission identity', () => {
  const normalizer = new RuntimeEventNormalizer(context);
  const first = normalizer.push({
    type: 'memory-read',
    streamId: 'thread:1',
    sequence: 9,
    timestamp: '2026-09-03T00:00:00.000Z',
  });
  const duplicate = normalizer.push({
    type: 'memory-read',
    streamId: 'thread:1',
    sequence: 9,
    timestamp: '2026-09-03T00:00:01.000Z',
  });

  assert.ok(first);
  assert.equal(duplicate, null);
});

test('#4568 explicit eventId contract is unchanged by timestamp', () => {
  const first = repeatedEvent('2026-09-03T00:00:00.000Z', { eventId: 'explicit-event-4568' });
  const second = repeatedEvent('2026-09-03T00:00:01.000Z', { eventId: 'explicit-event-4568' });

  assert.equal(first.eventId, 'explicit-event-4568');
  assert.equal(second.eventId, 'explicit-event-4568');
});

test('#4568 timestamp identity material rejects structured coercion', () => {
  assert.throws(
    () => repeatedEvent(['2026-09-03T00:00:00.000Z']),
    /timestamp must be a string|runtime-invalid-event-timestamp/,
  );
});

test('#4568 authoritative provider and stream identities do not drift with timestamp', () => {
  const providerFirst = repeatedEvent('t1', { providerEventId: 'provider-event-stable' });
  const providerSecond = repeatedEvent('t2', { providerEventId: 'provider-event-stable' });
  assert.equal(providerFirst.eventId, providerSecond.eventId);

  const streamFirst = repeatedEvent('t1', { streamId: 'stream-stable', sequence: 4 });
  const streamSecond = repeatedEvent('t2', { streamId: 'stream-stable', sequence: 4 });
  assert.equal(streamFirst.eventId, streamSecond.eventId);
});

test('#4568 timestamp is snapshotted once and custom coercion is never invoked', () => {
  let reads = 0;
  const event = createRuntimeEvent({
    ...context,
    kind: 'trace-marker',
    get timestamp() {
      reads++;
      return 'opaque-provider-timestamp';
    },
  });
  assert.equal(reads, 1);
  assert.equal(event.timestamp, 'opaque-provider-timestamp');

  let coercions = 0;
  const structuredTimestamp = {
    toString() {
      coercions++;
      return 'opaque-provider-timestamp';
    },
  };
  assert.throws(
    () => repeatedEvent(structuredTimestamp),
    /timestamp must be a string|runtime-invalid-event-timestamp/,
  );
  assert.equal(coercions, 0);
});

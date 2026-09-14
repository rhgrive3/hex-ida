import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeProviderSession } from '../../../js/runtime/provider.js';
import { TraceProvider } from '../../../js/runtime/trace-provider.js';

function recording(overrides = {}) {
  return {
    recordingId: 'trace:5697',
    sourceProvider: 'fixture-tracer',
    sourceProviderVersion: '1',
    binaryId: 'bin_5697',
    completeness: 'complete',
    events: [{
      kind: 'trace-marker',
      streamId: 'trace',
      sequence: 1,
      payload: { pc: '0x1000' },
      completeness: 'complete',
    }],
    ...overrides,
  };
}

function expectTraceEpochUnsupported(session) {
  assert.throws(
    () => session.newEpoch('issue-5697-probe'),
    (error) => error?.code === 'runtime-epoch-unsupported',
    'immutable trace sessions must reject epoch transitions explicitly',
  );
}

function assertBatchEpochIdentity(batch, session) {
  assert.equal(batch.sessionEpoch, session.epoch);
  assert.ok(batch.events.every((event) => event.sessionEpoch === batch.sessionEpoch));
}

test('issue #5697: TraceProvider rejects epoch changes without invalidating replay state', async () => {
  const provider = new TraceProvider(recording(), { id: 'trace-provider-5697' });
  const session = await provider.openSession({ sessionNonce: 'session-5697' });
  const controller = session.controller();
  const originalEpoch = session.epoch;
  const originalEventIds = session.normalizedEvents.map((event) => event.eventId);

  expectTraceEpochUnsupported(session);
  expectTraceEpochUnsupported(session);

  assert.equal(session.epoch, originalEpoch, 'a rejected transition must not mutate the trace epoch');
  assert.equal(controller.signal.aborted, false, 'a rejected transition must not cancel current-epoch work');
  assert.deepEqual(session.normalizedEvents.map((event) => event.eventId), originalEventIds);

  const replay = await session.facets.trace.replay();
  assertBatchEpochIdentity(replay, session);
  assert.deepEqual(replay.events.map((event) => event.eventId), originalEventIds);

  const batches = [];
  for await (const batch of session.facets.trace.events({ batchSize: 1 })) batches.push(batch);
  assert.equal(batches.length, 1);
  assertBatchEpochIdentity(batches[0], session);
  assert.deepEqual(batches[0].events.map((event) => event.eventId), originalEventIds);

  session.releaseController(controller);
  await session.close();
  assert.throws(() => session.newEpoch(), (error) => error?.code === 'runtime-session-closed');
});

test('issue #5697: synthetic dropped-events records obey the same immutable epoch policy', async () => {
  const provider = new TraceProvider(recording({
    recordingId: 'trace:5697:dropped',
    events: [],
    dropped: 3,
    truncated: true,
  }), { id: 'trace-provider-5697-dropped' });
  const session = await provider.openSession({ sessionNonce: 'session-5697-dropped' });

  assert.deepEqual(session.normalizedEvents.map((event) => event.kind), ['dropped-events']);
  assert.ok(session.normalizedEvents.every((event) => event.sessionEpoch === session.epoch));
  expectTraceEpochUnsupported(session);

  const replay = await session.facets.trace.replay();
  assertBatchEpochIdentity(replay, session);
  assert.equal(replay.dropped, 3);
  assert.equal(replay.completeness, 'truncated');
  assert.equal(replay.events[0].kind, 'dropped-events');

  await session.close();
});

test('issue #5697: generic RuntimeProviderSession retains epoch cancellation semantics', async () => {
  const provider = {
    descriptor() { return { id: 'generic-provider-5697', version: '1' }; },
  };
  const session = new RuntimeProviderSession({
    provider,
    request: {
      binaryId: 'bin_generic_5697',
      targetIdentity: { fixture: '5697' },
      sessionNonce: 'generic-session-5697',
    },
  });
  const controller = session.controller();

  assert.equal(session.newEpoch('generic-transition'), 2);
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason, 'generic-transition');
  await session.close();
});

test('issue #5697: an attempted epoch change cannot corrupt an in-progress trace stream', async () => {
  const provider = new TraceProvider(recording({
    recordingId: 'trace:5697:stream',
    events: [
      { kind: 'trace-marker', streamId: 'trace', sequence: 1, payload: { pc: '0x1000' }, completeness: 'complete' },
      { kind: 'trace-marker', streamId: 'trace', sequence: 2, payload: { pc: '0x1004' }, completeness: 'complete' },
    ],
  }), { id: 'trace-provider-5697-stream' });
  const session = await provider.openSession({ sessionNonce: 'session-5697-stream' });
  const iterator = session.facets.trace.events({ batchSize: 1 });

  const first = await iterator.next();
  assert.equal(first.done, false);
  assertBatchEpochIdentity(first.value, session);
  expectTraceEpochUnsupported(session);
  const second = await iterator.next();
  assert.equal(second.done, false);
  assertBatchEpochIdentity(second.value, session);
  assert.equal(second.value.events[0].sequence, 2);
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });

  await session.close();
});

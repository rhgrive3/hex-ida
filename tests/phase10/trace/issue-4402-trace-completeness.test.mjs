import assert from 'node:assert/strict';
import test from 'node:test';

import { TraceProvider } from '../../../js/runtime/trace-provider.js';

function recording(overrides = {}) {
  return {
    recordingId: 'recording:issue-4402',
    sourceProvider: 'fixture-tracer',
    sourceProviderVersion: '1',
    binaryId: 'binary:issue-4402',
    completeness: 'bounded',
    events: [],
    ...overrides,
  };
}

let sessionSequence = 0;

async function open(overrides = {}, options = {}) {
  const provider = new TraceProvider(recording(overrides), { id: 'trace-provider-4402', ...options });
  const session = await provider.openSession({ sessionNonce: `issue-4402-${++sessionSequence}` });
  return { provider, session };
}

test('#4402 canonical recording completeness is rejected before a session can open', () => {
  for (const completeness of ['completee', ['complete'], 1, true]) {
    assert.throws(
      () => new TraceProvider(recording({ completeness })),
      (error) => error?.code === 'trace-invalid-completeness',
      `invalid completeness must be rejected: ${String(completeness)}`,
    );
  }
  assert.throws(
    () => new TraceProvider(recording({ completeness: 'completee', truncated: true })),
    (error) => error?.code === 'trace-invalid-completeness',
  );
});

test('#4402 bounded recording and bounded events replay successfully', async () => {
  const { session } = await open({
    events: [{ kind: 'trace-marker', completeness: 'bounded', payload: { marker: 1 } }],
  });
  const stream = (await session.facets.trace.events({ batchSize: 1 }).next()).value;
  const replay = await session.facets.trace.replay();
  assert.equal(session.sourceCompleteness, 'bounded');
  assert.equal(stream.completeness, 'bounded');
  assert.equal(replay.completeness, 'bounded');
  await session.close();
});

test('#4402 stronger recording metadata is conservatively downgraded to partial event evidence', async () => {
  const { session } = await open({
    completeness: 'complete',
    events: [
      { kind: 'trace-marker', completeness: 'partial', payload: { marker: 'partial' } },
      { kind: 'trace-marker', completeness: 'complete', payload: { marker: 'complete' } },
    ],
  });
  const streamed = [];
  for await (const batch of session.facets.trace.events({ batchSize: 1 })) streamed.push(batch);
  const replay = await session.facets.trace.replay();
  assert.equal(session.sourceCompleteness, 'partial');
  assert.deepEqual(streamed.map((batch) => batch.completeness), ['partial', 'partial']);
  assert.equal(replay.completeness, 'partial');
  assert.deepEqual(replay.events.map((event) => event.payload.marker), ['partial', 'complete']);
  await session.close();
});

test('#4402 weaker recording metadata never upgrades complete event evidence', async () => {
  const { session } = await open({
    completeness: 'partial',
    events: [{ kind: 'trace-marker', completeness: 'complete', payload: { marker: 'complete' } }],
  });
  const stream = (await session.facets.trace.events({ batchSize: 1 }).next()).value;
  const replay = await session.facets.trace.replay();
  assert.equal(session.sourceCompleteness, 'partial');
  assert.equal(stream.completeness, 'partial');
  assert.equal(replay.completeness, 'partial');
  assert.equal(replay.events[0].completeness, 'complete');
  await session.close();
});

test('#4402 dropped events retain the existing truncated authority', async () => {
  const { session } = await open({ completeness: 'complete', dropped: 3 });
  const stream = (await session.facets.trace.events({ batchSize: 1 }).next()).value;
  const replay = await session.facets.trace.replay();
  assert.equal(session.sourceCompleteness, 'truncated');
  assert.equal(stream.completeness, 'truncated');
  assert.equal(replay.completeness, 'truncated');
  assert.equal(replay.dropped, 3);
  await session.close();
});

test('#4402 an unsupported event cannot be hidden inside a truncated batch', async () => {
  const { session } = await open({
    completeness: 'complete',
    events: [
      { kind: 'gap', completeness: 'truncated', payload: { reason: 'sampling' } },
      { kind: 'trace-marker', completeness: 'unsupported', payload: { marker: 'unavailable' } },
    ],
  });
  const stream = (await session.facets.trace.events({ batchSize: 2 }).next()).value;
  const replay = await session.facets.trace.replay();
  assert.equal(session.sourceCompleteness, 'unsupported');
  assert.equal(stream.completeness, 'unsupported');
  assert.equal(replay.completeness, 'unsupported');
  await session.close();
});

test('#4402 empty valid recordings have one consistent aggregate policy', async () => {
  const { session } = await open({ completeness: 'complete' });
  const streamed = [];
  for await (const batch of session.facets.trace.events()) streamed.push(batch);
  const replay = await session.facets.trace.replay();
  assert.deepEqual(streamed, [], 'an empty recording emits no empty stream batch');
  assert.equal(replay.completeness, 'complete');
  assert.deepEqual(replay.events, []);
  await session.close();
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

function sessionFor(engine, nonce) {
  const provider = new EmulatorProvider(engine, { id: 'emulator-5929-provider' });
  return provider.openSession({
    binaryId: 'bin-5929',
    targetIdentity: 'fixture',
    sessionNonce: nonce,
  });
}

test('#5929 fallback event identity is unique across ordinary runs', async () => {
  let invocation = 0;
  const session = await sessionFor({
    id: 'fallback-event-engine',
    version: '1',
    async execute() {
      invocation++;
      return {
        termination: 'return',
        events: [{
          kind: 'basic-block',
          payload: { address: '0x1000' },
          // The payload and event kind stay the same; only the observation
          // timestamp differs between the two normal executions.
          timestamp: `fixture-run-${invocation}`,
        }],
      };
    },
  }, '5929-ordinary-runs');

  const first = await session.facets.emulator.run({ input: 1 });
  const second = await session.facets.emulator.run({ input: 2 });
  const firstEvent = first.batch.events[0];
  const secondEvent = second.batch.events[0];

  assert.notEqual(firstEvent.eventId, secondEvent.eventId);
  assert.match(firstEvent.streamId, /^emulator:run:1$/);
  assert.match(secondEvent.streamId, /^emulator:run:2$/);
  assert.equal(firstEvent.sequence, 0);
  assert.equal(secondEvent.sequence, 0);
  assert.notEqual(first.evidence[0].id, second.evidence[0].id);
  assert.notEqual(first.evidence[0].createdAt, second.evidence[0].createdAt);
  assert.equal(session.facets.emulator.evidence.graph.allNodes().length, 2);
  assert.equal(session.epoch, 1);

  await session.close();
});

test('#5929 empty-event fallback gets a distinct checkpoint per run', async () => {
  const session = await sessionFor({
    id: 'empty-event-engine',
    version: '1',
    async execute() { return { termination: 'return' }; },
  }, '5929-empty-events');

  const first = await session.facets.emulator.run({ input: 1 });
  const second = await session.facets.emulator.run({ input: 2 });
  const firstEvent = first.batch.events[0];
  const secondEvent = second.batch.events[0];

  assert.equal(firstEvent.kind, 'emulator-checkpoint');
  assert.equal(secondEvent.kind, 'emulator-checkpoint');
  assert.notEqual(firstEvent.eventId, secondEvent.eventId);
  assert.notEqual(firstEvent.streamId, secondEvent.streamId);
  assert.equal(firstEvent.sequence, 0);
  assert.equal(secondEvent.sequence, 0);
  assert.equal(session.facets.emulator.evidence.graph.allNodes().length, 2);

  await session.close();
});

test('#5929 preserves engine-supplied identity fields', async () => {
  const session = await sessionFor({
    id: 'supplied-event-engine',
    version: '1',
    async execute(input) {
      if (input.kind === 'provider-id') {
        return {
          termination: 'return',
          events: [{
            kind: 'call',
            providerEventId: 'engine-event-7',
            streamId: 'engine-provider-stream',
            sequence: 7,
            payload: { target: 'helper' },
          }],
        };
      }
      return {
        termination: 'return',
        events: [{
          kind: 'return',
          streamId: 'engine-stream',
          sequence: 41,
          payload: { value: 7 },
        }],
      };
    },
  }, '5929-supplied-identities');

  const providerIdEvent = (await session.facets.emulator.run({ kind: 'provider-id' })).batch.events[0];
  const streamSequenceEvent = (await session.facets.emulator.run({ kind: 'stream-sequence' })).batch.events[0];

  assert.equal(providerIdEvent.providerEventId, 'engine-event-7');
  assert.equal(providerIdEvent.streamId, 'engine-provider-stream');
  assert.equal(providerIdEvent.sequence, 7);
  assert.equal(streamSequenceEvent.providerEventId, null);
  assert.equal(streamSequenceEvent.streamId, 'engine-stream');
  assert.equal(streamSequenceEvent.sequence, 41);

  await session.close();
});

test('#5929 deterministic replay is a new fallback event occurrence', async () => {
  const session = await sessionFor({
    id: 'replay-event-engine',
    version: '1',
    deterministic: true,
    async execute() {
      return {
        termination: 'return',
        events: [{ kind: 'basic-block', payload: { address: '0x2000' } }],
      };
    },
  }, '5929-replay');

  const first = await session.facets.emulator.run({ input: 3 });
  const replay = await session.facets.emulator.replay(first.recording);

  assert.notEqual(first.batch.events[0].eventId, replay.batch.events[0].eventId);
  assert.notEqual(first.recording.eventIds[0], replay.recording.eventIds[0]);
  assert.equal(session.facets.emulator.evidence.graph.allNodes().length, 2);

  await session.close();
});


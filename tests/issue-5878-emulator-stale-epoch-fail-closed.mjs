import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../js/runtime/emulator-provider.js';

function gatedEngine() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const engine = {
    async execute(_input, _options) {
      await gate;
      return { termination: 'return', events: [{ kind: 'memory-write', address: 0x1000n, before: 0, after: 1 }] };
    },
  };
  return { engine, release };
}

test('#5878 a late engine completion after newEpoch must not become the new epoch observation', async () => {
  const { engine, release } = gatedEngine();
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 's1' }, { connect: false });
  const startedEpoch = session.epoch;

  const pending = session.facets.emulator.run({});
  await Promise.resolve();
  session.newEpoch();
  assert.notEqual(session.epoch, startedEpoch);

  release();
  await assert.rejects(
    () => pending,
    (error) => error.code === 'runtime-session-stale' && error.details?.currentEpoch === session.epoch
      && error.details?.startedEpoch === startedEpoch,
    'stale-run completion must fail closed instead of re-labelling',
  );
});

test('#5878 a normal same-epoch run keeps returning its batch', async () => {
  const engine = {
    async execute() {
      return { termination: 'return', events: [{ kind: 'memory-write', address: 0x1000n, before: 0, after: 1 }] };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 's2' }, { connect: false });
  const result = await session.facets.emulator.run({});
  assert.equal(result.termination, 'return');
  assert.equal(result.batch.sessionEpoch, session.epoch);
  assert.equal(result.batch.events[0].sessionEpoch, session.epoch);
});

test('#5878 every event published by a run carries the started epoch', async () => {
  const engine = {
    async execute() {
      return { termination: 'return', events: [{ kind: 'memory-write', address: 0x1000n, before: 0, after: 1 }] };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 's3' }, { connect: false });
  const before = session.epoch;
  const result = await session.facets.emulator.run({});
  assert.equal(result.batch.sessionEpoch, before);
  for (const event of result.batch.events) assert.equal(event.sessionEpoch, before);
});

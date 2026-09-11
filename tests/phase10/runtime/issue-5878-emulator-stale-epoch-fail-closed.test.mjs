import assert from 'node:assert/strict';
import test from 'node:test';

import '../../issue-5878-emulator-stale-epoch-fail-closed.mjs';
import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

test('#5878 stale completion preserves new-epoch state and the previous replay recording', async () => {
  let releaseStale;
  const staleGate = new Promise((resolve) => { releaseStale = resolve; });
  const calls = [];
  const engine = {
    async execute(input) {
      calls.push(input?.kind ?? null);
      if (input?.kind === 'stale') await staleGate;
      return {
        termination: 'return',
        events: [{ kind: 'memory-write', address: 0x1000n, before: 0, after: 1 }],
      };
    },
  };
  const provider = new EmulatorProvider(engine, { deterministic: true });
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 's4' }, { connect: false });

  const seed = await session.facets.emulator.run({ kind: 'seed' });
  assert.equal(session.state, 'ready');
  assert.equal(seed.recording.input.kind, 'seed');

  const pending = session.facets.emulator.run({ kind: 'stale' });
  await Promise.resolve();
  session.newEpoch();
  session.setState('paused');

  releaseStale();
  await assert.rejects(
    () => pending,
    (error) => error.code === 'runtime-session-stale',
    'stale completion must fail closed after the epoch changes',
  );
  assert.equal(session.state, 'paused', 'stale completion must not publish ready/degraded state into the new epoch');

  const replay = await session.facets.emulator.replay();
  assert.deepEqual(calls, ['seed', 'stale', 'seed'], 'stale completion must not replace the previous replay recording');
  assert.equal(replay.recording.input.kind, 'seed');
});


test('#5878 cooperative engine cancellation preserves the new epoch state', async () => {
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let observedAbort = false;
  const engine = {
    execute(_input, { signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          observedAbort = true;
          reject(new Error('engine cancelled'));
        }, { once: true });
        started();
      });
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 'cooperative' }, { connect: false });
  const originalEpoch = session.epoch;
  const pending = session.facets.emulator.run({});
  const rejected = assert.rejects(pending, (error) => error.code === 'runtime-session-stale'
    && error.details.startedEpoch === originalEpoch
    && error.details.currentEpoch === session.epoch);
  await entered;
  session.newEpoch();
  session.setState('paused');
  await rejected;
  assert.equal(observedAbort, true);
  assert.equal(session.state, 'paused');
});

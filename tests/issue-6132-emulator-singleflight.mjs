import assert from 'node:assert/strict';
import { EmulatorProvider } from '../js/runtime/emulator-provider.js';

// #6132: same emulator session must not allow concurrent runs.
{
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const engine = {
    async execute() {
      calls++;
      if (calls === 1) {
        await firstGate;
        return { termination: 'return' };
      }
      return { termination: 'return' };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'bin', sessionNonce: '6132-singleflight' });
  const runA = session.facets.emulator.run({ id: 'A' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  assert.equal(session.state, 'running');
  await assert.rejects(session.facets.emulator.run({ id: 'B' }), (error) => error?.code === 'already-running');
  assert.equal(calls, 1);
  assert.equal(session.state, 'running');
  releaseFirst();
  await runA;
  assert.equal(session.state, 'ready');
  const runC = await session.facets.emulator.run({ id: 'C' });
  assert.equal(runC.termination, 'return');
  assert.equal(calls, 2);
  await session.close();
}

{
  let release;
  let gate = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const engine = {
    deterministic: true,
    async execute() {
      count++;
      if (count === 1) return { termination: 'return', events: [] };
      await gate;
      return { termination: 'return', events: [] };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'bin', sessionNonce: '6132-replay' }, { connect: false });
  const first = await session.facets.emulator.run({});
  gate = new Promise((resolve) => { release = resolve; });
  const pending = session.facets.emulator.run({});
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(session.facets.emulator.replay(first.recording), (error) => error?.code === 'already-running');
  release();
  await pending;
  await session.close();
}

{
  const engine = {
    async execute() { throw new Error('boom'); },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'bin', sessionNonce: '6132-release' });
  const first = await session.facets.emulator.run({});
  assert.equal(first.termination, 'exception');
  const second = await session.facets.emulator.run({});
  assert.equal(second.termination, 'exception');
  await session.close();
}

console.log('issue-6132: PASS');

import assert from 'node:assert/strict';
import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

// #6125: recording must preserve engine-affecting runOptions for faithful replay.
{
  const engine = {
    deterministic: true,
    async execute(_input, options) {
      return { termination: 'return', events: [], value: options.mode ?? 'default' };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: '6125-a' }, { connect: false });
  const first = await session.facets.emulator.run({}, { mode: 'precise', maxSteps: 100, timeoutMs: 1000 });
  assert.equal(first.raw.value, 'precise');
  assert.equal(first.recording.options.mode, 'precise');
  assert.equal(first.recording.options.maxSteps, 100);
  assert.equal(first.recording.options.timeoutMs, 1000);
  assert.equal('signal' in first.recording.options, false);
  const replayed = await session.facets.emulator.replay(first.recording);
  assert.equal(replayed.raw.value, 'precise');
  const overridden = await session.facets.emulator.replay(first.recording, { mode: 'fast' });
  assert.equal(overridden.raw.value, 'fast');
  await session.close();
}

{
  let resumeCalls = 0;
  const engine = {
    deterministic: true,
    async launch() {},
    async resume(options) {
      resumeCalls += 1;
      return { termination: 'return', events: [], value: options.mode ?? 'default' };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: '6125-b' }, { connect: false });
  const first = await session.facets.emulator.run({}, { mode: 'precise' });
  assert.equal(first.raw.value, 'precise');
  const replayed = await session.facets.emulator.replay(first.recording);
  assert.equal(replayed.raw.value, 'precise');
  const callsBeforeReject = resumeCalls;
  await assert.rejects(
    () => session.facets.emulator.run({}, { onProgress() {} }),
    /replay options are not recordable|not replay-recordable/,
  );
  assert.equal(resumeCalls, callsBeforeReject, 'non-recordable callback must be rejected before resume');
  await session.close();
}

{
  let executeCalls = 0;
  const engine = {
    deterministic: true,
    async execute() {
      executeCalls += 1;
      return { termination: 'return', events: [] };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: '6125-callback-execute' }, { connect: false });
  await assert.rejects(
    () => session.facets.emulator.run({}, { onProgress() {} }),
    /replay options are not recordable|not replay-recordable/,
  );
  assert.equal(executeCalls, 0, 'non-recordable callback must be rejected before execute');
  await session.close();
}

{
  const seen = [];
  const engine = {
    deterministic: true,
    async execute(_input, options) {
      seen.push({ ...options });
      return { termination: 'return', events: [] };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: '6125-c' }, { connect: false });
  const controller = new AbortController();
  await session.facets.emulator.run({}, { mode: 'precise', signal: controller.signal });
  assert.equal(seen[0].mode, 'precise');
  assert.ok(seen[0].signal);
  await session.close();
}

console.log('issue-6125: PASS');

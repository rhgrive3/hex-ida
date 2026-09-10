import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

function engine({ id = 'engine-5483', version = '1', architecture = 'arm64' } = {}) {
  let calls = 0;
  return {
    id,
    version,
    deterministic: true,
    descriptor() { return { id, version, architecture, environment: 'test', deterministic: true }; },
    async execute(input) {
      calls += 1;
      return {
        termination: 'return',
        events: [{ kind: 'return', payload: { input, calls } }],
      };
    },
    calls: () => calls,
  };
}

async function recordedRun({ binaryId = 'binary-A', providerId = 'emulator-5483', engineOptions = {} } = {}) {
  const backend = engine(engineOptions);
  const provider = new EmulatorProvider(backend, { id: providerId });
  const session = await provider.openSession({ binaryId, sessionNonce: `source-${binaryId}` }, { connect: false });
  const result = await session.facets.emulator.run({ address: 0x1000n });
  await session.close();
  return { result, backend };
}

test('#5483 recordings bind replay to source binary/provider/engine identity', async () => {
  const { result: first } = await recordedRun();

  assert.equal(first.recording.sourceIdentity.schemaVersion, 'hex-emulator-replay-source/v1');
  assert.equal(first.recording.sourceIdentity.binaryId, 'binary-A');
  assert.equal(first.recording.sourceIdentity.providerId, 'emulator-5483');
  assert.equal(first.recording.sourceIdentity.engine.id, 'engine-5483');
  assert.equal(first.recording.sourceIdentity.engine.version, '1');

  const targetEngine = engine();
  const targetProvider = new EmulatorProvider(targetEngine, { id: 'emulator-5483' });
  const target = await targetProvider.openSession({ binaryId: 'binary-B', sessionNonce: 'target-B' }, { connect: false });
  const before = targetEngine.calls();
  await assert.rejects(
    () => target.facets.emulator.replay(first.recording),
    (error) => error?.code === 'emulator-replay-identity-mismatch',
  );
  assert.equal(targetEngine.calls(), before, 'identity mismatch must reject before engine execution');
  await target.close();
});

test('#5483 same binary and same engine/provider identity remains replayable across sessions', async () => {
  const { result: first } = await recordedRun();
  const targetEngine = engine();
  const targetProvider = new EmulatorProvider(targetEngine, { id: 'emulator-5483' });
  const target = await targetProvider.openSession({ binaryId: 'binary-A', sessionNonce: 'target-A' }, { connect: false });

  const replay = await target.facets.emulator.replay(first.recording);
  assert.equal(replay.termination, 'return');
  assert.equal(targetEngine.calls(), 1);
  assert.equal(replay.recording.sourceIdentity.binaryId, 'binary-A');
  assert.equal(replay.recording.sourceIdentity.providerId, 'emulator-5483');
  assert.ok(replay.evidence.length > 0);
  assert.ok(replay.evidence.every((node) => node.binaryId === 'binary-A'));
  await target.close();
});

test('#5483 missing source identity is rejected instead of being attributed to the current binary', async () => {
  const { result: first } = await recordedRun();
  const legacy = structuredClone(first.recording);
  delete legacy.sourceIdentity;

  const targetEngine = engine();
  const provider = new EmulatorProvider(targetEngine, { id: 'emulator-5483' });
  const session = await provider.openSession({ binaryId: 'binary-A', sessionNonce: 'missing-id' }, { connect: false });
  await assert.rejects(
    () => session.facets.emulator.replay(legacy),
    (error) => error?.code === 'emulator-replay-identity-missing',
  );
  assert.equal(targetEngine.calls(), 0);
  await session.close();
});

test('#5483 engine version and architecture mismatches fail closed before replay', async () => {
  const { result: first } = await recordedRun();
  for (const engineOptions of [
    { version: '2' },
    { architecture: 'x86_64' },
  ]) {
    const targetEngine = engine(engineOptions);
    const provider = new EmulatorProvider(targetEngine, { id: 'emulator-5483' });
    const session = await provider.openSession({ binaryId: 'binary-A', sessionNonce: `mismatch-${engineOptions.version ?? engineOptions.architecture}` }, { connect: false });
    await assert.rejects(
      () => session.facets.emulator.replay(first.recording),
      (error) => error?.code === 'emulator-replay-identity-mismatch',
    );
    assert.equal(targetEngine.calls(), 0);
    await session.close();
  }
});

test('#5483 provider identity mismatch is not treated as the same replay authority', async () => {
  const { result: first } = await recordedRun();
  const targetEngine = engine();
  const provider = new EmulatorProvider(targetEngine, { id: 'different-provider' });
  const session = await provider.openSession({ binaryId: 'binary-A', sessionNonce: 'provider-mismatch' }, { connect: false });
  await assert.rejects(
    () => session.facets.emulator.replay(first.recording),
    (error) => error?.code === 'emulator-replay-identity-mismatch',
  );
  assert.equal(targetEngine.calls(), 0);
  await session.close();
});

test('#5483 local replay without an explicit recording uses the bound lastRun', async () => {
  const backend = engine();
  const provider = new EmulatorProvider(backend, { id: 'emulator-5483' });
  const session = await provider.openSession({ binaryId: 'binary-A', sessionNonce: 'local-last-run' }, { connect: false });
  const first = await session.facets.emulator.run({ address: 0x1000n });
  const replay = await session.facets.emulator.replay();

  assert.equal(first.recording.sourceIdentity.binaryId, 'binary-A');
  assert.equal(replay.recording.sourceIdentity.runtimeSessionId, session.runtimeSessionId);
  assert.equal(backend.calls(), 2);
  await session.close();
});


test('#5483 slice/provider version/environment changes are replay identity mismatches', async () => {
  const sourceEngine = engine();
  const sourceProvider = new EmulatorProvider(sourceEngine, { id: 'emulator-5483', version: '7' });
  const source = await sourceProvider.openSession({ binaryId: 'binary-A', sliceId: 'slice-A', sessionNonce: 'identity-matrix-source' }, { connect: false });
  const first = await source.facets.emulator.run({});
  await source.close();

  const cases = [
    { providerOptions: { id: 'emulator-5483', version: '8' }, request: { binaryId: 'binary-A', sliceId: 'slice-A', sessionNonce: 'provider-version' }, engineOptions: {} },
    { providerOptions: { id: 'emulator-5483', version: '7' }, request: { binaryId: 'binary-A', sliceId: 'slice-B', sessionNonce: 'slice' }, engineOptions: {} },
  ];
  for (const item of cases) {
    const backend = engine(item.engineOptions);
    const provider = new EmulatorProvider(backend, item.providerOptions);
    const session = await provider.openSession(item.request, { connect: false });
    await assert.rejects(
      () => session.facets.emulator.replay(first.recording),
      (error) => error?.code === 'emulator-replay-identity-mismatch',
    );
    assert.equal(backend.calls(), 0);
    await session.close();
  }

  const envBackend = {
    ...engine(),
    descriptor() { return { id: 'engine-5483', version: '1', architecture: 'arm64', environment: 'other', deterministic: true }; },
  };
  const envProvider = new EmulatorProvider(envBackend, { id: 'emulator-5483', version: '7' });
  const envSession = await envProvider.openSession({ binaryId: 'binary-A', sliceId: 'slice-A', sessionNonce: 'environment' }, { connect: false });
  await assert.rejects(
    () => envSession.facets.emulator.replay(first.recording),
    (error) => error?.code === 'emulator-replay-identity-mismatch',
  );
  assert.equal(envBackend.calls(), 0);
  await envSession.close();
});

test('#5483 external source identity is snapshotted once before use', async () => {
  const { result: first } = await recordedRun();
  const external = structuredClone(first.recording);
  let reads = 0;
  const stableIdentity = external.sourceIdentity;
  Object.defineProperty(external, 'sourceIdentity', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? stableIdentity : { ...stableIdentity, binaryId: 'binary-B' };
    },
  });

  const backend = engine();
  const provider = new EmulatorProvider(backend, { id: 'emulator-5483' });
  const session = await provider.openSession({ binaryId: 'binary-A', sessionNonce: 'getter-snapshot' }, { connect: false });
  const replay = await session.facets.emulator.replay(external);
  assert.equal(replay.termination, 'return');
  assert.equal(reads, 1, 'external recording identity getter must be consumed only by the owned snapshot');
  assert.equal(backend.calls(), 1);
  await session.close();
});

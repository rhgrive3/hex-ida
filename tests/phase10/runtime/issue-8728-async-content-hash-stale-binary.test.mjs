import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAppRuntimeIO,
  resetAppRuntime,
  runtimeEvidenceForApp,
  runtimeIdentityForApp,
  runtimePlatformForApp,
  traceAppFunction,
} from '../../../js/runtime/app-runtime.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fileInfo(uuid) {
  return {
    name: `fixture-${uuid}.bin`,
    slices: [{ info: { uuid, architecture: 'arm64' } }],
  };
}

function executableRegion(id) {
  return { id, exec: true, vmAddr: 0x1000n, size: 4n };
}

function makeBackend({ hash = null, file, generation, fetchCalls, hashStarted = null, hashResult = null }) {
  return {
    contentHash: hash,
    file,
    gen: generation,
    transportEpoch: generation,
    async ensureContentHash() {
      hashStarted?.();
      if (hashResult) return hashResult.promise;
      return hash;
    },
    async readAt() { return { found: false, bytes: null }; },
    async fetchChunk() {
      fetchCalls.count += 1;
      return { mn: ['ret'], ops: [''] };
    },
  };
}

function makeSwitchFixture() {
  const hashA = deferred();
  const hashStarted = deferred();
  const fileA = { id: 'file-A' };
  const fileB = { id: 'file-B' };
  const fetchA = { count: 0 };
  const fetchB = { count: 0 };
  const backendA = makeBackend({
    file: fileA,
    generation: 1,
    fetchCalls: fetchA,
    hashStarted: () => hashStarted.resolve(),
    hashResult: hashA,
  });
  const backendB = makeBackend({ hash: 'hash-B', file: fileB, generation: 2, fetchCalls: fetchB });
  let currentInfo = fileInfo('A-UUID');
  let currentFile = fileA;
  let currentRegions = [executableRegion('region-A')];
  const values = new Map([
    ['sliceIndex', 0],
    ['architecture', 'arm64'],
    ['capability', { architecture: 'arm64' }],
  ]);
  const app = {
    store: {
      get(key) {
        if (key === 'fileInfo') return currentInfo;
        if (key === 'file') return currentFile;
        if (key === 'regions') return currentRegions;
        return values.get(key) ?? null;
      },
    },
    backend: backendA,
    symbols: null,
  };
  return {
    app,
    hashStarted: hashStarted.promise,
    resolveHashA(value = 'hash-A') { hashA.resolve(value); },
    switchToB() {
      currentInfo = fileInfo('B-UUID');
      currentFile = fileB;
      currentRegions = [executableRegion('region-B')];
      app.backend = backendB;
    },
    fetchA,
    fetchB,
  };
}

function makeStableSlowFixture() {
  const hash = deferred();
  const started = deferred();
  const file = { id: 'stable-file' };
  const fetchCalls = { count: 0 };
  const backend = makeBackend({
    file,
    generation: 7,
    fetchCalls,
    hashStarted: () => started.resolve(),
    hashResult: hash,
  });
  const info = fileInfo('stable-UUID');
  const app = {
    store: {
      get(key) {
        if (key === 'fileInfo') return info;
        if (key === 'file') return file;
        if (key === 'sliceIndex') return 0;
        if (key === 'architecture') return 'arm64';
        if (key === 'capability') return { architecture: 'arm64' };
        if (key === 'regions') return [executableRegion('stable-region')];
        return null;
      },
    },
    backend,
    symbols: null,
  };
  return { app, started: started.promise, resolveHash: (value) => hash.resolve(value) };
}

test('delayed old content hash cannot be combined with the current slice (#8728)', async () => {
  const fixture = makeSwitchFixture();
  const identityPromise = runtimeIdentityForApp(fixture.app);
  await fixture.hashStarted;

  fixture.switchToB();
  fixture.resolveHashA();

  const identity = await identityPromise;
  assert.deepEqual(identity, {
    contentHash: 'hash-B',
    sliceIdentity: 'slice:0:B-UUID:arm64',
    key: 'hash-B|slice:0:B-UUID:arm64',
  });
});

test('backend generation changes invalidate a delayed hash with stable object references (#8728)', async () => {
  const fixture = makeSwitchFixture();
  const identityPromise = runtimeIdentityForApp(fixture.app);
  await fixture.hashStarted;

  fixture.app.backend.gen = 2;
  fixture.app.backend.transportEpoch = 2;
  fixture.app.backend.contentHash = 'hash-B';
  fixture.resolveHashA();

  assert.deepEqual(await identityPromise, {
    contentHash: 'hash-B',
    sliceIdentity: 'slice:0:A-UUID:arm64',
    key: 'hash-B|slice:0:A-UUID:arm64',
  });
});

test('an old runtime I/O binding fails closed instead of following a switched backend (#8728)', async () => {
  const fixture = makeSwitchFixture();
  fixture.app.backend.contentHash = 'hash-A';
  const io = createAppRuntimeIO(fixture.app);

  fixture.switchToB();

  assert.equal(await io.fetch(0x1000n), null);
  assert.equal(fixture.fetchA.count, 0);
  assert.equal(fixture.fetchB.count, 0, 'a stale I/O binding must not dereference the new backend');
});

test('initial runtime publication binds hash, slice, I/O, and evidence to B (#8728)', async () => {
  const fixture = makeSwitchFixture();
  const platformPromise = runtimePlatformForApp(fixture.app);
  await fixture.hashStarted;

  fixture.switchToB();
  fixture.resolveHashA();

  const platform = await platformPromise;
  try {
    const sliceIdentity = 'slice:0:B-UUID:arm64';
    assert.equal(platform.options.sliceIdentity, sliceIdentity);
    assert.equal(platform.sessions.current?.binaryHash, 'hash-B');

    const trace = await traceAppFunction(fixture.app, 0x1000n, { maxSteps: 8 });
    assert.equal(trace.observation.stop.kind, 'return');
    assert.equal(trace.evidence[0]?.binaryHash, 'hash-B');
    assert.equal(trace.evidence[0]?.sliceIdentity, sliceIdentity);
    assert.equal(fixture.fetchA.count, 0, 'the stale A backend must never serve the published B platform');
    assert.ok(fixture.fetchB.count > 0, 'the accepted B platform must read its bound B backend');
    assert.deepEqual(runtimeEvidenceForApp(fixture.app, 0x1000n), trace.evidence);
  } finally {
    await resetAppRuntime(fixture.app);
  }
});

test('a delayed hash still succeeds when the source binding remains stable (#8728)', async () => {
  const fixture = makeStableSlowFixture();
  const identityPromise = runtimeIdentityForApp(fixture.app);
  await fixture.started;
  fixture.resolveHash('hash-stable');

  assert.deepEqual(await identityPromise, {
    contentHash: 'hash-stable',
    sliceIdentity: 'slice:0:stable-UUID:arm64',
    key: 'hash-stable|slice:0:stable-UUID:arm64',
  });
});

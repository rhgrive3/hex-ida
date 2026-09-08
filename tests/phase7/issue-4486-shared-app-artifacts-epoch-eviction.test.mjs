import assert from 'node:assert/strict';
import {
  __sharedAppArtifactInternalsForTests,
  installSharedAppArtifacts,
} from '../../js/analysis/shared-app-artifacts.js';

console.log('[phase7] running shared app-artifact epoch eviction regression for #4486...');

function stringApp(strings) {
  return {
    backend: { gen: 0, strings },
    store: {
      get: (key) => (key === 'regions'
        ? [{ id: 'r1', section: '__cstring', size: 64n, vmAddr: 0x1000n }]
        : null),
    },
  };
}

function programApp(scanProgram) {
  const symbols = { gen: 0, functionStartsComplete: true };
  const app = {
    backend: { gen: 0, scanProgram },
    store: { get: () => null },
    programRegions: () => [
      { id: 't1', exec: true, size: 16n, section: '__text', vmAddr: 0x2000n },
      { id: 't2', exec: true, size: 16n, section: '__text', vmAddr: 0x3000n },
    ],
    symbols,
  };
  return { app, symbols };
}

{
  let calls = 0;
  const app = stringApp(() => {
    calls++;
    return Promise.resolve({ complete: true, scannedBytes: 8, results: [{ addr: 0x1000n, text: `epoch-${app.backend.gen}` }] });
  });
  installSharedAppArtifacts(app);

  const first = await app.ensureStrings();
  assert.strictEqual(await app.ensureStrings(), first, 'current epoch complete strings must be reused');
  assert.equal(calls, 1);
  assert.deepEqual(__sharedAppArtifactInternalsForTests.cacheSizes(app), { stringEntries: 1, programEntries: 0 });

  for (let epoch = 1; epoch <= 100; epoch++) {
    app.backend.gen = epoch;
    app.stringIndex = null;
    await app.ensureStrings();
    assert.equal(
      __sharedAppArtifactInternalsForTests.cacheSizes(app).stringEntries,
      1,
      `settled string entries must be evicted when epoch ${epoch} becomes active`,
    );
  }
  assert.equal(calls, 101);
}

{
  let calls = 0;
  const { app, symbols } = programApp((regionId) => {
    calls++;
    return Promise.resolve({ regionId });
  });
  installSharedAppArtifacts(app);

  const first = await app.ensureProgram();
  assert.strictEqual(await app.ensureProgram(), first, 'current epoch complete programs must be reused');
  assert.equal(calls, 2, 'the first program scans both executable regions once');
  assert.deepEqual(__sharedAppArtifactInternalsForTests.cacheSizes(app), { stringEntries: 0, programEntries: 1 });

  for (let epoch = 1; epoch <= 100; epoch++) {
    app.backend.gen = epoch;
    symbols.gen = epoch;
    app.program = null;
    app.programKey = null;
    await app.ensureProgram();
    assert.equal(
      __sharedAppArtifactInternalsForTests.cacheSizes(app).programEntries,
      1,
      `settled program entries must be evicted when epoch ${epoch} becomes active`,
    );
  }
  assert.equal(calls, 202);
}

{
  let calls = 0;
  let releaseOld;
  const oldRequest = new Promise((resolve) => { releaseOld = resolve; });
  const app = stringApp(() => {
    calls++;
    if (calls === 1) return oldRequest;
    return Promise.resolve({ complete: true, scannedBytes: 8, results: [{ addr: 0x1000n, text: 'current' }] });
  });
  installSharedAppArtifacts(app);

  const oldConsumer = app.ensureStrings();
  app.backend.gen = 1;
  app.stringIndex = null;
  const currentConsumer = app.ensureStrings();
  assert.equal(
    __sharedAppArtifactInternalsForTests.cacheSizes(app).stringEntries,
    2,
    'an old in-flight entry with a waiter remains until its consumer settles',
  );

  releaseOld({ complete: true, scannedBytes: 8, results: [{ addr: 0x1000n, text: 'old' }] });
  await assert.rejects(oldConsumer, /stale shared strings/);
  await currentConsumer;
  assert.equal(calls, 2, 'the current epoch uses its own producer');
  assert.equal(
    __sharedAppArtifactInternalsForTests.cacheSizes(app).stringEntries,
    1,
    'the old in-flight entry is evicted immediately after it settles',
  );
}

console.log('  ok #4486 shared app-artifact epoch eviction regression passed');

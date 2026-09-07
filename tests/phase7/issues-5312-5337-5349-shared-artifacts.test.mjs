import assert from 'node:assert/strict';
import test from 'node:test';

import { installSharedAppArtifacts } from '../../js/analysis/shared-app-artifacts.js';

/**
 * Shared app-artifact lifecycle: partial results reach their current
 * consumers but must not pin precision for the rest of the epoch, and dead
 * entries must not infect newcomers (#5312, #5337, #5349).
 */

function stringApp(stringsImpl, regions) {
  return {
    backend: { gen: 0, strings: stringsImpl },
    store: {
      get: (key) => (key === 'regions'
        ? regions ?? [{ id: 'r1', section: '__cstring', size: 64n, vmAddr: 0x1000n }]
        : null),
    },
  };
}

function programApp(scanProgram) {
  return {
    backend: { gen: 0, scanProgram },
    store: { get: () => null },
    programRegions: () => [
      { id: 't1', exec: true, size: 16n, section: '__text', vmAddr: 0x2000n },
      { id: 't2', exec: true, size: 16n, section: '__text', vmAddr: 0x3000n },
    ],
    symbols: { gen: 1, functionStartsComplete: true },
  };
}

test('#5337 transient backend partial is retried and upgrades', async () => {
  let attempts = 0;
  const app = stringApp(() => {
    attempts++;
    if (attempts === 1) {
      return Promise.resolve({ complete: false, scannedBytes: 4, results: [{ addr: 0x1000n, text: 'A' }] });
    }
    return Promise.resolve({
      complete: true, scannedBytes: 8,
      results: [{ addr: 0x1000n, text: 'A' }, { addr: 0x1004n, text: 'B' }],
    });
  });
  installSharedAppArtifacts(app);
  const first = await app.ensureStrings();
  assert.equal(first.complete, false, 'the current consumer still receives the partial artifact');
  const second = await app.ensureStrings();
  assert.notEqual(second, first, 'a retryable partial must not be pinned');
  assert.equal(attempts, 2, 'the retry must rescan');
  assert.equal(second.complete, true, 'the retry upgrades to complete');
  const third = await app.ensureStrings();
  assert.equal(third, second, 'the complete artifact is reused without rescanning');
  assert.equal(attempts, 2);
});

test('#5337 deterministic budget truncation stays cached', async () => {
  let calls = 0;
  const app = stringApp(() => {
    calls++;
    return Promise.resolve({ complete: true, scannedBytes: 8, results: [{ addr: 0x1000n, text: 'A' }] });
  }, [{ id: 'big', section: '__cstring', size: 256n * 1024n * 1024n, vmAddr: 0x1000n }]);
  installSharedAppArtifacts(app);
  const first = await app.ensureStrings();
  assert.equal(first.complete, false, 'input-budget truncation is still reported partial');
  const second = await app.ensureStrings();
  assert.equal(second, first, 'deterministic truncation must not rescan on every call');
  assert.equal(calls, 1);
});

test('#5337 concurrent consumers share one strings producer', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = stringApp(() => {
    calls++;
    return gate.then(() => ({ complete: true, scannedBytes: 8, results: [{ addr: 0x1000n, text: 'A' }] }));
  });
  installSharedAppArtifacts(app);
  const pending = [app.ensureStrings(), app.ensureStrings()];
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, 'coalesced callers share one backend scan');
  release();
  const [first, second] = await Promise.all(pending);
  assert.equal(first, second);
});

test('#5349 consumers never attach to a dead entry', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = stringApp(() => {
    calls++;
    return gate.then(() => ({ complete: true, scannedBytes: 8, results: [{ addr: 0x1000n, text: 'A' }] }));
  });
  installSharedAppArtifacts(app);
  const aborter = new AbortController();
  const doomed = app.ensureStrings({ signal: aborter.signal });
  aborter.abort();
  // Same turn: the old producer has not propagated its rejection yet, so the
  // dead entry is still registered. A newcomer must not attach to it.
  const fresh = app.ensureStrings({});
  release();
  await assert.rejects(doomed, (error) => error?.name === 'AbortError');
  const result = await fresh;
  assert.equal(result.complete, true, 'the newcomer must ride a fresh producer, not the old rejection');
  assert.equal(calls, 2);
});

test('#5312 failed program regions are rescanned and upgrade', async () => {
  let attempts = 0;
  const app = programApp((regionId) => {
    attempts++;
    if (attempts === 1) return Promise.reject(new Error('transient'));
    return Promise.resolve({ regionId });
  });
  installSharedAppArtifacts(app);
  const first = await app.ensureProgram();
  assert.equal(first.completeness.complete, false);
  assert.match(first.queryIncompleteReason ?? '', /program-scan-failed/);
  const second = await app.ensureProgram();
  assert.notEqual(second, first, 'a retryable partial program must not be pinned');
  assert.equal(second.completeness.complete, true, 'the retry upgrades to complete');
  assert.equal(second.globalReferenceStats?.complete, true, 'stats track the upgraded coverage');
  const third = await app.ensureProgram();
  assert.equal(third, second, 'the complete program is reused without rescanning');
  assert.equal(attempts, 4, 'exactly one full retry run happened');
});

test('#5312 permanent unsupported programs stay cached', async () => {
  let calls = 0;
  const app = programApp((regionId) => {
    calls++;
    return Promise.resolve({ regionId, unsupported: true });
  });
  installSharedAppArtifacts(app);
  const first = await app.ensureProgram();
  assert.equal(first.completeness.complete, false);
  const second = await app.ensureProgram();
  assert.equal(second, first, 'permanent partials must not rescan on every call');
  assert.equal(calls, 2, 'exactly one run happened');
});

test('#5312 concurrent program consumers share one producer', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = programApp((regionId) => {
    calls++;
    return gate.then(() => ({ regionId }));
  });
  installSharedAppArtifacts(app);
  const pending = [app.ensureProgram(), app.ensureProgram()];
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, 'the second caller joins the in-flight run instead of starting its own');
  release();
  const [first, second] = await Promise.all(pending);
  assert.equal(first, second);
  assert.equal(calls, 2, 'one run scans each region once');
});

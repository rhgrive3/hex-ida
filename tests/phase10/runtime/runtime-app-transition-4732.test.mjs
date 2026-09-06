import assert from 'node:assert/strict';

import {
  resetAppRuntime,
  runtimeEvidenceForApp,
  runtimePlatformForApp,
} from '../../../js/runtime/app-runtime.js';

function makeApp(hash = 'hash-A') {
  let fileInfo = {
    hash,
    slices:[{ info:{ uuid:'slice-1', architecture:'arm64' } }],
  };
  const app = {
    store:{
      get(key) {
        if (key === 'fileInfo') return fileInfo;
        if (key === 'sliceIndex') return 0;
        if (key === 'regions') return [];
        return null;
      },
    },
    backend:{
      async readAt() { return { found:false, bytes:null }; },
      async fetchChunk() { return { mn:[], ops:[] }; },
    },
    symbols:null,
  };
  return {
    app,
    setHash(nextHash) {
      fileInfo = { ...fileInfo, hash:nextHash };
    },
  };
}

function barrierClose(platform) {
  const original = platform.sessions.close.bind(platform.sessions);
  let calls = 0;
  let release;
  let enteredResolve;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  platform.sessions.close = async (id) => {
    calls += 1;
    enteredResolve();
    await gate;
    return original(id);
  };
  return { entered, release, calls:() => calls };
}

// Concurrent callers switching from the same old identity must converge on one
// replacement platform and retire the old session only once.
{
  const { app, setHash } = makeApp();
  const old = await runtimePlatformForApp(app);
  const close = barrierClose(old);
  setHash('hash-B');

  const first = runtimePlatformForApp(app);
  const second = runtimePlatformForApp(app);
  await close.entered;
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  const callsBeforeRelease = close.calls();
  close.release();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(callsBeforeRelease, 1, 'identity transition must single-flight old-state disposal');
  assert.equal(close.calls(), 1);
  assert.equal(a, b, 'same target identity must reuse one replacement platform');
  assert.notEqual(a, old);
  assert.equal(await runtimePlatformForApp(app), a, 'replacement must remain the registered current platform');

  const replacementEvidence = {
    sliceIdentity:a.options.sliceIdentity,
    binaryHash:'hash-B',
    source:'converged-replacement',
  };
  a.evidence.push(replacementEvidence);
  assert.deepEqual(
    runtimeEvidenceForApp(app),
    [replacementEvidence],
    'runtime evidence lookup must observe the converged replacement state',
  );

  // Identity re-read after disposal: changing the hash while the replacement
  // is registered must converge onto a further replacement, not the stale one.
  const closeB = barrierClose(a);
  setHash('hash-C');
  const third = runtimePlatformForApp(app);
  await closeB.entered;
  closeB.release();
  const c = await third;
  assert.notEqual(c, a, 'replacement identity must be re-read after old-state disposal');
  assert.equal(await runtimePlatformForApp(app), c, 're-read replacement must be registered');
  const reReadEvidence = {
    sliceIdentity:c.options.sliceIdentity,
    binaryHash:'hash-C',
    source:'re-read-replacement',
  };
  c.evidence.push(reReadEvidence);
  assert.deepEqual(runtimeEvidenceForApp(app), [reReadEvidence]);

  // A failed transition must not poison the per-app lane: a later valid
  // identity still converges on a fresh replacement.
  setHash('');
  await assert.rejects(() => runtimePlatformForApp(app), /binary identity is unavailable/);
  setHash('hash-D');
  const d = await runtimePlatformForApp(app);
  assert.notEqual(d, c, 'recovery transition must build a fresh platform');
  assert.equal(await runtimePlatformForApp(app), d, 'recovered replacement must remain registered');
  await resetAppRuntime(app);
}

// reset and reopen share the same per-app transition lane: reopening cannot
// return the state while reset is still disposing it.
{
  const { app } = makeApp('hash-reset');
  const old = await runtimePlatformForApp(app);
  const close = barrierClose(old);

  const resetting = resetAppRuntime(app);
  await close.entered;
  let reopenedSettled = false;
  const reopening = runtimePlatformForApp(app).then((platform) => {
    reopenedSettled = true;
    return platform;
  });
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  assert.equal(reopenedSettled, false, 'reopen must wait for in-flight reset disposal');

  close.release();
  assert.equal(await resetting, true);
  const fresh = await reopening;
  assert.notEqual(fresh, old, 'reopen after reset must create a fresh platform');
  assert.equal(await runtimePlatformForApp(app), fresh);
  await resetAppRuntime(app);
}

console.log('runtime app transition serialization #4732: PASS');

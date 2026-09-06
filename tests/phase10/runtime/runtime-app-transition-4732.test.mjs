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

// Old-platform disposal must retire every managed session, not just current.
// With maxSessions:2 the old platform can hold local A + symbolic B live; B
// as current must not orphan A on identity transition or reset.
{
  const { app, setHash } = makeApp('hash-dispose-all');
  const old = await runtimePlatformForApp(app);
  const sessionA = old.sessions.current;
  const sessionB = await old.startSession({ adapter: 'symbolic', binaryHash: 'hash-dispose-all', connect: false });
  assert.equal(old.sessions.sessions.size, 2, 'fixture must hold two live sessions');
  assert.equal(old.sessions.current, sessionB, 'B must be current to prove current-only disposal orphans A');
  let closesA = 0;
  let closesB = 0;
  const origA = sessionA.disconnect.bind(sessionA);
  const origB = sessionB.disconnect.bind(sessionB);
  sessionA.disconnect = async () => { closesA += 1; return origA(); };
  sessionB.disconnect = async () => { closesB += 1; return origB(); };

  setHash('hash-dispose-all-B');
  const fresh = await runtimePlatformForApp(app);
  assert.notEqual(fresh, old, 'identity transition must replace the platform');
  assert.equal(closesA, 1, 'identity transition must close non-current session A exactly once');
  assert.equal(closesB, 1, 'identity transition must close current session B exactly once');
  assert.equal(old.sessions.sessions.size, 0, 'old platform must retain no live sessions after transition');
  assert.equal(old.sessions.current, null);
  await resetAppRuntime(app);
}

{
  const { app } = makeApp('hash-dispose-reset');
  const old = await runtimePlatformForApp(app);
  const sessionA = old.sessions.current;
  await old.startSession({ adapter: 'symbolic', binaryHash: 'hash-dispose-reset', connect: false });
  assert.equal(old.sessions.sessions.size, 2);
  assert.equal(await resetAppRuntime(app), true);
  assert.equal(old.sessions.sessions.size, 0, 'reset must close all live sessions');
  assert.equal(old.sessions.current, null);
  assert.equal(sessionA.closed, true);
}

{
  // One close failure must not stop remaining cleanup (best-effort).
  const { app } = makeApp('hash-dispose-partial');
  const old = await runtimePlatformForApp(app);
  await old.startSession({ adapter: 'symbolic', binaryHash: 'hash-dispose-partial', connect: false });
  const [first, second] = [...old.sessions.sessions.values()];
  let secondClosed = false;
  const origSecond = second.disconnect.bind(second);
  second.disconnect = async () => { secondClosed = true; return origSecond(); };
  first.disconnect = async () => { throw new Error('close-boom'); };
  assert.equal(await resetAppRuntime(app), true);
  assert.equal(secondClosed, true, 'remaining session must still be closed after a sibling failure');
  assert.equal(old.sessions.sessions.size, 0, 'failed session must still be retired from the manager');
}

console.log('runtime app transition serialization #4732: PASS');

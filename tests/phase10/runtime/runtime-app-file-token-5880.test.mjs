import assert from 'node:assert/strict';

import {
  resetAppRuntime,
  runtimeEvidenceForApp,
  runtimePlatformForApp,
} from '../../../js/runtime/app-runtime.js';

function makeApp() {
  let fileInfo = {
    hash:'same-bin',
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
    replaceFileInfo() {
      fileInfo = {
        hash:fileInfo.hash,
        slices:fileInfo.slices.map((slice) => ({
          ...slice,
          info:{ ...slice.info },
        })),
      };
    },
  };
}

{
  const { app, replaceFileInfo } = makeApp();
  const first = await runtimePlatformForApp(app);
  const firstSession = first.sessions.current;
  let closeCalls = 0;
  const originalClose = first.sessions.close.bind(first.sessions);
  first.sessions.close = async (id) => {
    closeCalls += 1;
    return originalClose(id);
  };

  const oldEvidence = {
    binaryHash:'same-bin',
    sliceIdentity:first.options.sliceIdentity,
    function:0x1000n,
    source:'old-file-token',
  };
  first.evidence.push(oldEvidence);
  assert.deepEqual(runtimeEvidenceForApp(app), [oldEvidence]);
  assert.equal(await runtimePlatformForApp(app), first, 'same file token and identity must reuse the platform');

  replaceFileInfo();
  assert.deepEqual(
    runtimeEvidenceForApp(app),
    [],
    'file-token mismatch must fail closed before the runtime context is reopened',
  );

  const second = await runtimePlatformForApp(app);
  assert.notEqual(second, first, 'a new fileInfo token must retire the old runtime context even when hash/slice match');
  assert.equal(closeCalls, 1, 'old runtime session must be disposed exactly once');
  assert.equal(firstSession.closed, true, 'old runtime session must not survive file-token invalidation');
  assert.equal(await runtimePlatformForApp(app), second, 'replacement must be stable for the new file token');

  const replacementEvidence = {
    binaryHash:'same-bin',
    sliceIdentity:second.options.sliceIdentity,
    function:0x1000n,
    source:'new-file-token',
  };
  second.evidence.push(replacementEvidence);
  assert.deepEqual(
    runtimeEvidenceForApp(app),
    [replacementEvidence],
    'evidence lookup must recover on the replacement state instead of remaining permanently empty',
  );

  await resetAppRuntime(app);
}

{
  // File-token replacement must retire every live session, not just current.
  // Old platform holds local A + symbolic B with B current; same hash/slice
  // but a new fileInfo object must close both exactly once with no orphan.
  const { app, replaceFileInfo } = makeApp();
  const first = await runtimePlatformForApp(app);
  const sessionA = first.sessions.current;
  const sessionB = await first.startSession({ adapter: 'symbolic', binaryHash: 'same-bin', connect: false });
  assert.equal(first.sessions.sessions.size, 2, 'fixture must hold two live sessions');
  assert.equal(first.sessions.current, sessionB);
  let closesA = 0;
  let closesB = 0;
  const origA = sessionA.disconnect.bind(sessionA);
  const origB = sessionB.disconnect.bind(sessionB);
  sessionA.disconnect = async () => { closesA += 1; return origA(); };
  sessionB.disconnect = async () => { closesB += 1; return origB(); };

  replaceFileInfo();
  assert.deepEqual(
    runtimeEvidenceForApp(app),
    [],
    'file-token mismatch must fail closed before reopen',
  );
  const second = await runtimePlatformForApp(app);
  assert.notEqual(second, first, 'file-token replacement must retire the old context');
  assert.equal(closesA, 1, 'non-current session A must be closed exactly once on file-token replacement');
  assert.equal(closesB, 1, 'current session B must be closed exactly once on file-token replacement');
  assert.equal(first.sessions.sessions.size, 0, 'old platform must retain no live sessions');
  assert.equal(first.sessions.current, null);
  assert.equal(await runtimePlatformForApp(app), second, 'replacement must be stable');

  await resetAppRuntime(app);
}

console.log('runtime app file-token invalidation #5880: PASS');

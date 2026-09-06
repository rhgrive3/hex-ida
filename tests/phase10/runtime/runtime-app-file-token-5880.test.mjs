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

console.log('runtime app file-token invalidation #5880: PASS');

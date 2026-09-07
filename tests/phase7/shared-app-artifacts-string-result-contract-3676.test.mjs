import assert from 'node:assert/strict';
import test from 'node:test';

import { installSharedAppArtifacts } from '../../js/analysis/shared-app-artifacts.js';

const region = Object.freeze({ id:'r1', section:'__cstring', cstrings:true, size:64n, vmAddr:0x1000n });

function stringApp(stringsImpl) {
  return {
    backend:{ gen:0, strings:stringsImpl },
    store:{
      get(key) {
        if (key === 'regions') return [region];
        if (key === 'currentRegion') return region;
        return null;
      },
    },
  };
}

test('#3676 canonical backend string rows remain complete', async () => {
  const app = stringApp(() => Promise.resolve({
    complete:true,
    scannedBytes:8,
    results:[
      { addr:0x1000n, offset:0, text:'Alpha' },
      { addr:0x1008n, offset:8, text:'Beta' },
    ],
  }));
  installSharedAppArtifacts(app);

  const rows = await app.ensureStrings();
  assert.equal(rows.complete, true);
  assert.equal(rows.truncated, false);
  assert.equal(rows.truncationReason, null);
  assert.deepEqual(rows.map(({ addr, text }) => ({ addr, text })), [
    { addr:0x1000n, text:'Alpha' },
    { addr:0x1008n, text:'Beta' },
  ]);
});

test('#3676 non-Array result containers fail closed without generic iteration', async () => {
  for (const malformed of ['AB', new Uint8Array([1, 2]), new Set([{ addr:0x1000n, text:'A' }]), {}]) {
    const app = stringApp(() => Promise.resolve({ complete:true, scannedBytes:4, results:malformed }));
    installSharedAppArtifacts(app);

    const rows = await app.ensureStrings();
    assert.equal(rows.length, 0);
    assert.equal(rows.complete, false);
    assert.equal(rows.truncated, true);
    assert.equal(rows.truncationReason, 'backend-malformed');
    assert.deepEqual(rows.skippedRegions, ['r1']);
    assert.deepEqual(rows.unscannedRegions, ['r1']);
  }
});

test('#3676 result container authority is snapshotted once', async () => {
  let resultReads = 0;
  const backendResult = {
    complete:true,
    scannedBytes:4,
    get results() {
      resultReads++;
      if (resultReads === 1) return [{ addr:0x1000n, text:'Stable' }];
      return {};
    },
  };
  const app = stringApp(() => Promise.resolve(backendResult));
  installSharedAppArtifacts(app);

  const rows = await app.ensureStrings();
  assert.equal(resultReads, 1);
  assert.equal(rows.complete, true);
  assert.deepEqual(rows.map(({ addr, text }) => ({ addr, text })), [
    { addr:0x1000n, text:'Stable' },
  ]);
});

test('#3676 row authority is snapshotted once and accessor failures fail closed', async () => {
  let addrReads = 0;
  let textReads = 0;
  const drifting = new Proxy({}, {
    get(_target, key) {
      if (key === 'addr') {
        addrReads++;
        return addrReads <= 2 ? 0x1000n : -1n;
      }
      if (key === 'text') {
        textReads++;
        return textReads === 1 ? 'Stable' : 'Drifted';
      }
      return undefined;
    },
  });
  const throwing = new Proxy({}, {
    get(_target, key) {
      if (key === 'addr') return 0x1008n;
      if (key === 'text') throw new Error('backend row accessor failed');
      return undefined;
    },
  });
  const app = stringApp(() => Promise.resolve({
    complete:true,
    scannedBytes:8,
    results:[drifting, throwing],
  }));
  installSharedAppArtifacts(app);

  const rows = await app.ensureStrings();
  assert.equal(addrReads, 1);
  assert.equal(textReads, 1);
  assert.deepEqual(rows.map(({ addr, text }) => ({ addr, text })), [
    { addr:0x1000n, text:'Stable' },
  ]);
  assert.equal(rows.complete, false);
  assert.equal(rows.truncated, true);
  assert.equal(rows.truncationReason, 'backend-malformed');
  assert.deepEqual(rows.skippedRegions, ['r1']);
});

test('#3676 malformed rows are excluded and the incomplete artifact retries', async () => {
  let attempts = 0;
  const app = stringApp(() => {
    attempts++;
    if (attempts === 1) {
      return Promise.resolve({
        complete:true,
        scannedBytes:16,
        results:[
          { addr:0x1000n, text:'A' },
          null,
          { addr:0x1004n },
          { addr:0x1008, text:'number-address' },
          { addr:0x100cn, text:'B' },
        ],
      });
    }
    return Promise.resolve({
      complete:true,
      scannedBytes:16,
      results:[
        { addr:0x1000n, text:'A' },
        { addr:0x100cn, text:'B' },
      ],
    });
  });
  installSharedAppArtifacts(app);

  const first = await app.ensureStrings();
  assert.deepEqual(first.map(({ addr, text }) => ({ addr, text })), [
    { addr:0x1000n, text:'A' },
    { addr:0x100cn, text:'B' },
  ]);
  assert.equal(first.complete, false);
  assert.equal(first.truncationReason, 'backend-malformed');
  assert.deepEqual(first.skippedRegions, ['r1']);

  const second = await app.ensureStrings();
  assert.notEqual(second, first);
  assert.equal(attempts, 2);
  assert.equal(second.complete, true);
  assert.equal(second.truncationReason, null);

  const third = await app.ensureStrings();
  assert.equal(third, second);
  assert.equal(attempts, 2);
});

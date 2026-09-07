import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressAwareApi as createApi, executableRegionForAddress } from '../js/script-hardened.js';

function fakeApp() {
  const regions = [
    { id:'A', exec:true, vmAddr:0x1000n, size:0x1000n, fileOff:0n },
    { id:'B', exec:true, vmAddr:0x5000n, size:0x1000n, fileOff:0x1000n },
  ];
  const fetched = [];
  const app = {
    store:{ get(key) {
      if (key === 'regions') return regions;
      if (key === 'architecture') return 'arm64';
      if (key === 'file') return { size:0x4000 };
      if (key === 'fileInfo') return {};
      return null;
    } },
    currentSlice:() => ({ capability:{ architecture:'arm64' } }),
    codeRegion:() => regions[0],
    symbols:{ functionList:() => [], nameAt:() => null, label:() => null, rename:() => {}, functionAt:() => null, setFunctionRegions:() => {} },
    notes:{ setName:() => {}, setComment:() => {}, comment:() => null, nameOf:() => null },
    viewer:{ setSymbols:() => {} },
    patches:{ add:() => {} },
    backend:{
      async fetchChunk(regionId, chunk) {
        fetched.push({ regionId, chunk });
        const mn = new Array(1024), ops = new Array(1024);
        mn[64] = 'nop'; ops[64] = '';
        return { mn, ops };
      },
      async readAt() { return { found:true, bytes:new Uint8Array([0,0,0,0]) }; },
    },
  };
  return { app, regions, fetched };
}

test('executableRegionForAddress resolves the actual secondary owner and never falls back', () => {
  const { app, regions } = fakeApp();
  assert.equal(executableRegionForAddress(app, 0x5100n), regions[1]);
  assert.equal(executableRegionForAddress(app, 0x9000n), null);
});

test('fixed-width disasm fetches the chunk from the address-owning region', async () => {
  const { app, fetched } = fakeApp();
  const { api } = createApi(app, () => {});
  const rows = await api.disasm(0x5100n, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].addr, 0x5100n);
  assert.deepEqual(fetched, [{ regionId:'B', chunk:0 }]);
});

test('unmapped disasm is explicit unsupported rather than a false empty result', async () => {
  const { app, fetched } = fakeApp();
  const { api } = createApi(app, () => {});
  const result = await api.disasm(0x9000n, 1);
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'address-not-in-executable-region');
  assert.deepEqual(fetched, []);
});

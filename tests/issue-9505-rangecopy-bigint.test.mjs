import assert from 'node:assert/strict';
import test from 'node:test';
import { buildText } from '../js/rangecopy.js';
import { CodeViewer } from '../js/viewer.js';

function classList() {
  return { toggle() {}, add() {}, remove() {} };
}

function installDom() {
  globalThis.__HEX_UI_ROOT__ = { classList: classList(), style: { setProperty() {} } };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
}

test('issue #9505: buildFixedText handles BigInt selection row numbers without TypeError', async () => {
  const region = {
    id: 'arm-large',
    vmAddr: 0x1_0000_0000n,
    fileOffset: 0x1000n,
    size: 0x10_0000n,
    disasm: true,
    capability: { architecture: 'arm64', fixedInstructionSize: 4 },
  };

  const fetchedChunks = [];
  const app = {
    viewer: {
      isVariableAsm: () => false,
      architectureId: () => 'arm64',
      fixedInstructionSize: () => 4,
      rowAddress: (r) => region.vmAddr + BigInt(r) * 4n,
    },
    store: {
      get: (k) => {
        if (k === 'currentRegion') return region;
        if (k === 'hexJoined') return false;
        if (k === 'canDisassemble') return true;
        return null;
      },
    },
    symbols: { gen: 0, nameAt: () => null },
    backend: {
      platformInfo: { capability: region.capability },
      fetchChunk: async (regId, chunkIdx, wantAsm) => {
        fetchedChunks.push(chunkIdx);
        return {
          bytes: new Uint8Array([0x1f, 0x20, 0x03, 0xd5, 0xc0, 0x03, 0x5f, 0xd6]),
          mn: ['nop', 'ret'],
          ops: ['', ''],
        };
      },
    },
    setBusy: () => {},
  };

  // Selection with BigInt start and end representing rows in large binary
  const sel = { start: 0n, end: 1n, count: 2n };
  const text = await buildText(app, region, sel, 'all', true);
  const lines = text.split('\n');

  assert.equal(lines.length, 2);
  assert.match(lines[0], /100000000/i);
  assert.match(lines[0], /1F 20 03 D5/i);
  assert.match(lines[0], /nop/i);
  assert.match(lines[1], /100000004/i);
  assert.match(lines[1], /C0 03 5F D6/i);
  assert.match(lines[1], /ret/i);
  assert.deepEqual(fetchedChunks, [0]);

  // Large BigInt row selection across chunks
  fetchedChunks.length = 0;
  const bigStart = 1024n * 50n; // Chunk 50, row 0
  const bigEnd = bigStart + 1n; // Chunk 50, row 1
  const selBig = { start: bigStart, end: bigEnd, count: 2n };
  const textBig = await buildText(app, region, selBig, 'all', true);
  const linesBig = textBig.split('\n');

  assert.equal(linesBig.length, 2);
  assert.deepEqual(fetchedChunks, [50]);
});

test('issue #9505: CodeViewer.selectionRange computes count correctly when anchor/focus are BigInt', () => {
  installDom();
  const viewport = { clientHeight: 500, scrollTop: 0, classList: classList(), addEventListener() {}, removeEventListener() {} };
  const backend = { platformInfo: { capability: { architecture: 'arm64', fixedInstructionSize: 4 } }, legacyInfo: null };
  const viewer = new CodeViewer({ viewport, rows: { appendChild() {}, style: {} }, backend });

  viewer.totalRows = Number.MAX_SAFE_INTEGER;
  viewer.totalRowsBig = BigInt(Number.MAX_SAFE_INTEGER) + 1000n;
  viewer.selAnchor = 100n;
  viewer.selFocus = 105n;

  const sel = viewer.selectionRange();
  assert.ok(sel);
  assert.equal(sel.start, 100n);
  assert.equal(sel.end, 105n);
  assert.equal(sel.count, 6n);

  viewer.dispose();
});

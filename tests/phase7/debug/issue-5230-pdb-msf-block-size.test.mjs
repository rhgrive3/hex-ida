import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMsf } from '../../../js/analysis/debug/pdb.js';

const MAGIC = new TextEncoder().encode('Microsoft C/C++ MSF 7.00\r\n\u001aDS\0\0\0');

function minimalMsf(blockSize) {
  const blockCount = 3;
  const bytes = new Uint8Array(blockSize * blockCount);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint32(32, blockSize, true);
  view.setUint32(36, 1, true); // FreeBlockMapBlock
  view.setUint32(40, blockCount, true);
  view.setUint32(44, 4, true); // directory contains only NumStreams
  view.setUint32(52, 1, true); // block map in block 1
  view.setUint32(blockSize, 2, true); // directory lives in block 2
  view.setUint32(blockSize * 2, 0, true); // NumStreams = 0
  return bytes;
}

test('#5230 rejects power-of-two MSF block sizes outside the format domain', () => {
  for (const blockSize of [64, 128, 256, 8192]) {
    const parsed = parseMsf(minimalMsf(blockSize));
    assert.equal(parsed.complete, false, `blockSize=${blockSize}`);
    assert.deepEqual(parsed.streams, [], `blockSize=${blockSize}`);
    assert.ok(parsed.diagnostics.some((item) => item.includes('invalid MSF block size')), JSON.stringify(parsed.diagnostics));
  }
});

test('#5230 keeps every MSF 7.00 block size supported by the format', () => {
  for (const blockSize of [512, 1024, 2048, 4096]) {
    const parsed = parseMsf(minimalMsf(blockSize));
    assert.equal(parsed.complete, true, `blockSize=${blockSize}: ${parsed.diagnostics.join('; ')}`);
    assert.equal(parsed.blockSize, blockSize);
    assert.equal(parsed.streams.length, 0);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMsf } from '../../../js/analysis/debug/pdb.js';

// Issue #5672: parseMsf never read the superblock's FreeBlockMapBlock field
// (offset 36). The LLVM MSF format documentation allows only the values 1 or
// 2 — anything else must fail closed instead of reaching complete:true.

const MSF_MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\u001aDS\0\0\0';

function msf(freeBlockMapBlock) {
  const blockSize = 0x200;
  const bytes = new Uint8Array(blockSize * 8);
  bytes.set(new TextEncoder().encode(MSF_MAGIC), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(32, blockSize, true);
  view.setUint32(36, freeBlockMapBlock, true);
  view.setUint32(40, 8, true);
  view.setUint32(44, 4, true);
  view.setUint32(52, 1, true);
  view.setUint32(blockSize, 2, true);      // block map -> block 2
  view.setUint32(blockSize * 2, 0, true);  // directory: numStreams=0
  return bytes;
}

test('#5672 an out-of-spec FreeBlockMapBlock fails closed', () => {
  for (const value of [0, 3, 99, 0xffffffff]) {
    const result = parseMsf(msf(value));
    assert.equal(result.complete, false, `FreeBlockMapBlock=${value} must not reach complete:true`);
    assert.deepEqual(result.streams, []);
    assert.ok(
      result.diagnostics.some((d) => d.includes('free block map')),
      `FreeBlockMapBlock=${value} reports the typed diagnostic`,
    );
  }
});

test('#5672 the spec-legal FreeBlockMapBlock values keep parsing', () => {
  for (const value of [1, 2]) {
    const result = parseMsf(msf(value));
    assert.equal(result.complete, true, `FreeBlockMapBlock=${value} stays valid`);
    assert.deepEqual(result.streams, []);
    assert.deepEqual(result.diagnostics, []);
  }
});

console.log('issue #5672 MSF free-block-map-index regression: ok');

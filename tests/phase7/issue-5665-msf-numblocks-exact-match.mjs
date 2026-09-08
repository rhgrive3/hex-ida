// Issue #5665 regression (both directions): the MSF superblock's NumBlocks
// must equal the actual file block count. A declared count one block past the
// file end previously slipped through the `> data.length + blockSize`
// tolerance, and an under-declared count hid part of the file.
import assert from 'node:assert/strict';
import { parseMsf } from '../../js/analysis/debug/pdb.js';

function msfBytes({ fileBlocks, declaredBlocks }) {
  const blockSize = 512;
  const bytes = new Uint8Array(blockSize * fileBlocks);
  bytes.set(new TextEncoder().encode('Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0'), 0);
  const v = new DataView(bytes.buffer);
  v.setUint32(32, blockSize, true);
  v.setUint32(36, 1, true);
  v.setUint32(40, declaredBlocks, true);
  v.setUint32(44, 4, true);
  v.setUint32(52, 3, true);
  // block 3 -> directory block 4; directory: NumStreams = 0
  v.setUint32(blockSize * 3, 4, true);
  v.setUint32(blockSize * 4, 0, true);
  return bytes;
}

// Over-declared by exactly one block: previously admitted, now rejected.
{
  const parsed = parseMsf(msfBytes({ fileBlocks: 5, declaredBlocks: 6 }));
  assert.equal(parsed.complete, false, 'a NumBlocks one past the file must be rejected');
  assert.deepEqual(parsed.streams, []);
  assert.ok(parsed.diagnostics.length >= 1, 'a superblock/file-size mismatch must be diagnosed');
}

// Under-declared count: same rejection, other direction.
{
  const parsed = parseMsf(msfBytes({ fileBlocks: 6, declaredBlocks: 5 }));
  assert.equal(parsed.complete, false, 'an under-declared NumBlocks must be rejected');
  assert.ok(parsed.diagnostics.length >= 1);
}

// A matching NumBlocks keeps the container complete.
{
  const parsed = parseMsf(msfBytes({ fileBlocks: 6, declaredBlocks: 6 }));
  assert.equal(parsed.complete, true, 'a consistent container stays complete');
  assert.deepEqual(parsed.diagnostics, []);
}

console.log('Issue #5665 MSF NumBlocks exact-match regressions PASS');

// Issue #5672 regression: the MSF 7.00 superblock's FreeBlockMapBlock (offset
// 36) names the active free-block map and the spec only permits the value 1 or
// 2. A container declaring an out-of-spec value (e.g. 99) is structurally
// invalid and must never be admitted with complete:true.
import assert from 'node:assert/strict';
import { parseMsf } from '../../js/analysis/debug/pdb.js';

function msfBytes(freeBlockMapBlock) {
  const blockSize = 512;
  const bytes = new Uint8Array(blockSize * 5);
  bytes.set(new TextEncoder().encode('Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0'), 0);
  const v = new DataView(bytes.buffer);
  v.setUint32(32, blockSize, true);          // BlockSize
  v.setUint32(36, freeBlockMapBlock, true);  // FreeBlockMapBlock
  v.setUint32(40, 5, true);                  // NumBlocks (matches file length)
  v.setUint32(44, 4, true);                  // NumDirectoryBytes
  v.setUint32(52, 3, true);                  // BlockMapAddr -> block 3
  // block 3 -> directory block 4; directory holds NumStreams = 0
  v.setUint32(blockSize * 3, 4, true);
  v.setUint32(blockSize * 4, 0, true);
  return bytes;
}

// Out-of-spec FreeBlockMapBlock values must fail closed even when every other
// superblock field and the whole directory are structurally consistent.
for (const bad of [0, 3, 99, 0xffffffff]) {
  const parsed = parseMsf(msfBytes(bad));
  assert.equal(parsed.complete, false, `FreeBlockMapBlock=${bad} must not be admitted as complete`);
  assert.deepEqual(parsed.streams, [], `FreeBlockMapBlock=${bad} must yield no streams`);
  assert.ok(parsed.diagnostics.length >= 1, `FreeBlockMapBlock=${bad} must report a diagnostic`);
}

// The two spec-permitted values stay valid.
for (const good of [1, 2]) {
  const parsed = parseMsf(msfBytes(good));
  assert.equal(parsed.complete, true, `FreeBlockMapBlock=${good} must remain a complete container`);
  assert.deepEqual(parsed.diagnostics, [], `FreeBlockMapBlock=${good} must not produce diagnostics`);
}

console.log('Issue #5672 MSF FreeBlockMapBlock validation regressions PASS');

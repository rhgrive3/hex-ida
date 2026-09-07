import assert from 'node:assert/strict';

import { parseMsf } from '../../../js/analysis/debug/pdb.js';

const MSF_MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\u001aDS\0\0\0';

function msfWithDirectoryBytes(numDirectoryBytes) {
  const blockSize = 0x200;
  const bytes = new Uint8Array(blockSize * 8);
  bytes.set(new TextEncoder().encode(MSF_MAGIC), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(32, blockSize, true);
  view.setUint32(40, 8, true);
  view.setUint32(44, numDirectoryBytes, true);
  view.setUint32(52, 1, true);
  view.setUint32(blockSize, 2, true);       // block map -> block 2
  view.setUint32(blockSize * 2, 0, true);  // minimum 4-byte directory: numStreams=0
  return bytes;
}

for (const directoryBytes of [0, 1, 2, 3]) {
  const result = parseMsf(msfWithDirectoryBytes(directoryBytes));
  assert.equal(result.complete, false, `${directoryBytes}-byte directory must fail closed`);
  assert.deepEqual(result.streams, []);
  assert.equal(
    result.diagnostics.includes('MSF stream directory is truncated'),
    true,
    `${directoryBytes}-byte directory must report truncation`,
  );
}

{
  const result = parseMsf(msfWithDirectoryBytes(4));
  assert.equal(result.complete, true, 'minimum directory containing numStreams remains valid');
  assert.deepEqual(result.streams, []);
  assert.deepEqual(result.diagnostics, []);
}

console.log('pdb MSF directory boundary #3862: PASS');

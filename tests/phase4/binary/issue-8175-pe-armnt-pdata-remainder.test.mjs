import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { parseExceptionFunctions } from '../../../js/binary/pe-loader.js';

const ARMNT = 0x01c4;

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, true);
}

function packedArm() {
  return (1 | (2 << 2) | (1 << 20)) >>> 0;
}

function parseRemainder(size) {
  const bytes = new Uint8Array(128);
  writeU32(bytes, 0, 0x2001);
  writeU32(bytes, 4, packedArm());
  const image = new BinaryImage(bytes, { format:'pe', bits:32, imageBase:0n });
  image.metadata.machine = ARMNT;
  image.addSection({
    name:'.pdata', address:0x1000n, size:15n, fileOffset:0n, fileSize:15n,
    perms:{ read:true, write:false, execute:false },
  });
  image.addSection({
    name:'.text', address:0x2000n, size:0x40n, fileOffset:64n, fileSize:0x40n,
    perms:{ read:true, write:false, execute:true },
  });
  parseExceptionFunctions(new ByteView(bytes), { rva:0x1000, size }, image, ARMNT);
  return image;
}

for (let tail = 1; tail <= 7; tail++) {
  const image = parseRemainder(8 + tail);
  assert.equal(image.functions.length, 0, `tail ${tail} must publish no function authority`);
  assert.equal(image.metadata.exceptionDirectory?.fragments?.length ?? 0, 0, `tail ${tail} must publish no fragment authority`);
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.equal(image.metadata.peMetadata?.reasons?.includes('exception:directory-record-remainder'), true);
}

console.log('issue-8175 ARMNT .pdata remainder authority regression: PASS');

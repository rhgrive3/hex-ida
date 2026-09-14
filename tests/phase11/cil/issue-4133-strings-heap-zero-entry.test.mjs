import assert from 'node:assert/strict';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';

function buildPeCliFixture(stringsBytes, { stringsSize = 0x20 } = {}) {
  const bytes = new Uint8Array(0x500);
  const view = new DataView(bytes.buffer);
  const peOffset = 0x80;
  const optionalOffset = peOffset + 24;
  const sectionTableOffset = optionalOffset + 0xe0;
  const metadataOffset = 0x248;

  bytes.set([0x4d, 0x5a], 0);
  view.setUint32(0x3c, peOffset, true);
  bytes.set([0x50, 0x45, 0x00, 0x00], peOffset);
  view.setUint16(peOffset + 6, 1, true);
  view.setUint16(peOffset + 20, 0xe0, true);

  view.setUint16(optionalOffset, 0x10b, true);
  view.setUint32(optionalOffset + 92, 15, true);
  const cliDirectoryOffset = optionalOffset + 96 + 14 * 8;
  view.setUint32(cliDirectoryOffset, 0x1000, true);
  view.setUint32(cliDirectoryOffset + 4, 72, true);

  view.setUint32(sectionTableOffset + 8, 0x300, true);
  view.setUint32(sectionTableOffset + 12, 0x1000, true);
  view.setUint32(sectionTableOffset + 16, 0x300, true);
  view.setUint32(sectionTableOffset + 20, 0x200, true);

  const cliOffset = 0x200;
  view.setUint32(cliOffset, 72, true);
  view.setUint32(cliOffset + 8, 0x1048, true);
  view.setUint32(cliOffset + 12, 0x100, true);

  view.setUint32(metadataOffset, 0x424a5342, true);
  view.setUint32(metadataOffset + 12, 12, true);
  bytes.set(new TextEncoder().encode('v4.0.30319\0\0'), metadataOffset + 16);

  const flagsOffset = metadataOffset + 28;
  view.setUint16(flagsOffset + 2, 2, true);
  const streamHeader = flagsOffset + 4;

  view.setUint32(streamHeader, 0x80, true);
  view.setUint32(streamHeader + 4, stringsSize, true);
  bytes.set(new TextEncoder().encode('#Strings\0'), streamHeader + 8);

  const secondStream = streamHeader + 20;
  view.setUint32(secondStream, 0xa0, true);
  view.setUint32(secondStream + 4, 0x18, true);
  bytes.set(new TextEncoder().encode('#~\0'), secondStream + 8);

  bytes.set(stringsBytes, metadataOffset + 0x80);
  return bytes;
}

const valid = buildPeCliFixture(Uint8Array.from([0x00, 0x41, 0x00]));
assert.equal(probeCil(valid).supported, true, 'a present #Strings heap beginning with the reserved empty entry stays valid');
assert.deepEqual(parseCil(valid).strings, ['A']);

for (const firstByte of [0x41, 0xe3]) {
  const malformed = buildPeCliFixture(Uint8Array.from([firstByte, 0x00]));
  assert.equal(
    probeCil(malformed).supported,
    false,
    `#Strings heap index 0 must be the reserved empty string (first byte 0x${firstByte.toString(16)})`,
  );
  assert.throws(
    () => parseCil(malformed),
    /cil-unsupported-binary/,
    'malformed #Strings heap must not enter the managed image',
  );
}

const emptyPresentHeap = buildPeCliFixture(new Uint8Array(), { stringsSize: 0 });
assert.equal(probeCil(emptyPresentHeap).supported, false, 'a present zero-sized #Strings heap cannot contain the required index-0 empty entry');
assert.throws(() => parseCil(emptyPresentHeap), /cil-unsupported-binary/);

console.log('issue-4133 CIL #Strings index-0 contract regression: ok');

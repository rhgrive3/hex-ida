import assert from 'node:assert/strict';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';

console.log('[phase11] running CIL #Strings UTF-8 regression (#3764)...');

function buildMetadataFixture(stringsBytes) {
  const bytes = new Uint8Array(0x200);
  const view = new DataView(bytes.buffer);
  const metadataOffset = 0x100;

  bytes.set([0x42, 0x53, 0x4a, 0x42], metadataOffset); // BSJB
  view.setUint16(metadataOffset + 4, 1, true);
  view.setUint16(metadataOffset + 6, 1, true);
  view.setUint32(metadataOffset + 12, 12, true);
  bytes.set(new TextEncoder().encode('v4.0.30319\0\0'), metadataOffset + 16);

  const flagsOffset = metadataOffset + 28;
  view.setUint16(flagsOffset + 2, 1, true);
  const streamHeader = flagsOffset + 4;
  view.setUint32(streamHeader, 0x40, true);
  view.setUint32(streamHeader + 4, 0x20, true);
  bytes.set(new TextEncoder().encode('#Strings\0'), streamHeader + 8);
  bytes.set(stringsBytes, metadataOffset + 0x40);
  return bytes;
}

function buildPeCliFixture(stringsBytes) {
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
  view.setUint32(cliOffset + 8, 0x1048, true);
  view.setUint32(cliOffset + 12, 0x100, true);

  view.setUint32(metadataOffset, 0x424a5342, true);
  view.setUint32(metadataOffset + 12, 12, true);
  bytes.set(new TextEncoder().encode('v4.0.30319\0\0'), metadataOffset + 16);

  const flagsOffset = metadataOffset + 28;
  view.setUint16(flagsOffset + 2, 2, true);
  const streamHeader = flagsOffset + 4;

  view.setUint32(streamHeader, 0x80, true);
  view.setUint32(streamHeader + 4, 0x20, true);
  bytes.set(new TextEncoder().encode('#Strings\0'), streamHeader + 8);

  const secondStream = streamHeader + 20;
  view.setUint32(secondStream, 0xa0, true);
  view.setUint32(secondStream + 4, 0x18, true);
  bytes.set(new TextEncoder().encode('#~\0'), secondStream + 8);

  bytes.set(stringsBytes, metadataOffset + 0x80);
  return bytes;
}

const valid = parseCil(buildMetadataFixture(Uint8Array.from([
  0x00,
  0xe3, 0x81, 0x82, 0x00, // あ
  0x41, 0x53, 0x43, 0x49, 0x49, 0x00, // ASCII
])));
assert.deepEqual(valid.strings, ['あ', 'ASCII']);

assert.throws(
  () => parseCil(buildMetadataFixture(Uint8Array.from([0x00, 0xe3, 0x28, 0xa1, 0x00]))),
  /cil-invalid-strings-utf8/,
);
assert.throws(
  () => parseCil(buildMetadataFixture(Uint8Array.from([0x00, 0xe3, 0x81, 0x00]))),
  /cil-invalid-strings-utf8/,
);

const structuralBytes = buildPeCliFixture(Uint8Array.from([
  0x00, 0xef, 0xbb, 0xbf, 0x41, 0x00, // U+FEFF + A
]));
assert.equal(probeCil(structuralBytes).supported, true);
const structural = parseCil(structuralBytes);
assert.deepEqual(structural.strings, ['\uFEFFA']);

assert.throws(
  () => parseCil(buildPeCliFixture(Uint8Array.from([0x00, 0xe3, 0x28, 0xa1, 0x00]))),
  /cil-invalid-strings-utf8/,
);

console.log('  ok CIL #Strings UTF-8 regression passed');

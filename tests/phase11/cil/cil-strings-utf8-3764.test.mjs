import assert from 'node:assert/strict';
import { parseCil } from '../../../js/managed/cil/parser.js';

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

console.log('  ok CIL #Strings UTF-8 regression passed');

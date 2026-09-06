import assert from 'node:assert/strict';
import { parseCil } from '../../../js/managed/cil/parser.js';

function align4(offset) {
  return (offset + 3) & ~3;
}

function buildRawMetadata({ versionLength = 5, rootOffset = 0, totalSize = 0x100 } = {}) {
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);

  bytes.set([0x42, 0x53, 0x4a, 0x42], rootOffset); // BSJB
  view.setUint16(rootOffset + 4, 1, true);
  view.setUint16(rootOffset + 6, 1, true);
  view.setUint32(rootOffset + 12, versionLength, true);
  bytes[rootOffset + 16] = 0x76; // v
  bytes[rootOffset + 17] = 0x31; // 1

  const flagsOffset = align4(rootOffset + 16 + versionLength);
  view.setUint16(flagsOffset, 0, true);
  view.setUint16(flagsOffset + 2, 1, true);

  const streamHeader = flagsOffset + 4;
  view.setUint32(streamHeader, 0x50, true);
  view.setUint32(streamHeader + 4, 0x10, true);
  bytes.set(new TextEncoder().encode('#Strings\0'), streamHeader + 8);

  const stringsOffset = rootOffset + 0x50;
  bytes.set([0, ...new TextEncoder().encode('Aligned'), 0], stringsOffset);
  return { bytes, flagsOffset, streamHeader };
}

for (const versionLength of [4, 5, 8, 9]) {
  const { bytes } = buildRawMetadata({ versionLength });
  const parsed = parseCil(bytes);
  assert.equal(parsed.vmSpecEdition, 'v1');
  assert.deepEqual(parsed.strings, ['Aligned']);
}

{
  const { bytes } = buildRawMetadata({ versionLength: 5, rootOffset: 0x40, totalSize: 0xc0 });
  const versionEnd = 0x40 + 16 + 5;
  assert.throws(
    () => parseCil(bytes.slice(0, versionEnd - 1)),
    /cil-metadata-version-truncated/,
  );
}

{
  const { bytes, flagsOffset } = buildRawMetadata({ versionLength: 5, rootOffset: 0x40, totalSize: 0xc0 });
  assert.throws(
    () => parseCil(bytes.slice(0, flagsOffset + 2)),
    /cil-metadata-stream-header-truncated/,
  );
}

{
  const { bytes, streamHeader } = buildRawMetadata({ versionLength: 5, rootOffset: 0x40, totalSize: 0xc0 });
  assert.throws(
    () => parseCil(bytes.slice(0, streamHeader + 7)),
    /cil-metadata-stream-header-truncated/,
  );
}

{
  const { bytes, streamHeader } = buildRawMetadata();
  new DataView(bytes.buffer).setUint32(streamHeader, 0xfffffff0, true);
  assert.throws(
    () => parseCil(bytes),
    /cil-metadata-stream-out-of-bounds/,
  );
}

{
  const { bytes, streamHeader } = buildRawMetadata();
  const view = new DataView(bytes.buffer);
  view.setUint32(streamHeader, 0xfffffff0, true);
  bytes.set(new TextEncoder().encode('#Blob\0'), streamHeader + 8);
  assert.throws(
    () => parseCil(bytes),
    /cil-metadata-stream-out-of-bounds/,
  );
}

console.log('[phase11] CIL raw metadata alignment #3819 passed');

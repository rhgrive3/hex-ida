import assert from 'node:assert/strict';
import { parseDynamicSymbolVersions } from '../../js/binary/elf-extended.js';

const DT_VERSYM = 0x6ffffff0n;
const DT_VERDEF = 0x6ffffffcn;
const DT_VERDEFNUM = 0x6ffffffdn;
const BASE = 0x1000n;
const VERDEF_OFFSET = 16;

function writeU16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}
function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
function reader(bytes) {
  return {
    u16(offset) { return bytes[offset] | (bytes[offset + 1] << 8); },
    u32(offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0; },
  };
}
function parseVerdef({ cnt, aux, fileSize = 64, names = new Map([[1n, 'FAKE_VER'], [12n, 'HEADER_ALIAS'], [7n, 'VER_OK']]) }) {
  const bytes = new Uint8Array(fileSize);
  writeU16(bytes, 0, 2); // DT_VERSYM[0] -> version index 2.
  writeU16(bytes, VERDEF_OFFSET, 1); // vd_version
  writeU16(bytes, VERDEF_OFFSET + 4, 2); // vd_ndx
  writeU16(bytes, VERDEF_OFFSET + 6, cnt); // vd_cnt
  writeU32(bytes, VERDEF_OFFSET + 12, aux); // vd_aux
  writeU32(bytes, VERDEF_OFFSET + 16, 0); // vd_next
  if (aux >= 20 && VERDEF_OFFSET + aux + 8 <= bytes.length) {
    writeU32(bytes, VERDEF_OFFSET + aux, 7); // vda_name
    writeU32(bytes, VERDEF_OFFSET + aux + 4, 0); // vda_next
  }
  const image = {
    segments: [{ address: BASE, fileOffset: 0, fileSize }],
    metadata: {},
    warnings: [],
  };
  const tags = new Map([
    [DT_VERSYM, [BASE]],
    [DT_VERDEF, [BASE + BigInt(VERDEF_OFFSET)]],
    [DT_VERDEFNUM, [1n]],
  ]);
  const out = parseDynamicSymbolVersions(reader(bytes), tags, image, 1, (offset) => names.get(offset) ?? null);
  return { out, image };
}

{
  const { out, image } = parseVerdef({ cnt: 0, aux: 0 });
  assert.equal(out.get(0)?.name, null, 'vd_cnt=0/vd_aux=0 must not reinterpret the Verdef header as Verdaux');
  assert.equal(out.get(0)?.definition, null);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.equal(image.metadata.symbolVersions.complete, false);
}

{
  const { out, image } = parseVerdef({ cnt: 1, aux: 12 });
  assert.equal(out.get(0)?.name, null, 'vd_aux inside the 20-byte Verdef header must be rejected');
  assert.equal(image.metadata.programDynamicPartial, true);
}

{
  const { out, image } = parseVerdef({ cnt: 1, aux: 20, fileSize: 40 });
  assert.equal(out.get(0)?.name, null, 'first Verdaux must fit entirely in the mapped file-backed range');
  assert.equal(image.metadata.programDynamicPartial, true);
}

{
  const { out, image } = parseVerdef({ cnt: 1, aux: 20 });
  assert.deepEqual(out.get(0), { index: 2, hidden: false, name: 'VER_OK', library: null, definition: true });
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.deepEqual(image.metadata.symbolVersions, { entries: 1, named: 1, complete: true });
}

console.log('issue #3645 DT_VERDEF auxiliary contract regression PASS');

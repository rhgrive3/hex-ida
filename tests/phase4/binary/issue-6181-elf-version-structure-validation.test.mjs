import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDynamicSymbolVersions } from '../../../js/binary/elf-extended.js';

// #6181: `parseDynamicSymbolVersions()` ignored the Verdef/Verneed structure
// version fields (`vd_version`/`vn_version`) entirely, so a record declaring
// version 0 (VER_DEF_NONE / VER_NEED_NONE, invalid per the ELF versioning ABI)
// or any future revision was still decoded with the v1 layout and its names
// were promoted to canonical symbol version metadata. Fail closed instead.

const DT_VERSYM = 0x6ffffff0n;
const DT_VERDEF = 0x6ffffffcn;
const DT_VERDEFNUM = 0x6ffffffdn;
const DT_VERNEED = 0x6ffffffen;
const DT_VERNEEDNUM = 0x6fffffffn;
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
function parseVersions({ verdefVersion = null, verneedVersion = null, names = new Map([[7n, 'DEF_VER'], [11n, 'NEED_NAME'], [9n, 'libneed.so']]) }) {
  const bytes = new Uint8Array(64);
  writeU16(bytes, 0, 2); // DT_VERSYM[0] -> version index 2 (definition)
  if (verdefVersion != null) {
    writeU16(bytes, VERDEF_OFFSET, verdefVersion); // vd_version
    writeU16(bytes, VERDEF_OFFSET + 4, 2); // vd_ndx
    writeU16(bytes, VERDEF_OFFSET + 6, 1); // vd_cnt
    writeU32(bytes, VERDEF_OFFSET + 12, 20); // vd_aux
    writeU32(bytes, VERDEF_OFFSET + 16, 0); // vd_next
    writeU32(bytes, VERDEF_OFFSET + 20, 7); // vda_name
    writeU32(bytes, VERDEF_OFFSET + 24, 0); // vda_next
  }
  if (verneedVersion != null) {
    writeU16(bytes, 0, 3); // DT_VERSYM[0] -> version index 3 (needed)
    writeU16(bytes, VERDEF_OFFSET, verneedVersion); // vn_version
    writeU16(bytes, VERDEF_OFFSET + 2, 1); // vn_cnt
    writeU32(bytes, VERDEF_OFFSET + 4, 9); // vn_file
    writeU32(bytes, VERDEF_OFFSET + 8, 16); // vn_aux
    writeU32(bytes, VERDEF_OFFSET + 12, 0); // vn_next
    writeU16(bytes, VERDEF_OFFSET + 16 + 6, 3); // vna_other
    writeU32(bytes, VERDEF_OFFSET + 16 + 8, 11); // vna_name
    writeU32(bytes, VERDEF_OFFSET + 16 + 12, 0); // vna_next
  }
  const image = { segments: [{ address: BASE, fileOffset: 0, fileSize: 64 }], metadata: {}, warnings: [] };
  const tags = new Map();
  if (verdefVersion != null) {
    tags.set(DT_VERDEF, [BASE + BigInt(VERDEF_OFFSET)]);
    tags.set(DT_VERDEFNUM, [1n]);
  }
  if (verneedVersion != null) {
    tags.set(DT_VERNEED, [BASE + BigInt(VERDEF_OFFSET)]);
    tags.set(DT_VERNEEDNUM, [1n]);
  }
  tags.set(DT_VERSYM, [BASE]);
  const out = parseDynamicSymbolVersions(reader(bytes), tags, image, 1, (offset) => names.get(offset) ?? null);
  return { out, image };
}

test('#6181: Verdef with vd_version=0 (VER_DEF_NONE) mints no version evidence', () => {
  const { out, image } = parseVersions({ verdefVersion: 0 });
  assert.equal(out.get(0)?.name, null);
  assert.equal(out.get(0)?.definition, null);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.equal(image.metadata.symbolVersions.complete, false);
});

test('#6181: Verneed with vn_version=0 (VER_NEED_NONE) mints no version evidence', () => {
  const { out, image } = parseVersions({ verneedVersion: 0 });
  assert.equal(out.get(0)?.name, null);
  assert.equal(out.get(0)?.library, null);
  assert.equal(out.get(0)?.definition, null);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.equal(image.metadata.symbolVersions.complete, false);
});

test('#6181: an unknown Verdef structure revision is not reinterpreted as v1', () => {
  const { out, image } = parseVersions({ verdefVersion: 2 });
  assert.equal(out.get(0)?.name, null);
  assert.equal(image.metadata.programDynamicPartial, true);
});

test('#6181: an unknown Verneed structure revision is not reinterpreted as v1', () => {
  const { out, image } = parseVersions({ verneedVersion: 2 });
  assert.equal(out.get(0)?.name, null);
  assert.equal(image.metadata.programDynamicPartial, true);
});

test('#6181: current revision 1 records still parse with full evidence', () => {
  const def = parseVersions({ verdefVersion: 1 });
  assert.deepEqual(def.out.get(0), { index: 2, hidden: false, name: 'DEF_VER', library: null, definition: true });
  assert.equal(def.image.metadata.programDynamicPartial, undefined);
  assert.deepEqual(def.image.metadata.symbolVersions, { entries: 1, named: 1, complete: true });

  const need = parseVersions({ verneedVersion: 1 });
  assert.deepEqual(need.out.get(0), { index: 3, hidden: false, name: 'NEED_NAME', library: 'libneed.so', definition: false });
  assert.equal(need.image.metadata.programDynamicPartial, undefined);
  assert.deepEqual(need.image.metadata.symbolVersions, { entries: 1, named: 1, complete: true });
});

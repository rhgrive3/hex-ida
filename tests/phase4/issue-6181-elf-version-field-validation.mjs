// Regression for #6181: DT_VERDEF/DT_VERNEED records carry a structure version
// field at offset 0 that must equal 1 (ELF gABI). A non-1 version is a layout
// this decoder does not understand — it must produce a partial diagnostic and
// skip the record, never reinterpret bytes as a canonical version mapping.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDynamicSymbolVersions } from '../../js/binary/elf-extended.js';

const DT_VERSYM = 0x6ffffff0n;
const DT_VERDEF = 0x6ffffffcn;
const DT_VERDEFNUM = 0x6ffffffdn;
const DT_VERNEED = 0x6ffffffen;
const DT_VERNEEDNUM = 0x6fffffffn;
const BASE = 0x10000000n;
const VERSYM_OFF = 0x2000;
const VERDEF_OFF = 0x20;

function build({ defVersion = 1, needVersion = 1 } = {}) {
  const bytes = new Uint8Array(0x4000);
  const dv = new DataView(bytes.buffer);
  const writeVerdef = (offset, version, ndx) => {
    dv.setUint16(offset, version, true);
    dv.setUint16(offset + 2, 0, true); // vd_flags
    dv.setUint16(offset + 4, ndx, true);
    dv.setUint16(offset + 6, 1, true); // vd_cnt
    dv.setUint32(offset + 12, 20, true); // vd_aux
    dv.setUint32(offset + 16, 0, true); // vd_next
    dv.setUint32(offset + 20, 7, true); // vda_name -> file offset 7 ('VER\0')
    dv.setUint32(offset + 24, 0, true);
  };
  writeVerdef(VERDEF_OFF, defVersion, 2);
  const needOffset = 0x60;
  dv.setUint16(0x1000, 2, true); // VERSYM[0] -> index 2
  bytes.set([0x56, 0x45, 0x52, 0x53, 0x49, 0x4f, 0x4e, 0], 7); // "VERSION\0" at file offset 7
  dv.setUint16(needOffset, needVersion, true); // vn_version
  dv.setUint16(needOffset + 2, 1, true); // vn_cnt
  dv.setUint32(needOffset + 4, 0x1050, true); // vn_file
  dv.setUint32(needOffset + 8, 16, true); // vn_aux
  dv.setUint32(needOffset + 12, 0, true); // vn_next
  const aux = needOffset + 16; // Vernaux: hash(4) flags(2) other(2) name(4) next(4)
  dv.setUint32(aux, 0, true); // vna_hash
  dv.setUint16(aux + 4, 0, true); // vna_flags
  dv.setUint16(aux + 6, 2, true); // vna_other (ndx 2)
  dv.setUint32(aux + 8, 7, true); // vna_name -> 'VERSION'
  dv.setUint32(aux + 12, 0, true); // vna_next

  const image = { warnings: [], metadata: {}, segments: [{ address: BASE, fileOffset: 0n, fileSize: BigInt(bytes.length) }] };
  const tags = new Map([
    [DT_VERSYM, [BASE + BigInt(VERSYM_OFF)]],
    [DT_VERDEF, [BASE + BigInt(VERDEF_OFF)]], [DT_VERDEFNUM, [1n]],
    [DT_VERNEED, [BASE + BigInt(needOffset)]], [DT_VERNEEDNUM, [1n]],
  ]);
  const reader = { length: bytes.length, u16: (o) => dv.getUint16(o, true), u32: (o) => dv.getUint32(o, true) };
  parseDynamicSymbolVersions(reader, tags, image, 1, (offset) => {
    const name = [];
    for (let i = Number(offset); i < bytes.length; i++) { const b = bytes[i]; if (!b) break; name.push(b); }
    return name.length ? String.fromCharCode(...name) : '';
  });
  return image;
}

function namedEntries(image) {
  return [...(image.metadata.symbolVersions ? image.metadata.symbolVersions.entries >= 0 ? [] : [] : [])];
}

test('#6181 a Verdef record with a non-1 version is rejected as partial', () => {
  const image = build({ defVersion: 0 });
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.match((image.metadata.programDynamicDiagnostics ?? []).join('\n'), /DT_VERDEF record version is not 1/);
});

test('#6181 a Verneed record with a non-1 version is rejected as partial', () => {
  const image = build({ needVersion: 2 });
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.match((image.metadata.programDynamicDiagnostics ?? []).join('\n'), /DT_VERNEED record version is not 1/);
});

test('#6181 spec-compliant version fields keep decoding complete', () => {
  const image = build({ defVersion: 1, needVersion: 1 });
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.equal(image.metadata.symbolVersions.complete, true);
});

test('#6181 a spec-compliant Verdef alone decodes complete', () => {
  const bytes = new Uint8Array(0x4000);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0x1000, 2, true); // VERSYM[0] -> index 2
  dv.setUint16(0x20, 1, true); // vd_version
  dv.setUint16(0x24, 2, true); // vd_ndx
  dv.setUint16(0x26, 1, true); // vd_cnt
  dv.setUint32(0x2c, 20, true); // vd_aux
  dv.setUint32(0x30, 0, true); // vd_next
  dv.setUint32(0x34, 7, true); // vda_name
  dv.setUint32(0x38, 0, true); // vda_next
  bytes.set([0x56, 0x45, 0x52, 0x53, 0x49, 0x4f, 0x4e, 0], 7);
  const image = { warnings: [], metadata: {}, segments: [{ address: BASE, fileOffset: 0n, fileSize: BigInt(bytes.length) }] };
  parseDynamicSymbolVersions(
    { length: bytes.length, u16: (o) => dv.getUint16(o, true), u32: (o) => dv.getUint32(o, true) },
    new Map([[DT_VERSYM, [BASE + 0x1000n]], [DT_VERDEF, [BASE + 0x20n]], [DT_VERDEFNUM, [1n]]]),
    image,
    1,
    (offset) => { const out = []; for (let i = Number(offset); i < bytes.length; i++) { const b = bytes[i]; if (!b) break; out.push(b); } return out.length ? String.fromCharCode(...out) : ''; },
  );
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.equal(image.metadata.symbolVersions.complete, true);
  assert.ok(image.metadata.symbolVersions.named >= 1);
});

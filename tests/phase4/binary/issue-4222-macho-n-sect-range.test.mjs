/**
 * #4222 — `N_SECT` binds a symbol to a section ordinal.  A `n_sect` outside the
 * parsed section table cannot prove defined-section truth, so it must not
 * become a canonical symbol or export.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMachO } from '../../../js/binary/macho.js';

const N_UNDF = 0x00;
const N_ABS = 0x02;
const N_SECT = 0x0e;
const N_EXT = 0x01;
const REASON = 'symbol-invalid-section-index';

function okName() {
  return Uint8Array.from([0, 0x5f, 0x6f, 0x6b, 0]);
}

function buildMachO({ bits = 64, entries }) {
  const magic = bits === 64 ? 0xfeedfacf : 0xfeedface;
  const cputype = bits === 64 ? 0x0100000c : 12;
  const headerSize = bits === 64 ? 32 : 28;
  const segmentCommandSize = bits === 64 ? 72 : 56;
  const sectionRecordSize = bits === 64 ? 80 : 68;
  const nlistSize = bits === 64 ? 16 : 12;
  const base = bits === 64 ? 0x100000000n : 0x1000n;

  const symoff = 0x200;
  const stroff = symoff + entries.length * nlistSize;
  const strings = okName();
  const bytes = new Uint8Array(stroff + strings.length);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, magic, true);
  view.setInt32(4, cputype, true);
  view.setInt32(8, 0, true);
  view.setUint32(12, 2, true); // MH_DYLIB
  const writeAt = (position, value) => (bits === 64 ? view.setBigUint64(position, BigInt(value), true) : view.setUint32(position, Number(value), true));

  let p = headerSize;
  view.setUint32(p, bits === 64 ? 0x19 : 0x1, true);
  view.setUint32(p + 4, segmentCommandSize + sectionRecordSize, true);
  view.setUint8(p + 8, 0x5f, true); view.setUint8(p + 9, 0x54, true); view.setUint8(p + 10, 0x45, true); view.setUint8(p + 11, 0x58, true); view.setUint8(p + 12, 0x54, true);
  writeAt(p + 24, base);
  writeAt(p + (bits === 64 ? 32 : 28), 0x1000);
  writeAt(p + (bits === 64 ? 40 : 32), 0);
  writeAt(p + (bits === 64 ? 48 : 36), symoff);
  view.setInt32(p + (bits === 64 ? 56 : 40), 5, true);
  view.setInt32(p + (bits === 64 ? 60 : 44), 5, true);
  view.setUint32(p + (bits === 64 ? 64 : 48), 1, true);
  p += segmentCommandSize;

  view.setUint8(p, 0x5f, true); view.setUint8(p + 1, 0x74, true); view.setUint8(p + 2, 0x65, true); view.setUint8(p + 3, 0x78, true); view.setUint8(p + 4, 0x74, true);
  view.setUint8(p + 16, 0x5f, true); view.setUint8(p + 17, 0x54, true); view.setUint8(p + 18, 0x45, true); view.setUint8(p + 19, 0x58, true); view.setUint8(p + 20, 0x54, true);
  writeAt(p + 32, base);
  writeAt(p + (bits === 64 ? 40 : 36), 0x100);
  view.setUint32(p + (bits === 64 ? 48 : 40), 0x20, true);
  view.setUint32(p + (bits === 64 ? 64 : 56), 0x80000400, true); // S_REGULAR | S_ATTR_PURE_INSTRUCTIONS
  p += sectionRecordSize;

  view.setUint32(p, 0x2, true); // LC_SYMTAB
  view.setUint32(p + 4, 24, true);
  view.setUint32(p + 8, symoff, true);
  view.setUint32(p + 12, entries.length, true);
  view.setUint32(p + 16, stroff, true);
  view.setUint32(p + 20, strings.length, true);
  view.setUint32(16, 2, true); // ncmds
  view.setUint32(20, p + 24 - headerSize, true); // sizeofcmds

  entries.forEach((entry, i) => {
    const q = symoff + i * nlistSize;
    view.setUint32(q, entry.strx ?? 1, true);
    view.setUint8(q + 4, entry.type, true);
    view.setUint8(q + 5, entry.sect ?? 1, true);
    view.setUint16(q + 6, entry.desc ?? 0, true);
    if (bits === 64) view.setBigUint64(q + 8, entry.value ?? base + 0x10n, true);
    else view.setUint32(q + 8, Number(entry.value ?? base + 0x10n), true);
  });
  bytes.set(strings, stroff);
  return bytes;
}

function testNames(image) {
  return {
    symbols:image.symbols.map((entry) => entry.name),
    exports:image.exports.map((entry) => entry.name),
  };
}

for (const bits of [64, 32]) {
  test(`#4222 nlist${bits}: an in-range N_SECT ordinal keeps defined/export truth`, () => {
    const image = parseMachO(buildMachO({ bits, entries:[{ type:N_SECT | N_EXT, sect:1 }] }));
    assert.equal(image.symbols.length, 1);
    assert.equal(image.symbols[0].defined, true);
    assert.equal(image.symbols[0].kind, 'section');
    assert.equal(image.symbols[0].sectionIndex, 1);
    assert.deepEqual(testNames(image).exports, ['_ok']);
    assert.equal(image.metadata.machoMetadata.complete, true);
    assert.ok(!image.metadata.machoMetadata.reasons.includes(REASON));
  });

  for (const sect of [0, 2, 255]) {
    test(`#4222 nlist${bits}: N_SECT with n_sect ${sect} is partial, never defined/export truth`, () => {
      const image = parseMachO(buildMachO({ bits, entries:[{ type:N_SECT | N_EXT, sect }] }));
      assert.deepEqual(testNames(image), { symbols:[], exports:[] });
      assert.equal(image.functions.some((seed) => seed.name === '_ok'), false);
      assert.equal(image.metadata.machoMetadata.complete, false);
      assert.ok(image.metadata.machoMetadata.reasons.includes(REASON), JSON.stringify(image.metadata.machoMetadata.reasons));
      assert.ok(image.warnings.some((warning) => /n_sect/.test(warning)), JSON.stringify(image.warnings));
    });
  }

  test(`#4222 nlist${bits}: an executable-looking n_value cannot be laundered through a bad n_sect`, () => {
    const image = parseMachO(buildMachO({ bits, entries:[{ type:N_SECT | N_EXT, sect:99, value:0x100000020n }] }));
    assert.equal(image.exports.length, 0);
    assert.equal(image.functions.length, 0);
    assert.equal(image.symbols.length, 0);
  });

  test(`#4222 nlist${bits}: N_ABS and N_UNDF keep their own section-ordinal semantics`, () => {
    const absolute = parseMachO(buildMachO({ bits, entries:[{ type:N_ABS | N_EXT, sect:0 }] }));
    assert.equal(absolute.symbols.length, 1);
    assert.equal(absolute.symbols[0].defined, true);
    assert.deepEqual(testNames(absolute).exports, ['_ok']);
    assert.equal(absolute.metadata.machoMetadata.complete, true);

    const imported = parseMachO(buildMachO({ bits, entries:[{ type:N_UNDF | N_EXT, sect:0, value:0n, desc:2 << 8 }] }));
    assert.equal(imported.symbols.length, 1);
    assert.equal(imported.symbols[0].defined, false);
    assert.equal(imported.imports.length, 1);
    assert.equal(imported.imports[0].name, '_ok');
    assert.equal(imported.exports.length, 0);
    assert.equal(imported.metadata.machoMetadata.complete, true);
  });

  test(`#4222 nlist${bits}: a conforming ordinal survives beside a violating one`, () => {
    const image = parseMachO(buildMachO({ bits, entries:[
      { type:N_SECT | N_EXT, sect:1, strx:1 },
      { type:N_SECT | N_EXT, sect:7, strx:1 },
    ] }));
    assert.deepEqual(image.symbols.map((entry) => entry.sectionIndex), [1]);
    assert.deepEqual(image.exports.map((entry) => entry.address), image.symbols.map((entry) => entry.address));
  });
}

test('#4222: a section table is required before an ordinal can be checked', () => {
  const symoff = 0x80;
  const stroff = symoff + 16;
  const bytes = new Uint8Array(stroff + 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setInt32(4, 0x0100000c, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 24, true);
  view.setUint32(32, 0x2, true);
  view.setUint32(36, 24, true);
  view.setUint32(40, symoff, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, stroff, true);
  view.setUint32(52, 4, true);
  view.setUint32(symoff, 1, true);
  view.setUint8(symoff + 4, N_SECT | N_EXT);
  view.setUint8(symoff + 5, 1);
  view.setBigUint64(symoff + 8, 0x1000n, true);
  bytes.set(Uint8Array.from([0, 0x61, 0x74, 0]), stroff);

  const image = parseMachO(bytes);
  assert.equal(image.sections.length, 0);
  assert.equal(image.symbols.length, 1);
  assert.equal(image.metadata.machoMetadata.complete, true);
});

/**
 * #3989 — ELF string-table reference contract.
 *
 * `st_name` / DT_NEEDED / DT_SONAME offsets are indices into their declared
 * string table.  An offset at or beyond the declared table size is a
 * malformed reference: it must be recorded as a metadata/dynamic partial and
 * the entry skipped best-effort, never collapsed into normal "no name" /
 * "no dependency" absence.  Offsets inside the table (including ones that
 * point at a NUL and therefore decode to the legitimate empty string) must
 * stay complete.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../../js/binary/reader.js';
import { parseELF } from '../../../js/binary/elf.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const EM_X86_64 = 62;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_DYNSYM = 11;
const SHT_STRTAB = 3;
const SHT_DYNAMIC = 6;
const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_STRSZ = 10n;
const DT_SONAME = 14n;
const BASE = 0x400000n;

function writeDynamic64(view, offset, entries) {
  entries.forEach(([tag, value], i) => {
    const p = offset + i * 16;
    view.setBigInt64(p, BigInt(tag), true);
    view.setBigUint64(p + 8, BigInt(value), true);
  });
  return entries.length * 16;
}

function writeSection64(view, shoff, index, { type = 0, offset = 0, size = 0, link = 0, entsize = 0 } = {}) {
  const p = shoff + index * 64;
  view.setUint32(p + 4, type, true);
  view.setBigUint64(p + 24, BigInt(offset), true);
  view.setBigUint64(p + 32, BigInt(size), true);
  view.setUint32(p + 40, link, true);
  view.setBigUint64(p + 56, BigInt(entsize), true);
}

function writeElfHeader64(view, { shoff, shnum }) {
  const bytes = new Uint8Array(view.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 3, true); // ET_DYN
  view.setUint16(18, EM_X86_64, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(40, BigInt(shoff), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 0, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, shnum, true);
  view.setUint16(62, 0, true);
}

/* ---------- section-backed SHT_DYNAMIC ---------- */

function shtDynamicImage(entries) {
  const dynamicOff = 0x80;
  const strOff = 0xc0;
  const shoff = 0x100;
  const bytes = new Uint8Array(shoff + 3 * 64);
  const view = new DataView(bytes.buffer);
  writeElfHeader64(view, { shoff, shnum: 3 });
  bytes.set(new TextEncoder().encode('\0libx.so\0soname.so\0'), strOff);
  const dynamicSize = writeDynamic64(view, dynamicOff, entries);
  writeSection64(view, shoff, 0);
  writeSection64(view, shoff, 1, { type: SHT_STRTAB, offset: strOff, size: 20 });
  writeSection64(view, shoff, 2, { type: SHT_DYNAMIC, offset: dynamicOff, size: dynamicSize, link: 1, entsize: 16 });
  return parseELF(bytes);
}

const SHT_REASON = 'dynamic-section:2:string-reference-range';

test('#3989 SHT_DYNAMIC: in-range DT_NEEDED/DT_SONAME stay complete', () => {
  const image = shtDynamicImage([[DT_NEEDED, 1n], [DT_SONAME, 9n], [DT_NULL, 0n]]);
  assert.equal(image.metadata.elfMetadata.complete, true, JSON.stringify(image.metadata.elfMetadata));
  assert.deepEqual(image.libraries, ['libx.so']);
  assert.equal(image.metadata.soname, 'soname.so');
  assert.ok(!image.metadata.elfMetadata.reasons.includes(SHT_REASON));
});

test('#3989 SHT_DYNAMIC: in-range offset at a NUL is a valid empty string, not a range error', () => {
  const image = shtDynamicImage([[DT_NEEDED, 0n], [DT_SONAME, 8n], [DT_NULL, 0n]]);
  assert.equal(image.metadata.elfMetadata.complete, true, JSON.stringify(image.metadata.elfMetadata));
  assert.deepEqual(image.libraries, []);
});

test('#3989 SHT_DYNAMIC: DT_NEEDED offset == strtab size is partial', () => {
  const image = shtDynamicImage([[DT_NEEDED, 20n], [DT_NULL, 0n]]);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes(SHT_REASON), JSON.stringify(image.metadata.elfMetadata.reasons));
  assert.deepEqual(image.libraries, []);
});

test('#3989 SHT_DYNAMIC: DT_SONAME offset beyond strtab size is partial', () => {
  const image = shtDynamicImage([[DT_SONAME, 25n], [DT_NULL, 0n]]);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes(SHT_REASON), JSON.stringify(image.metadata.elfMetadata.reasons));
  assert.equal(image.metadata.soname, undefined);
});

/* ---------- section-backed SHT_SYMTAB / SHT_DYNSYM st_name ---------- */

function symtabImage(symtabType, stNames) {
  const strOff = 0x40;
  const symOff = 0x80;
  const shoff = 0x100;
  const sectionCount = 3;
  const bytes = new Uint8Array(shoff + sectionCount * 64);
  const view = new DataView(bytes.buffer);
  writeElfHeader64(view, { shoff, shnum: sectionCount });
  bytes.set(new TextEncoder().encode('\0abc\0'), strOff);
  stNames.forEach((stName, i) => {
    const p = symOff + i * 24;
    view.setUint32(p, stName, true);
    view.setUint8(p + 4, i === 0 ? 0 : (1 << 4) | 1);
    view.setUint16(p + 6, i === 0 ? 0 : 1, true);
  });
  writeSection64(view, shoff, 0);
  writeSection64(view, shoff, 1, { type: SHT_STRTAB, offset: strOff, size: 5 });
  writeSection64(view, shoff, 2, { type: symtabType, offset: symOff, size: stNames.length * 24, link: 1, entsize: 24 });
  return parseELF(bytes);
}

test('#3989 SHT_SYMTAB: valid st_name (0 at NUL, size-1 at NUL) stays complete', () => {
  const image = symtabImage(SHT_SYMTAB, [0, 4]);
  assert.equal(image.metadata.elfMetadata.complete, true, JSON.stringify(image.metadata.elfMetadata));
});

test('#3989 SHT_SYMTAB: st_name == strtab size is partial, symbol skipped', () => {
  const image = symtabImage(SHT_SYMTAB, [0, 5]);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('symbols:2:name-offset-range'), JSON.stringify(image.metadata.elfMetadata.reasons));
  assert.equal(image.symbols.find((s) => s.index === 1), undefined);
});

test('#3989 SHT_DYNSYM: st_name beyond strtab size is partial', () => {
  const image = symtabImage(SHT_DYNSYM, [0, 9]);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('symbols:2:name-offset-range'), JSON.stringify(image.metadata.elfMetadata.reasons));
});

/* ---------- PT_DYNAMIC (elf-dynamic stringAt) ---------- */

function ptDynamicImage(entries) {
  const strOff = 0x100;
  const dynamicOff = 0x40;
  const bytes = new Uint8Array(0x200);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('\0libok.so\0libfoo.so\0'), strOff);
  const dynamicSize = writeDynamic64(view, dynamicOff, entries);
  const segment = {
    name: 'LOAD', address: BASE, size: BigInt(bytes.length),
    fileOffset: 0n, fileSize: BigInt(bytes.length),
    perms: { read: true, write: false, execute: false },
  };
  const image = {
    bits: 64,
    imageBase: BASE,
    metadata: { machine: EM_X86_64 },
    warnings: [],
    libraries: [],
    imports: [],
    exports: [],
    symbols: [],
    relocations: [],
    functions: [],
    sections: [],
    segments: [segment],
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < BigInt(bytes.length) ? delta : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const a = BigInt(address);
      return a >= segment.address && a < segment.address + segment.size ? segment : null;
    },
  };
  parseProgramDynamic(new ByteView(bytes), [{ type: 2, offset: BigInt(dynamicOff), filesz: BigInt(dynamicSize) }], image, 64);
  return image;
}

const PT_DIAGNOSTIC = 'dynamic string table reference is out of range';

test('#3989 PT_DYNAMIC: in-range DT_NEEDED/DT_SONAME stay complete', () => {
  const image = ptDynamicImage([
    [DT_NEEDED, 1n], [DT_SONAME, 10n],
    [DT_STRTAB, BASE + BigInt(0x100)], [DT_STRSZ, 21n], [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, undefined, JSON.stringify(image.metadata.programDynamicDiagnostics));
  assert.deepEqual(image.libraries, ['libok.so']);
  assert.equal(image.metadata.soname, 'libfoo.so');
});

test('#3989 PT_DYNAMIC: in-range NUL-targeting offset is a valid empty reference', () => {
  const image = ptDynamicImage([
    [DT_NEEDED, 0n],
    [DT_STRTAB, BASE + BigInt(0x100)], [DT_STRSZ, 21n], [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, undefined, JSON.stringify(image.metadata.programDynamicDiagnostics));
  assert.deepEqual(image.libraries, []);
});

test('#3989 PT_DYNAMIC: DT_NEEDED offset == DT_STRSZ is partial', () => {
  const image = ptDynamicImage([
    [DT_NEEDED, 21n],
    [DT_STRTAB, BASE + BigInt(0x100)], [DT_STRSZ, 21n], [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok((image.metadata.programDynamicDiagnostics || []).some((d) => d.includes(PT_DIAGNOSTIC)), JSON.stringify(image.metadata.programDynamicDiagnostics));
  assert.deepEqual(image.libraries, []);
});

test('#3989 PT_DYNAMIC: DT_SONAME offset beyond DT_STRSZ is partial', () => {
  const image = ptDynamicImage([
    [DT_SONAME, 40n],
    [DT_STRTAB, BASE + BigInt(0x100)], [DT_STRSZ, 21n], [DT_NULL, 0n],
  ]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok((image.metadata.programDynamicDiagnostics || []).some((d) => d.includes(PT_DIAGNOSTIC)), JSON.stringify(image.metadata.programDynamicDiagnostics));
  assert.equal(image.metadata.soname, undefined);
});

test('#3989 PT_DYNAMIC: out-of-range dynamic symbol st_name is partial, name is not fabricated', () => {
  const symOff = 0x100;
  const hashOff = 0x140;
  const strOff = 0x180;
  const dynamicOff = 0x40;
  const bytes = new Uint8Array(0x200);
  const view = new DataView(bytes.buffer);
  view.setUint32(hashOff, 1, true);
  view.setUint32(hashOff + 4, 2, true); // DT_HASH nsyms = 2
  bytes.set(new TextEncoder().encode('\0abc\0'), strOff);
  view.setUint32(symOff + 24, 99, true); // symbol 1 st_name beyond DT_STRSZ
  view.setUint8(symOff + 24 + 4, (1 << 4) | 1); // STB_GLOBAL STT_OBJECT
  view.setUint16(symOff + 24 + 6, 0, true); // SHN_UNDEF -> import
  const entries = [
    [DT_STRTAB, BASE + BigInt(strOff)], [DT_STRSZ, 5n],
    [DT_SYMTAB, BASE + BigInt(symOff)],
    [4n, BASE + BigInt(hashOff)],
    [DT_NULL, 0n],
  ];
  const dynamicSize = writeDynamic64(view, dynamicOff, entries);
  const segment = {
    name: 'LOAD', address: BASE, size: BigInt(bytes.length),
    fileOffset: 0n, fileSize: BigInt(bytes.length),
    perms: { read: true, write: false, execute: false },
  };
  const image = {
    bits: 64,
    imageBase: BASE,
    metadata: { machine: EM_X86_64 },
    warnings: [],
    libraries: [],
    imports: [],
    exports: [],
    symbols: [],
    relocations: [],
    functions: [],
    sections: [],
    segments: [segment],
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < BigInt(bytes.length) ? delta : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const a = BigInt(address);
      return a >= segment.address && a < segment.address + segment.size ? segment : null;
    },
  };
  parseProgramDynamic(new ByteView(bytes), [{ type: 2, offset: BigInt(dynamicOff), filesz: BigInt(dynamicSize) }], image, 64);
  assert.equal(image.metadata.programDynamicPartial, true, JSON.stringify(image.metadata.programDynamicDiagnostics));
  assert.ok((image.metadata.programDynamicDiagnostics || []).some((d) => d.includes(PT_DIAGNOSTIC)), JSON.stringify(image.metadata.programDynamicDiagnostics));
  assert.equal(image.imports.find((s) => s.name === ''), undefined);
});

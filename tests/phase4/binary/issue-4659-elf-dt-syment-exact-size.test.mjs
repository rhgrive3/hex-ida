/**
 * #4659 — DT_SYMENT is the size of the class-specific Elf*_Sym record.
 *
 * The decoder only implements the fixed ELF32/ELF64 layouts, so accepting a
 * larger value as a stride lets malformed input select arbitrary bytes as the
 * next symbol record. Non-standard sizes must therefore fail closed rather
 * than merely satisfying a minimum-size check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const BASE = 0x400000n;
const SYMTAB_OFFSET = 0x200;
const STRTAB_OFFSET = 0x300;
const HASH_OFFSET = 0x400;

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    length: bytes.length,
    u8: (off) => view.getUint8(off),
    u16: (off) => view.getUint16(off, true),
    u32: (off) => view.getUint32(off, true),
    i32: (off) => view.getInt32(off, true),
    u64: (off) => view.getBigUint64(off, true),
    i64: (off) => view.getBigInt64(off, true),
    slice: (off, size) => bytes.slice(off, off + size),
    cstring(off, maxLength) {
      const end = Math.min(bytes.length, off + maxLength);
      let stop = off;
      while (stop < end && bytes[stop] !== 0) stop++;
      return new TextDecoder().decode(bytes.subarray(off, stop));
    },
  };
}

function fixture(bits, syment) {
  const expected = bits === 64 ? 24 : 16;
  const stride = syment == null ? expected : syment;
  const dynamicEntrySize = bits === 64 ? 16 : 8;
  const bytes = new Uint8Array(0x600);
  const view = new DataView(bytes.buffer);
  const strtab = Uint8Array.from([0, ...new TextEncoder().encode('fake'), 0]);
  bytes.set(strtab, STRTAB_OFFSET);

  const entries = [
    [5, BASE + BigInt(STRTAB_OFFSET)], // DT_STRTAB
    [10, BigInt(strtab.length)],       // DT_STRSZ
    [6, BASE + BigInt(SYMTAB_OFFSET)], // DT_SYMTAB
  ];
  if (syment != null) entries.push([11, BigInt(syment)]); // DT_SYMENT
  entries.push([4, BASE + BigInt(HASH_OFFSET)], [0, 0n]); // DT_HASH, DT_NULL

  entries.forEach(([tag, value], index) => {
    const off = index * dynamicEntrySize;
    if (bits === 64) {
      view.setBigInt64(off, BigInt(tag), true);
      view.setBigUint64(off + 8, BigInt(value), true);
    } else {
      view.setInt32(off, Number(tag), true);
      view.setUint32(off + 4, Number(value), true);
    }
  });

  // Put the only named symbol exactly where the declared stride says record
  // #1 begins. With a non-standard stride, old code incorrectly promoted
  // these controlled bytes into a canonical import.
  const fake = SYMTAB_OFFSET + stride;
  view.setUint32(fake, 1, true); // st_name -> "fake"
  if (bits === 64) {
    view.setUint8(fake + 4, 0x11);      // STB_GLOBAL | STT_OBJECT
    view.setUint8(fake + 5, 0);
    view.setUint16(fake + 6, 0, true);  // SHN_UNDEF
    view.setBigUint64(fake + 8, 0n, true);
    view.setBigUint64(fake + 16, 0n, true);
  } else {
    view.setUint32(fake + 4, 0, true);
    view.setUint32(fake + 8, 0, true);
    view.setUint8(fake + 12, 0x11);     // STB_GLOBAL | STT_OBJECT
    view.setUint8(fake + 13, 0);
    view.setUint16(fake + 14, 0, true); // SHN_UNDEF
  }

  // Exact symbol-count evidence for two records.
  view.setUint32(HASH_OFFSET, 1, true);     // nbucket
  view.setUint32(HASH_OFFSET + 4, 2, true); // nchain
  view.setUint32(HASH_OFFSET + 8, 1, true); // bucket[0]
  view.setUint32(HASH_OFFSET + 12, 0, true);
  view.setUint32(HASH_OFFSET + 16, 0, true);

  const segment = {
    address: BASE,
    size: BigInt(bytes.length),
    fileOffset: 0n,
    fileSize: BigInt(bytes.length),
    perms: { read: true, write: false, execute: false },
  };
  const image = {
    arch: bits === 64 ? 'x86_64' : 'x86',
    warnings: [],
    libraries: [],
    metadata: { machine: bits === 64 ? 62 : 3 },
    segments: [segment],
    sections: [],
    symbols: [],
    imports: [],
    exports: [],
    functions: [],
    relocations: [],
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < BigInt(bytes.length) ? Number(delta) : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      return address >= BASE && address < BASE + BigInt(bytes.length) ? segment : null;
    },
  };

  const result = parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: 0n, filesz: BigInt(entries.length * dynamicEntrySize) }],
    image,
    bits,
  );
  assert.equal(result.parsed, true);
  return image;
}

function assertRejected(bits, syment) {
  const image = fixture(bits, syment);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(
    image.warnings.some((warning) => warning.includes('DT_SYMENT') && warning.includes('does not match')),
    `expected DT_SYMENT mismatch diagnostic for ELF${bits} value ${syment}`,
  );
  assert.equal(image.metadata.programDynamic.symbolsExpected, 0);
  assert.equal(image.imports.some((entry) => entry.name === 'fake'), false);
}

test('#4659: ELF64 accepts only the 24-byte Elf64_Sym layout', () => {
  const image = fixture(64, 24);
  assert.equal(image.metadata.programDynamicPartial ?? false, false);
  assert.equal(image.imports.some((entry) => entry.name === 'fake'), true);

  assertRejected(64, 32);
  assertRejected(64, 25);
  assertRejected(64, 23);
});

test('#4659: ELF32 accepts only the 16-byte Elf32_Sym layout', () => {
  const image = fixture(32, 16);
  assert.equal(image.metadata.programDynamicPartial ?? false, false);
  assert.equal(image.imports.some((entry) => entry.name === 'fake'), true);

  assertRejected(32, 20);
  assertRejected(32, 17);
  assertRejected(32, 15);
});

test('#4659: omitted DT_SYMENT keeps the class default', () => {
  for (const bits of [32, 64]) {
    const image = fixture(bits, null);
    assert.equal(image.metadata.programDynamicPartial ?? false, false);
    assert.equal(image.imports.some((entry) => entry.name === 'fake'), true);
  }
});

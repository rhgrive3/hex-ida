import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgramDynamic } from '../../js/binary/elf-dynamic.js';

const BASE = 0x400000n;
const DYNAMIC_OFFSET = 0x100;
const SYMTAB_OFFSET = 0x200;
const STRTAB_OFFSET = 0x300;
const RELA_OFFSET = 0x400;
const SHNDX_OFFSET = 0x480;
const RELOCATION_OFFSET = 0x500;
const VERSYM_OFFSET = 0x580;
const VERNEED_OFFSET = 0x600;
const SHN_UNDEF = 0;
const SHN_XINDEX = 0xffff;
const DT_VERSYM = 0x6ffffff0;
const DT_VERNEED = 0x6ffffffe;
const DT_VERNEEDNUM = 0x6fffffff;

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

function putDynamic(view, index, tag, value) {
  const off = DYNAMIC_OFFSET + index * 16;
  view.setBigInt64(off, BigInt(tag), true);
  view.setBigUint64(off + 8, BigInt(value), true);
}

function fixture(sectionIndex, companion = null, options = {}) {
  const bytes = new Uint8Array(0x800);
  const view = new DataView(bytes.buffer);
  const strtabVa = BASE + BigInt(STRTAB_OFFSET);
  const symtabVa = BASE + BigInt(SYMTAB_OFFSET);
  const relaVa = BASE + BigInt(RELA_OFFSET);
  const versioned = options.versioned === true;
  const stringBytes = versioned
    ? Uint8Array.from([
        0,
        ...new TextEncoder().encode('mystery'), 0,
        ...new TextEncoder().encode('lib.so'), 0,
        ...new TextEncoder().encode('VER_1'), 0,
      ])
    : Uint8Array.from([0, ...new TextEncoder().encode('mystery'), 0]);

  putDynamic(view, 0, 5, strtabVa);                  // DT_STRTAB
  putDynamic(view, 1, 10, stringBytes.length);       // DT_STRSZ
  putDynamic(view, 2, 6, symtabVa);                  // DT_SYMTAB
  putDynamic(view, 3, 11, 24);                       // DT_SYMENT
  putDynamic(view, 4, 39, 24);                       // DT_SYMTABSZ: exactly one symbol
  putDynamic(view, 5, 7, relaVa);                    // DT_RELA
  putDynamic(view, 6, 8, 24);                        // DT_RELASZ
  putDynamic(view, 7, 9, 24);                        // DT_RELAENT

  let dynamicIndex = 8;
  if (companion !== null) {
    const shndxVa = companion === 'truncated'
      ? BASE + 0x7fen
      : BASE + BigInt(SHNDX_OFFSET);
    putDynamic(view, dynamicIndex++, 34, shndxVa);   // DT_SYMTAB_SHNDX
    if (companion !== 'truncated') view.setUint32(SHNDX_OFFSET, companion, true);
  }
  if (versioned) {
    putDynamic(view, dynamicIndex++, DT_VERSYM, BASE + BigInt(VERSYM_OFFSET));
    putDynamic(view, dynamicIndex++, DT_VERNEED, BASE + BigInt(VERNEED_OFFSET));
    putDynamic(view, dynamicIndex++, DT_VERNEEDNUM, 1);
  }
  putDynamic(view, dynamicIndex++, 0, 0);             // DT_NULL
  const dynamicEntries = dynamicIndex;

  bytes.set(stringBytes, STRTAB_OFFSET);

  view.setUint32(SYMTAB_OFFSET, 1, true);              // st_name
  view.setUint8(SYMTAB_OFFSET + 4, 0x11);              // STB_GLOBAL | STT_OBJECT
  view.setUint8(SYMTAB_OFFSET + 5, 0);                 // default visibility
  view.setUint16(SYMTAB_OFFSET + 6, sectionIndex, true);
  view.setBigUint64(SYMTAB_OFFSET + 8, 0n, true);
  view.setBigUint64(SYMTAB_OFFSET + 16, 8n, true);

  view.setBigUint64(RELA_OFFSET, BASE + BigInt(RELOCATION_OFFSET), true);
  view.setBigUint64(RELA_OFFSET + 8, 1n, true);        // symbol 0, relocation type 1
  view.setBigInt64(RELA_OFFSET + 16, 0n, true);

  if (versioned) {
    view.setUint16(VERSYM_OFFSET, 2, true);             // version index 2
    view.setUint16(VERNEED_OFFSET, 1, true);            // vn_version
    view.setUint16(VERNEED_OFFSET + 2, 1, true);        // vn_cnt
    view.setUint32(VERNEED_OFFSET + 4, 9, true);        // "lib.so"
    view.setUint32(VERNEED_OFFSET + 8, 16, true);       // first Vernaux
    view.setUint32(VERNEED_OFFSET + 12, 0, true);       // no next Verneed
    const aux = VERNEED_OFFSET + 16;
    view.setUint32(aux, 0, true);                       // vna_hash
    view.setUint16(aux + 4, 0, true);                   // vna_flags
    view.setUint16(aux + 6, 2, true);                   // vna_other
    view.setUint32(aux + 8, 16, true);                  // "VER_1"
    view.setUint32(aux + 12, 0, true);                  // no next Vernaux
  }

  const segment = {
    address: BASE,
    size: 0x800n,
    fileOffset: 0n,
    fileSize: 0x800n,
    perms: { read: true, write: true, execute: false },
  };
  const image = {
    warnings: [],
    libraries: [],
    metadata: { machine: 62 },
    segments: [segment],
    sections: [],
    symbols: [],
    imports: options.seedImport === true ? [{
      name: 'mystery',
      library: null,
      ordinal: null,
      weak: false,
      version: null,
      versionLibrary: null,
      versionIndex: null,
      symbolIndex: 0,
      source: 'preexisting',
      sites: [],
    }] : [],
    exports: [],
    functions: [],
    relocations: [],
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < 0x800n ? Number(delta) : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const value = BigInt(address);
      return value >= BASE && value < BASE + 0x800n ? segment : null;
    },
  };

  const result = parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: BigInt(dynamicEntries * 16) }],
    image,
    64,
  );
  assert.equal(result.parsed, true);
  assert.equal(image.symbols.length, 1);
  assert.equal(image.relocations.length, 1);
  return image;
}

function assertUnknown(image, reason) {
  const [symbol] = image.symbols;
  assert.equal(symbol.defined, null);
  assert.equal(symbol.sectionIndex, null);
  assert.equal(image.imports.length, 0);
  assert.equal(image.exports.length, 0);
  assert.equal(image.relocations[0].symbol, 'mystery');
  assert.ok(image.warnings.some((warning) => warning.includes(reason)));
}

test('PT_DYNAMIC SHN_XINDEX without companion remains unknown, not an import', () => {
  assertUnknown(fixture(SHN_XINDEX), 'missing-companion');
});

test('PT_DYNAMIC SHN_XINDEX with truncated or invalid companion remains unknown', () => {
  assertUnknown(fixture(SHN_XINDEX, 'truncated'), 'truncated-companion');
  assertUnknown(fixture(SHN_XINDEX, 0xff10), 'invalid-extended-index');
});

test('version metadata does not promote an unresolved symbol into an existing import', () => {
  const image = fixture(SHN_XINDEX, null, { versioned:true, seedImport:true });
  const [symbol] = image.symbols;
  const [existingImport] = image.imports;
  assert.equal(symbol.defined, null);
  assert.equal(symbol.version, 'VER_1');
  assert.equal(symbol.versionLibrary, 'lib.so');
  assert.equal(symbol.versionIndex, 2);
  assert.equal(image.imports.length, 1);
  assert.equal(existingImport.source, 'preexisting');
  assert.equal(existingImport.version, null);
  assert.equal(existingImport.versionLibrary, null);
  assert.equal(existingImport.versionIndex, null);
  assert.deepEqual(existingImport.sites, []);
  assert.equal(image.exports.length, 0);
});

test('PT_DYNAMIC SHN_UNDEF remains a definite import with relocation site', () => {
  const image = fixture(SHN_UNDEF);
  assert.equal(image.symbols[0].defined, false);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].name, 'mystery');
  assert.equal(image.imports[0].sites.length, 1);
  assert.equal(image.exports.length, 0);
});

test('PT_DYNAMIC SHN_XINDEX companion resolving to SHN_UNDEF remains an import', () => {
  const image = fixture(SHN_XINDEX, SHN_UNDEF);
  assert.equal(image.symbols[0].defined, false);
  assert.equal(image.symbols[0].sectionIndex, SHN_UNDEF);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].sites.length, 1);
  assert.equal(image.exports.length, 0);
});

test('PT_DYNAMIC known section identity remains a definite export', () => {
  for (const image of [fixture(1), fixture(SHN_XINDEX, 1)]) {
    assert.equal(image.symbols[0].defined, true);
    assert.equal(image.symbols[0].sectionIndex, 1);
    assert.equal(image.imports.length, 0);
    assert.equal(image.exports.length, 1);
    assert.equal(image.exports[0].name, 'mystery');
  }
});

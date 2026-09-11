import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../../js/binary/reader.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const BASE = 0x400000n;
const SHN_COMMON = 0xfff2;
const SHN_XINDEX = 0xffff;
const SYMTAB_OFFSET = 0x100;
const STRTAB_OFFSET = 0x118;
const SHNDX_OFFSET = 0x140;
const FUNCTION_OFFSET = 0x200;

function buildExtendedCommonImage() {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  const dynamic = [
    [6n, BASE + BigInt(SYMTAB_OFFSET)],       // DT_SYMTAB
    [5n, BASE + BigInt(STRTAB_OFFSET)],       // DT_STRTAB
    [10n, 0x20n],                             // DT_STRSZ
    [11n, 24n],                               // DT_SYMENT
    [34n, BASE + BigInt(SHNDX_OFFSET)],        // DT_SYMTAB_SHNDX
    [0n, 0n],                                 // DT_NULL
  ];
  for (const [index, [tag, value]] of dynamic.entries()) {
    view.setBigInt64(index * 16, tag, true);
    view.setBigUint64(index * 16 + 8, value, true);
  }

  view.setUint32(SYMTAB_OFFSET, 1, true);
  view.setUint8(SYMTAB_OFFSET + 4, (1 << 4) | 2); // STB_GLOBAL | STT_FUNC
  view.setUint8(SYMTAB_OFFSET + 5, 0);
  view.setUint16(SYMTAB_OFFSET + 6, SHN_XINDEX, true);
  view.setBigUint64(SYMTAB_OFFSET + 8, BASE + BigInt(FUNCTION_OFFSET), true);
  view.setBigUint64(SYMTAB_OFFSET + 16, 12n, true);
  bytes.set(new TextEncoder().encode('\0extended_fn\0'), STRTAB_OFFSET);
  view.setUint32(SHNDX_OFFSET, SHN_COMMON, true);

  const segment = {
    address: BASE,
    size: BigInt(bytes.length),
    fileOffset: 0n,
    fileSize: BigInt(bytes.length),
    perms: { read: true, write: false, execute: true },
  };
  const sections = new Array(SHN_COMMON + 1);
  const image = {
    bits: 64,
    imageBase: BASE,
    metadata: { machine: 62 },
    warnings: [],
    libraries: [],
    imports: [],
    exports: [],
    symbols: [],
    relocations: [],
    functions: [],
    sections,
    segments: [segment],
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < BigInt(bytes.length) ? delta : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const candidate = BigInt(address);
      return candidate >= segment.address && candidate < segment.address + segment.size ? segment : null;
    },
  };

  parseProgramDynamic(
    new ByteView(bytes),
    [{ type: 2, offset: 0n, filesz: BigInt(dynamic.length * 16) }],
    image,
    64,
  );
  return image;
}

test('#4358 PT_DYNAMIC extended index numerically equal to SHN_COMMON remains section-backed', () => {
  const image = buildExtendedCommonImage();
  const symbol = image.symbols.find((entry) => entry.name === 'extended_fn');

  assert.ok(symbol);
  assert.equal(symbol.defined, true);
  assert.equal(symbol.sectionIndex, SHN_COMMON);
  assert.equal(symbol.address, BASE + BigInt(FUNCTION_OFFSET));
  assert.equal(symbol.addressDomain, 'virtual');
  assert.equal(symbol.commonAlignment, undefined);
  assert.equal(symbol.allocation, undefined);
  assert.equal(image.imports.length, 0);
  assert.equal(image.exports.find((entry) => entry.name === 'extended_fn')?.address, BASE + BigInt(FUNCTION_OFFSET));
  assert.equal(image.functions.find((entry) => entry.name === 'extended_fn')?.address, BASE + BigInt(FUNCTION_OFFSET));
});

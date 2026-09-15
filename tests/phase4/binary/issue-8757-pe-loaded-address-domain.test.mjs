/**
 * #8757 regression: PE parsing must prove loaded-image address-domain closure.
 *
 * `ImageBase + RVA` / `ImageBase + SizeOfImage` used to be unbounded BigInt
 * arithmetic, so a valid PE32+ header could publish canonical segment/section
 * VAs at 2^64 (an address domain no 64-bit loader can represent) while
 * reporting `peMetadata.complete === true`. The parser now enforces one
 * domain-closure invariant over [ImageBase, ImageBase + SizeOfImage) and routes
 * RVA -> VA through one checked conversion.
 */
import assert from 'node:assert/strict';
import { parsePE } from '../../../js/binary/pe.js';

const PE64_DIRECTORY_OFFSET = 112;
const DOMAIN64 = 1n << 64n;
const DOMAIN32 = 1n << 32n;

function coffHeader({ magic, sections }) {
  return [
    0x4d, 0x5a, ...Array(0x3a).fill(0), 0x40, 0, 0, 0,
    0x50, 0x45, 0, 0,
    magic & 0xff, (magic >>> 8) & 0xff, // Machine
    sections.length & 0xff, (sections.length >>> 8) & 0xff,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0,       // SizeOfOptionalHeader (patched)
    0x22, 0x00, // Characteristics
  ];
}

function optionalHeader({ bits, sizeOptional, sizeOfImage, sizeOfHeaders, imageBase, directories = [] }) {
  const header = new Array(sizeOptional).fill(0);
  const put16 = (offset, value) => { header[offset] = value & 0xff; header[offset + 1] = (value >>> 8) & 0xff; };
  const put32 = (offset, value) => { put16(offset, value & 0xffff); put16(offset + 2, (value >>> 16) & 0xffff); };
  put16(0, bits === 64 ? 0x20b : 0x10b);
  put32(16, 0x1000);                    // AddressOfEntryPoint
  if (bits === 64) {
    for (let i = 0; i < 8; i++) header[24 + i] = Number((imageBase >> BigInt(8 * i)) & 0xffn);
  } else {
    put32(28, Number(imageBase));       // ImageBase (PE32)
  }
  put32(32, 0x1000);                    // SectionAlignment
  put32(36, 0x200);                     // FileAlignment
  put32(56, sizeOfImage);
  put32(60, sizeOfHeaders);
  put16(68, 3);                         // Subsystem
  const dirOffset = bits === 64 ? 108 : 92;
  put32(dirOffset, 16);
  const available = Math.max(0, Math.floor((sizeOptional - (dirOffset + 4)) / 8));
  for (let i = 0; i < Math.min(16, available); i++) {
    put32(dirOffset + 4 + i * 8, directories[i]?.rva ?? 0);
    put32(dirOffset + 4 + i * 8 + 4, directories[i]?.size ?? 0);
  }
  return header;
}

function sectionEntry({ name, virtualAddress, virtualSize, sizeRaw = 0, ptrRaw = 0, flags = 0x40000040 }) {
  const entry = [...Buffer.from(name.padEnd(8, '\0').slice(0, 8), 'latin1')];
  const put32 = (offset, value) => {
    entry[offset] = value & 0xff; entry[offset + 1] = (value >>> 8) & 0xff;
    entry[offset + 2] = (value >>> 16) & 0xff; entry[offset + 3] = (value >>> 24) & 0xff;
  };
  put32(8, virtualSize);
  put32(12, virtualAddress);
  put32(16, sizeRaw);
  put32(20, ptrRaw);
  put32(36, flags);
  return entry;
}

function buildPE({ bits = 64, imageBase, sizeOfImage, sizeOfHeaders = 0x200, sections = [], directories = [] }) {
  const sizeOptional = (bits === 64 ? PE64_DIRECTORY_OFFSET : 96) + 16 * 8;
  const bytes = [
    ...coffHeader({ magic: bits === 64 ? 0x8664 : 0x14c, sections }),
    ...optionalHeader({ bits, sizeOptional, sizeOfImage, sizeOfHeaders, imageBase, directories }),
  ];
  bytes[84] = sizeOptional & 0xff;
  bytes[85] = (sizeOptional >>> 8) & 0xff;
  for (const section of sections) bytes.push(...sectionEntry(section));
  bytes.push(...Buffer.alloc(0x400, 0xcc));
  return new Uint8Array(bytes);
}

// 1. The issue counterexample: a 512-byte-ish PE32+ whose ImageBase + SizeOfImage
//    crosses 2^64 must never reach section mapping at all.
assert.throws(
  () => parsePE(buildPE({
    imageBase: 0xffffffffffff0000n,
    sizeOfImage: 0x20000,
    sections: [{ name: '.bss', virtualAddress: 0x10000, virtualSize: 0x1000 }],
  })),
  /loaded image address domain/,
  'PE32+ crossing the 64-bit loaded address domain must fail closed',
);

// 2. Exactly-closing ImageBase + SizeOfImage == 2^64 is representable: the whole
//    image stays canonical and no address escapes the domain.
{
  const image = parsePE(buildPE({
    imageBase: 0xffffffffffff0000n,
    sizeOfImage: 0x10000,
    sections: [{ name: '.text', virtualAddress: 0x1000, virtualSize: 0x1000, flags: 0x60000020 }],
  }));
  assert.equal(image.sections.length, 1, 'in-domain near-limit image keeps its canonical section');
  assert.equal(image.sections[0].address, 0xffffffffffff1000n);
  assert.equal(image.metadata.peMetadata?.complete, true);
  assert.equal(image.entrypoint, 0xffffffffffff1000n);
  assert.equal(image.resolveVirtualMapping(DOMAIN64), null, '2^64 is not addressable authority');
  assert.notEqual(image.resolveVirtualMapping(0xffffffffffff2000n - 1n), null, 'the last in-domain section byte is reachable');
  for (const mapping of [...image.sections, ...image.segments]) {
    assert.ok(mapping.address >= 0n && mapping.address + mapping.size <= DOMAIN64,
      `published mapping ${mapping.name} leaves the 64-bit domain`);
  }
}

// 3. An ordinary high-but-valid base is unchanged (no new false rejection).
{
  const image = parsePE(buildPE({
    imageBase: 0x140000000n,
    sizeOfImage: 0x20000,
    sections: [{ name: '.text', virtualAddress: 0x1000, virtualSize: 0x1000 }],
  }));
  assert.equal(image.sections[0].address, 0x140001000n);
  assert.equal(image.metadata.peMetadata.complete, true);
}

// 4. PE32 uses the 32-bit loaded-address policy, not just 32-bit RVAs.
assert.throws(
  () => parsePE(buildPE({
    bits: 32,
    imageBase: 0xffff0000n,
    sizeOfImage: 0x20000,
    sections: [{ name: '.bss', virtualAddress: 0x10000, virtualSize: 0x1000 }],
  })),
  /32-bit loaded image address domain/,
  'PE32 ImageBase + SizeOfImage must close inside the 32-bit domain',
);
{
  const image = parsePE(buildPE({
    bits: 32,
    imageBase: 0x400000n,
    sizeOfImage: 0x20000,
    sections: [{ name: '.text', virtualAddress: 0x1000, virtualSize: 0x1000 }],
  }));
  assert.equal(image.sections[0].address, 0x401000n);
  assert.equal(image.metadata.peMetadata.complete, true);
}

// 5. Every other RVA -> VA consumer (imports/IAT, exports, relocations, exception
//    functions) stays inside the same checked domain: hostile directory RVAs in a
//    near-limit image may not mint an out-of-domain canonical address.
{
  const image = parsePE(buildPE({
    imageBase: 0xfffffffffff00000n,
    sizeOfImage: 0x100000,
    sections: [{ name: '.text', virtualAddress: 0x1000, virtualSize: 0x2000, flags: 0x60000020 }],
    directories: [
      { rva: 0x2000, size: 0x28 },  // export
      { rva: 0x3000, size: 0x28 },  // import
      { rva: 0x4000, size: 0x40 },  // exception
      { rva: 0x5000, size: 0x40 },  // base relocation
      { rva: 0xfffff8, size: 0x100 }, // deliberately crossing SizeOfImage
    ],
  }));
  const addresses = [
    ...(image.functions ?? []).map((seed) => seed.address),
    ...(image.imports ?? []).flatMap((entry) => [entry.thunkAddress, entry.importLookupAddress]),
    ...(image.exports ?? []).map((entry) => entry.address),
    ...(image.relocations ?? []).map((entry) => entry.address),
  ].filter((value) => typeof value === 'bigint');
  assert.ok(addresses.every((address) => address >= 0n && address < DOMAIN64),
    'no metadata path may publish an out-of-domain address');
  assert.equal(image.resolveVirtualMapping(DOMAIN64), null);
}

console.log('ok #8757 PE loaded-image address domain closure is enforced on every RVA -> VA path');

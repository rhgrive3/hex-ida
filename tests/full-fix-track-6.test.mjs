import test from 'node:test';
import assert from 'node:assert/strict';

import { parseELF } from '../js/binary/elf-core.js';
import {
  ELF_MAX_PARTIAL_WARNINGS,
  markELFMetadataPartial,
} from '../js/binary/elf-budget.js';
import {
  GNU_PROPERTY_AARCH64_FEATURE_1_AND,
  GNU_PROPERTY_AARCH64_FEATURE_1_BTI,
  NT_GNU_PROPERTY_TYPE_0,
  PT_GNU_PROPERTY,
  parseAarch64GnuProperty,
} from '../js/binary/elf-gnu-property.js';
import { ByteView } from '../js/binary/reader.js';
import {
  parseDyldSharedCache,
  parseDyldSharedCacheSource,
} from '../js/binary/dyld-shared-cache-core.js';

function u16(dv, off, val) { dv.setUint16(off, val, true); }
function u32(dv, off, val) { dv.setUint32(off, val >>> 0, true); }
function u64(dv, off, val) { dv.setBigUint64(off, BigInt(val), true); }

function writeElf64Header(bytes, dv, {
  type = 2,
  machine = 62,
  entry = 0n,
  phoff = 0n,
  shoff = 0n,
  phentsize = 56,
  phnum = 0,
  shentsize = 64,
  shnum = 0,
  shstrndx = 0,
} = {}) {
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  u16(dv, 16, type);
  u16(dv, 18, machine);
  u32(dv, 20, 1);
  u64(dv, 24, entry);
  u64(dv, 32, phoff);
  u64(dv, 40, shoff);
  u32(dv, 48, 0);
  u16(dv, 52, 64);
  u16(dv, 54, phentsize);
  u16(dv, 56, phnum);
  u16(dv, 58, shentsize);
  u16(dv, 60, shnum);
  u16(dv, 62, shstrndx);
}

function writePhdr64(dv, off, {
  type = 1,
  flags = 5,
  offset = 0n,
  vaddr = 0n,
  paddr = 0n,
  filesz = 0n,
  memsz = 0n,
  align = 0x1000n,
} = {}) {
  u32(dv, off + 0, type);
  u32(dv, off + 4, flags);
  u64(dv, off + 8, offset);
  u64(dv, off + 16, vaddr);
  u64(dv, off + 24, paddr);
  u64(dv, off + 32, filesz);
  u64(dv, off + 40, memsz);
  u64(dv, off + 48, align);
}

function writeShdr64(dv, off, {
  name = 0,
  type = 0,
  flags = 0n,
  addr = 0n,
  offset = 0n,
  size = 0n,
  link = 0,
  info = 0,
  addralign = 1n,
  entsize = 0n,
} = {}) {
  u32(dv, off + 0, name);
  u32(dv, off + 4, type);
  u64(dv, off + 8, flags);
  u64(dv, off + 16, addr);
  u64(dv, off + 24, offset);
  u64(dv, off + 32, size);
  u32(dv, off + 40, link);
  u32(dv, off + 44, info);
  u64(dv, off + 48, addralign);
  u64(dv, off + 56, entsize);
}

/* ── [FF-T6-#1a] parseSymbols & parseDynamic charge unterminated string scan bytes and stop on budget exhaustion ── */
test('[FF-T6-#1a] parseSymbols charges scanned bytes on unterminated string and stops when inputBytes budget is exceeded', () => {
  // Layout:
  // 0x000..0x040: ELF64 header
  // 0x100..0x1c0: 3 section headers (NULL, SHT_SYMTAB, SHT_STRTAB)
  // 0x200..0x290: 6 Elf64_Sym entries (24 bytes each = 144 bytes) pointing to distinct unterminated offsets
  // 0x300..0x2300: 8192-byte SHT_STRTAB filled with 'A' (no NUL)
  const strOff = 0x300;
  const strSize = 8192;
  const symOff = 0x200;
  const symCount = 6;
  const bytes = new Uint8Array(strOff + strSize);
  const dv = new DataView(bytes.buffer);
  writeElf64Header(bytes, dv, { shoff: 0x100n, shnum: 3, shstrndx: 0 });
  // SHT_NULL
  writeShdr64(dv, 0x100, { type: 0 });
  // SHT_SYMTAB (type 2), linked to section 2
  writeShdr64(dv, 0x140, { type: 2, offset: BigInt(symOff), size: BigInt(symCount * 24), link: 2, entsize: 24n });
  // SHT_STRTAB (type 3)
  writeShdr64(dv, 0x180, { type: 3, offset: BigInt(strOff), size: BigInt(strSize) });
  // Symbols referencing distinct offsets (0, 1, 2, 3, 4, 5) into unterminated strtab
  for (let i = 0; i < symCount; i++) {
    u32(dv, symOff + i * 24, i);
  }
  bytes.fill(0x41, strOff, strOff + strSize);

  const image = parseELF(bytes, { metadataLimits: { inputBytes: 2048 } });
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(
    image.metadata.elfMetadata.reasons.some((r) => r.includes('budget:symbol-name-scan:inputBytes')),
    `expected budget:symbol-name-scan:inputBytes in ${JSON.stringify(image.metadata.elfMetadata.reasons)}`,
  );
  // Only the first symbol scan should run before breaking out of the loop
  assert.ok(
    image.warnings.filter((w) => w.includes('without a NUL terminator')).length === 1,
    'must stop scanning remaining symbols once budget is exceeded',
  );
});

test('[FF-T6-#1a] parseDynamic charges scanned bytes on unterminated DT_NEEDED string and stops when budget is exceeded', () => {
  // Layout:
  // 0x000..0x040: ELF64 header
  // 0x100..0x1c0: 3 section headers (NULL, SHT_DYNAMIC, SHT_STRTAB)
  // 0x200..0x260: 6 Elf64_Dyn entries (16 bytes each = 96 bytes): 5 DT_NEEDED + 1 DT_NULL
  // 0x300..0x2300: 8192-byte SHT_STRTAB filled with 'B' (no NUL)
  const strOff = 0x300;
  const strSize = 8192;
  const dynOff = 0x200;
  const dynCount = 6;
  const bytes = new Uint8Array(strOff + strSize);
  const dv = new DataView(bytes.buffer);
  writeElf64Header(bytes, dv, { shoff: 0x100n, shnum: 3, shstrndx: 0 });
  writeShdr64(dv, 0x100, { type: 0 });
  // SHT_DYNAMIC (type 6), linked to section 2
  writeShdr64(dv, 0x140, { type: 6, offset: BigInt(dynOff), size: BigInt(dynCount * 16), link: 2, entsize: 16n });
  // SHT_STRTAB (type 3)
  writeShdr64(dv, 0x180, { type: 3, offset: BigInt(strOff), size: BigInt(strSize) });
  for (let i = 0; i < 5; i++) {
    u64(dv, dynOff + i * 16, 1n); // DT_NEEDED
    u64(dv, dynOff + i * 16 + 8, BigInt(i));
  }
  u64(dv, dynOff + 5 * 16, 0n); // DT_NULL
  u64(dv, dynOff + 5 * 16 + 8, 0n);
  bytes.fill(0x42, strOff, strOff + strSize);

  const image = parseELF(bytes, { metadataLimits: { inputBytes: 2048 } });
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(
    image.metadata.elfMetadata.reasons.some((r) => r.includes('budget:SHT_DYNAMIC-string-scan:inputBytes')),
    `expected budget:SHT_DYNAMIC-string-scan:inputBytes in ${JSON.stringify(image.metadata.elfMetadata.reasons)}`,
  );
  assert.equal(image.libraries.length, 0);
});

/* ── [FF-T6-#1b] markELFMetadataPartial uses Set deduplication and caps warning growth ── */
test('[FF-T6-#1b] markELFMetadataPartial deduplicates with Set and bounds warning count', () => {
  const image = { warnings: [], metadata: {} };
  for (let i = 0; i < 5000; i++) {
    markELFMetadataPartial(image, `reason-${i % 10}`, `unique-warning-${i}`);
  }
  // Duplicate check
  markELFMetadataPartial(image, 'reason-0', 'unique-warning-0');
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.equal(image.metadata.elfMetadata.reasons.length, 10);
  assert.equal(image.warnings.length, ELF_MAX_PARTIAL_WARNINGS);
  assert.match(image.warnings[image.warnings.length - 1], /suppressed/);
});

/* ── [FF-T6-#2] elf-core.js: non-ascending PT_LOAD does not clone or mutate original bytes ── */
test('[FF-T6-#2] parseELF preserves original unmodified bytes reference when PT_LOAD headers are non-ascending', () => {
  const bytes = new Uint8Array(0x4000);
  const dv = new DataView(bytes.buffer);
  writeElf64Header(bytes, dv, {
    type: 2,
    machine: 62,
    entry: 0x401000n,
    phoff: 64n,
    phnum: 2,
  });
  // Intentionally non-ascending PT_LOAD order: phdr[0] has higher vaddr than phdr[1]
  writePhdr64(dv, 64, {
    type: 1, flags: 4, offset: 0x2000n, vaddr: 0x402000n, paddr: 0x402000n,
    filesz: 0x1000n, memsz: 0x1000n, align: 0x1000n,
  });
  writePhdr64(dv, 64 + 56, {
    type: 1, flags: 5, offset: 0x1000n, vaddr: 0x401000n, paddr: 0x401000n,
    filesz: 0x1000n, memsz: 0x1000n, align: 0x1000n,
  });
  bytes[0x1000] = 0xc3; // ret

  const snapshot = bytes.slice();
  const image = parseELF(bytes);

  assert.strictEqual(image.bytes, bytes, 'BinaryImage.bytes must keep the original Uint8Array reference');
  assert.deepEqual(bytes, snapshot, 'original ELF bytes must not be mutated');
  const loads = image.segments.filter((s) => s.source === 'PT_LOAD');
  assert.equal(loads.length, 2);
  assert.equal(loads[0].address, 0x401000n);
  assert.equal(loads[1].address, 0x402000n);
});

/* ── [FF-T6-#3] elf-gnu-property.js: 8-byte note alignment on ELF64 & unsigned 32-bit featureBits ── */
test('[FF-T6-#3a] parseAarch64GnuProperty aligns ELF64 PT_GNU_PROPERTY notes to 8 bytes (p_align)', () => {
  // Note 1 at offset 0x100: namesz=4 ("FOO\0"), descsz=12 (4-byte aligned, NOT 8-byte aligned!)
  //   header(12) + name(4) = 16; desc(12) + 4 pad = 16 -> total 32 bytes; Note 2 starts at 0x120.
  // Note 2 at offset 0x120: namesz=4 ("GNU\0"), descsz=16, NT_GNU_PROPERTY_TYPE_0 with BTI=1.
  const noteOffset = 0x100;
  const note1Size = 32;
  const note2Size = 32;
  const totalNoteBytes = note1Size + note2Size;
  const bytes = new Uint8Array(noteOffset + totalNoteBytes);
  const dv = new DataView(bytes.buffer);
  writeElf64Header(bytes, dv, { type: 2, machine: 183, phoff: 64n, phnum: 1 });
  writePhdr64(dv, 64, {
    type: PT_GNU_PROPERTY,
    flags: 4,
    offset: BigInt(noteOffset),
    vaddr: BigInt(noteOffset),
    filesz: BigInt(totalNoteBytes),
    memsz: BigInt(totalNoteBytes),
    align: 8n,
  });

  // Note 1 (non-GNU, descsz=12 padded to 8-byte boundary -> 16)
  u32(dv, noteOffset + 0, 4);
  u32(dv, noteOffset + 4, 12);
  u32(dv, noteOffset + 8, 99);
  bytes.set([0x46, 0x4f, 0x4f, 0x00], noteOffset + 12);

  // Note 2 (canonical GNU property note at 0x120)
  const n2 = noteOffset + note1Size;
  u32(dv, n2 + 0, 4);
  u32(dv, n2 + 4, 16);
  u32(dv, n2 + 8, NT_GNU_PROPERTY_TYPE_0);
  bytes.set([0x47, 0x4e, 0x55, 0x00], n2 + 12);
  u32(dv, n2 + 16, GNU_PROPERTY_AARCH64_FEATURE_1_AND);
  u32(dv, n2 + 20, 4);
  u32(dv, n2 + 24, GNU_PROPERTY_AARCH64_FEATURE_1_BTI);

  const res = parseAarch64GnuProperty(bytes);
  assert.equal(res.loaderPolicy, 'bti-requested');
  assert.equal(res.btiRequested, true);
  assert.equal(res.featureBits, GNU_PROPERTY_AARCH64_FEATURE_1_BTI);
  assert.deepEqual(res.warnings, []);
});

test('[FF-T6-#3b] parseAarch64GnuProperty keeps featureBits as unsigned 32-bit integer when ANDing high-bit values', () => {
  const noteOffset = 0x100;
  // Two 16-byte property entries inside one NT_GNU_PROPERTY_TYPE_0 note (descsz = 32)
  const descSize = 32;
  const noteSize = 12 + 4 + descSize;
  const bytes = new Uint8Array(noteOffset + noteSize);
  const dv = new DataView(bytes.buffer);
  writeElf64Header(bytes, dv, { type: 2, machine: 183, phoff: 64n, phnum: 1 });
  writePhdr64(dv, 64, {
    type: PT_GNU_PROPERTY,
    flags: 4,
    offset: BigInt(noteOffset),
    vaddr: BigInt(noteOffset),
    filesz: BigInt(noteSize),
    memsz: BigInt(noteSize),
    align: 8n,
  });

  u32(dv, noteOffset + 0, 4);
  u32(dv, noteOffset + 4, descSize);
  u32(dv, noteOffset + 8, NT_GNU_PROPERTY_TYPE_0);
  bytes.set([0x47, 0x4e, 0x55, 0x00], noteOffset + 12);
  // Entry 1: 0x80000001
  u32(dv, noteOffset + 16, GNU_PROPERTY_AARCH64_FEATURE_1_AND);
  u32(dv, noteOffset + 20, 4);
  u32(dv, noteOffset + 24, 0x80000001);
  // Entry 2: 0x80000003
  u32(dv, noteOffset + 32, GNU_PROPERTY_AARCH64_FEATURE_1_AND);
  u32(dv, noteOffset + 36, 4);
  u32(dv, noteOffset + 40, 0x80000003);

  const res = parseAarch64GnuProperty(bytes);
  assert.equal(res.featureBits, 0x80000001);
  assert.ok(res.featureBits >= 0, 'featureBits must remain unsigned 32-bit');
  assert.equal(res.btiRequested, true);
});

/* ── [FF-T6-#4] findImageBase guards against s.address < s.fileOffset ── */
test('[FF-T6-#4] findImageBase never returns a negative BigInt when PT_LOAD has address < fileOffset', () => {
  // Case 1: Only segment has address (0x1000) < fileOffset (0x2000)
  {
    const bytes = new Uint8Array(0x3000);
    const dv = new DataView(bytes.buffer);
    writeElf64Header(bytes, dv, { type: 2, machine: 62, phoff: 64n, phnum: 1 });
    writePhdr64(dv, 64, {
      type: 1, flags: 5, offset: 0x2000n, vaddr: 0x1000n, paddr: 0x1000n,
      filesz: 0x1000n, memsz: 0x1000n, align: 0x1000n,
    });
    const image = parseELF(bytes);
    assert.equal(image.imageBase, 0n);
  }
  // Case 2: One segment with address < fileOffset and one valid segment with address >= fileOffset
  {
    const bytes = new Uint8Array(0x4000);
    const dv = new DataView(bytes.buffer);
    writeElf64Header(bytes, dv, { type: 2, machine: 62, phoff: 64n, phnum: 2 });
    writePhdr64(dv, 64, {
      type: 1, flags: 5, offset: 0x2000n, vaddr: 0x1000n, paddr: 0x1000n,
      filesz: 0x1000n, memsz: 0x1000n, align: 0x1000n,
    });
    writePhdr64(dv, 64 + 56, {
      type: 1, flags: 4, offset: 0x3000n, vaddr: 0x403000n, paddr: 0x403000n,
      filesz: 0x1000n, memsz: 0x1000n, align: 0x1000n,
    });
    const image = parseELF(bytes);
    assert.equal(image.imageBase, 0x400000n);
  }
});

/* ── [FF-T6-#5] ByteView.prototype.findZero preserves 64-bit BigInt offsets past MAX_SAFE_INTEGER ── */
test('[FF-T6-#5] ByteView.findZero returns exact BigInt offset beyond MAX_SAFE_INTEGER', () => {
  const highBase = 0x20000000000000n; // 2^53 (odd offsets cannot be represented as Number)
  const targetOffset = highBase + 3n;
  const totalSize = highBase + 0x100n;
  const backing = {
    __binaryByteBacking: true,
    size: totalSize,
    readAheadSize: 64,
    subarray(start, end) {
      const s = BigInt(start);
      const e = BigInt(end);
      const len = Number(e - s);
      const out = new Uint8Array(len).fill(0x41);
      if (targetOffset >= s && targetOffset < e) {
        out[Number(targetOffset - s)] = 0;
      }
      return out;
    },
  };
  const view = new ByteView(backing, { littleEndian: true });
  const found = view.findZero(highBase, highBase + 0x20n);
  assert.equal(typeof found, 'bigint');
  assert.equal(found, targetOffset);

  // Safe integer range continues to return a Number
  const safeFound = new ByteView({
    __binaryByteBacking: true,
    size: 100n,
    readAheadSize: 32,
    subarray(start, end) {
      const s = Number(start), e = Number(end);
      const out = new Uint8Array(e - s).fill(0x41);
      if (15 >= s && 15 < e) out[15 - s] = 0;
      return out;
    },
  }).findZero(10, 30);
  assert.equal(typeof safeFound, 'number');
  assert.equal(safeFound, 15);
});

/* ── [FF-T6-#6] dyld-shared-cache-core.js: pageStarts enforces maxRecords budget ── */
function makeSlideV2CacheWithExtras(extrasCount) {
  const pageSize = 0x1000;
  const mappingOffset = 0x200;
  const slideMappingOffset = 0x240;
  const slideInfoOffset = 0x300;
  const slideInfoSize = 40 + 2 + extrasCount * 2;
  const dataOffset = 0x1000;
  const totalSize = dataOffset + pageSize;
  const bytes = new Uint8Array(totalSize);
  const dv = new DataView(bytes.buffer);

  // Header: "dyld_v1   arm64\0"
  const magic = 'dyld_v1   arm64\0';
  for (let i = 0; i < magic.length; i++) bytes[i] = magic.charCodeAt(i);
  u32(dv, 16, mappingOffset);       // mappingOffset
  u32(dv, 20, 1);                   // mappingCount
  u32(dv, 24, 0);                   // imagesOffsetOld
  u32(dv, 28, 0);                   // imagesCountOld
  u64(dv, 32, 0x180000000n);        // dyldBaseAddress
  u64(dv, 0xe0, 0x180000000n);      // sharedRegionStart
  u64(dv, 0xe8, 0x100000n);         // sharedRegionSize
  u64(dv, 0xf0, 0x10000000n);       // maxSlide
  u32(dv, 0x138, slideMappingOffset); // mappingWithSlideOffset
  u32(dv, 0x13c, 1);                  // mappingWithSlideCount

  // Mapping 0 (32 bytes): address, size, fileOffset, maxProt, initProt
  u64(dv, mappingOffset + 0, 0x180000000n);
  u64(dv, mappingOffset + 8, BigInt(pageSize));
  u64(dv, mappingOffset + 16, BigInt(dataOffset));
  u32(dv, mappingOffset + 24, 3);
  u32(dv, mappingOffset + 28, 3);

  // MappingWithSlide 0 (56 bytes): address, size, fileOffset, slideInfoFileOffset, slideInfoFileSize, flags, maxProt, initProt
  u64(dv, slideMappingOffset + 0, 0x180000000n);
  u64(dv, slideMappingOffset + 8, BigInt(pageSize));
  u64(dv, slideMappingOffset + 16, BigInt(dataOffset));
  u64(dv, slideMappingOffset + 24, BigInt(slideInfoOffset));
  u64(dv, slideMappingOffset + 32, BigInt(slideInfoSize));
  u64(dv, slideMappingOffset + 40, 0n);
  u32(dv, slideMappingOffset + 48, 3);
  u32(dv, slideMappingOffset + 52, 3);

  // SlideInfo v2 header at slideInfoOffset (40 bytes)
  const startsOff = 40;
  const extrasOff = 42;
  u32(dv, slideInfoOffset + 0, 2);                // version = 2
  u32(dv, slideInfoOffset + 4, pageSize);         // pageSize
  u32(dv, slideInfoOffset + 8, startsOff);        // page_starts_offset
  u32(dv, slideInfoOffset + 12, 1);               // page_starts_count = 1
  u32(dv, slideInfoOffset + 16, extrasOff);       // page_extras_offset
  u32(dv, slideInfoOffset + 20, extrasCount);     // page_extras_count
  u64(dv, slideInfoOffset + 24, 0x00ff000000000000n); // delta_mask
  u64(dv, slideInfoOffset + 32, 0x180000000n);        // value_add

  // page_starts[0] = PAGE_ATTR_EXTRA (0x8000) | 0
  u16(dv, slideInfoOffset + startsOff, 0x8000);
  // page_extras[0..extrasCount-1]: each points to offset (i*2)*4 = i*8 within page; last has PAGE_ATTR_END (0x8000)
  for (let i = 0; i < extrasCount; i++) {
    const wordOff = (i * 2) & 0x3fff;
    const entry = i === extrasCount - 1 ? (0x8000 | wordOff) : wordOff;
    u16(dv, slideInfoOffset + extrasOff + i * 2, entry);
    // Data word at dataOffset + i*8: delta=0, target=0 (null rebase, valid without target range error)
    u64(dv, dataOffset + i * 8, 0n);
  }
  return bytes;
}

test('[FF-T6-#6] dyld shared cache pageStarts enforces maxRebases in sync and async parsers', async () => {
  const oversized = makeSlideV2CacheWithExtras(50);
  assert.throws(
    () => parseDyldSharedCache(oversized, { maxRebases: 10 }),
    /dyld shared cache rebase record budget exceeded/,
  );

  const source = {
    size: BigInt(oversized.length),
    async read(offset, length) {
      const start = Number(offset);
      return oversized.subarray(start, start + length);
    },
  };
  await assert.rejects(
    () => parseDyldSharedCacheSource(source, { maxRebases: 10 }),
    /dyld shared cache rebase record budget exceeded/,
  );

  // Within budget succeeds cleanly in both sync and async paths
  const within = makeSlideV2CacheWithExtras(5);
  const syncImg = parseDyldSharedCache(within, { maxRebases: 5 });
  assert.equal(syncImg.metadata.dyldSharedCache.mappingWithSlide[0].slideInfo.rebaseCount, 5);

  const withinSource = {
    size: BigInt(within.length),
    async read(offset, length) {
      const start = Number(offset);
      return within.subarray(start, start + length);
    },
  };
  const asyncImg = await parseDyldSharedCacheSource(withinSource, { maxRebases: 5 });
  assert.equal(asyncImg.metadata.dyldSharedCache.mappingWithSlide[0].slideInfo.rebaseCount, 5);
});

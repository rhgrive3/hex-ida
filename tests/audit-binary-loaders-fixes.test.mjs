import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { parseMachO } from '../js/binary/macho-core.js';
import { parseCHPELoadConfig } from '../js/binary/pe-chpe.js';
import { prefetchELFRanges } from '../js/binary/elf-prefetch.js';
import { ByteView } from '../js/binary/reader.js';

// ---------------------------------------------------------------------------
// Helpers for synthetic Mach-O 64-bit binary construction
// ---------------------------------------------------------------------------
function buildMachO64({ sectionCount, symbols }) {
  const headerSize = 32;
  const segCmdSize = 72 + sectionCount * 80;
  const symtabCmdSize = 24;
  const sizeofcmds = segCmdSize + symtabCmdSize;

  // Build string table: leading NUL byte + NUL-terminated names
  const enc = new TextEncoder();
  const strParts = [new Uint8Array([0])];
  let strCursor = 1;
  const strOffsets = new Map();
  const internStr = (name) => {
    if (!name) return 0;
    if (strOffsets.has(name)) return strOffsets.get(name);
    const bytes = enc.encode(name);
    const off = strCursor;
    strParts.push(bytes, new Uint8Array([0]));
    strCursor += bytes.length + 1;
    strOffsets.set(name, off);
    return off;
  };

  for (const s of symbols) {
    internStr(s.name);
    if (s.indirectTarget) internStr(s.indirectTarget);
  }

  const strtabSize = strCursor;
  const strtab = new Uint8Array(strtabSize);
  let pos = 0;
  for (const part of strParts) {
    strtab.set(part, pos);
    pos += part.length;
  }

  const sectionDataStart = ((headerSize + sizeofcmds + 15) & ~15);
  const sectionStride = 16;
  const sectionDataSize = sectionCount * sectionStride;
  const symoff = ((sectionDataStart + sectionDataSize + 15) & ~15);
  const symSize = symbols.length * 16;
  const stroff = symoff + symSize;
  const totalSize = stroff + strtabSize;

  const buf = new Uint8Array(totalSize);
  const dv = new DataView(buf.buffer);
  const writeAscii = (offset, str, maxLen) => {
    for (let i = 0; i < str.length && i < maxLen; i++) {
      buf[offset + i] = str.charCodeAt(i);
    }
  };

  // mach_header_64 (little-endian)
  dv.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64
  dv.setInt32(4, 0x0100000c, true);  // CPU_TYPE_ARM64
  dv.setInt32(8, 0, true);           // CPU_SUBTYPE_ARM64_ALL
  dv.setUint32(12, 2, true);         // MH_EXECUTE
  dv.setUint32(16, 2, true);         // ncmds: LC_SEGMENT_64 + LC_SYMTAB
  dv.setUint32(20, sizeofcmds, true);
  dv.setUint32(24, 0, true);
  dv.setUint32(28, 0, true);

  // LC_SEGMENT_64 (__TEXT) covering [0, sectionDataStart + sectionDataSize)
  const vmBase = 0x100000000n;
  const segFileSize = BigInt(sectionDataStart + sectionDataSize);
  let p = headerSize;
  dv.setUint32(p, 0x19, true);             // LC_SEGMENT_64
  dv.setUint32(p + 4, segCmdSize, true);
  writeAscii(p + 8, '__TEXT', 16);
  dv.setBigUint64(p + 24, vmBase, true);
  dv.setBigUint64(p + 32, segFileSize, true);
  dv.setBigUint64(p + 40, 0n, true);
  dv.setBigUint64(p + 48, segFileSize, true);
  dv.setInt32(p + 56, 7, true);            // maxprot
  dv.setInt32(p + 60, 5, true);            // initprot (r-x)
  dv.setUint32(p + 64, sectionCount, true);
  dv.setUint32(p + 68, 0, true);

  let q = p + 72;
  for (let i = 0; i < sectionCount; i++, q += 80) {
    const fileOff = sectionDataStart + i * sectionStride;
    writeAscii(q, `__sec_${i + 1}`, 16);
    writeAscii(q + 16, '__TEXT', 16);
    dv.setBigUint64(q + 32, vmBase + BigInt(fileOff), true);
    dv.setBigUint64(q + 40, BigInt(sectionStride), true);
    dv.setUint32(q + 48, fileOff, true);
    dv.setUint32(q + 52, 4, true);          // align
    dv.setUint32(q + 64, 0x80000000, true); // S_ATTR_PURE_INSTRUCTIONS
  }

  // LC_SYMTAB
  p += segCmdSize;
  dv.setUint32(p, 0x2, true);               // LC_SYMTAB
  dv.setUint32(p + 4, symtabCmdSize, true);
  dv.setUint32(p + 8, symoff, true);
  dv.setUint32(p + 12, symbols.length, true);
  dv.setUint32(p + 16, stroff, true);
  dv.setUint32(p + 20, strtabSize, true);

  // nlist_64 entries
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    const off = symoff + i * 16;
    dv.setUint32(off, internStr(s.name), true);
    dv.setUint8(off + 4, s.type);
    dv.setUint8(off + 5, s.sect);
    dv.setUint16(off + 6, s.desc ?? 0, true);
    const val = s.indirectTarget ? BigInt(internStr(s.indirectTarget)) : BigInt(s.value ?? 0n);
    dv.setBigUint64(off + 8, val, true);
  }

  buf.set(strtab, stroff);
  return { bytes: buf, vmBase, sectionDataStart, sectionStride };
}

// ---------------------------------------------------------------------------
// 1. Mach-O LC_SYMTAB section-ordinal indexed lookup (Finding 4)
// ---------------------------------------------------------------------------
test('Mach-O parseSymbolTable maps valid/invalid section ordinals identically without O(N*S) scan', () => {
  const vmBase = 0x100000000n;
  const { bytes } = buildMachO64({
    sectionCount: 4,
    symbols: [
      { name: '_sym_sec1', type: 0x0f, sect: 1, value: vmBase + 0x200n },
      { name: '_sym_sec4', type: 0x0f, sect: 4, value: vmBase + 0x230n },
      { name: '_sym_bad_high', type: 0x0f, sect: 99, value: vmBase + 0x200n },
      { name: '_sym_bad_zero', type: 0x0f, sect: 0, value: vmBase + 0x200n },
      { name: '_sym_undef', type: 0x01, sect: 0, value: 0n },
      { name: '_sym_common', type: 0x01, sect: 0, value: 64n },
      { name: '_sym_abs', type: 0x03, sect: 0, value: 0x1234n },
      { name: '_sym_indr', type: 0x0b, sect: 0, indirectTarget: '_sym_sec1' },
    ],
  });

  const image = parseMachO(bytes);
  const byName = new Map(image.symbols.map((s) => [s.name, s]));

  assert.equal(byName.get('_sym_sec1')?.sectionIndex, 1);
  assert.equal(byName.get('_sym_sec1')?.kind, 'section');
  assert.equal(byName.get('_sym_sec4')?.sectionIndex, 4);
  assert.equal(byName.get('_sym_sec4')?.kind, 'section');

  // Invalid N_SECT ordinals must be rejected and mark metadata partial
  assert.equal(byName.has('_sym_bad_high'), false);
  assert.equal(byName.has('_sym_bad_zero'), false);
  assert.ok(image.metadata.machoMetadata?.reasons?.includes('symbol-invalid-section-index'));
  assert.ok(image.metadata.machoMetadata?.reasons?.includes('symbol-section-index-out-of-range'));

  // Non-N_SECT symbols must remain unaffected
  assert.equal(byName.get('_sym_undef')?.kind, 'undefined');
  assert.equal(byName.get('_sym_common')?.kind, 'common');
  assert.equal(byName.get('_sym_common')?.size, 64n);
  assert.equal(byName.get('_sym_abs')?.kind, 'other');
  assert.equal(byName.get('_sym_abs')?.address, 0x1234n);
  assert.equal(byName.get('_sym_indr')?.kind, 'indirect');
  assert.equal(byName.get('_sym_indr')?.indirectTarget, '_sym_sec1');
});

test('Mach-O parseSymbolTable scales cleanly with many sections and thousands of symbols', () => {
  const sectionCount = 250;
  const validSymbolCount = 6000;
  const symbols = [];
  const vmBase = 0x100000000n;
  for (let i = 0; i < validSymbolCount; i++) {
    const sect = (i % sectionCount) + 1;
    symbols.push({
      name: `_f_${i}`,
      type: 0x0f, // N_SECT | N_EXT
      sect,
      value: vmBase + BigInt(0x10000 + (sect - 1) * 16),
    });
  }
  // Add a few out-of-range section ordinals
  symbols.push({ name: '_bad_251', type: 0x0f, sect: 251, value: vmBase + 0x10000n });
  symbols.push({ name: '_bad_255', type: 0x0f, sect: 255, value: vmBase + 0x10000n });

  const { bytes } = buildMachO64({ sectionCount, symbols });
  const t0 = performance.now();
  const image = parseMachO(bytes, {
    metadataLimits: {
      inputBytes: 32 * 1024 * 1024,
      records: 100000,
      objects: 100000,
      operations: 500000,
      stringBytes: 8 * 1024 * 1024,
      estimatedHeapBytes: 64 * 1024 * 1024,
    },
  });
  const elapsedMs = performance.now() - t0;

  assert.equal(image.sections.length, sectionCount);
  assert.equal(image.symbols.length, validSymbolCount);
  const byName = new Map(image.symbols.map((s) => [s.name, s]));
  assert.equal(byName.get('_f_0')?.sectionIndex, 1);
  assert.equal(byName.get(`_f_${sectionCount - 1}`)?.sectionIndex, sectionCount);
  assert.equal(byName.has('_bad_251'), false);
  assert.equal(byName.has('_bad_255'), false);
  assert.ok(image.metadata.machoMetadata?.reasons?.includes('symbol-invalid-section-index'));
  assert.ok(elapsedMs < 3000, `Expected fast O(N+S) symbol parsing, took ${elapsedMs.toFixed(1)}ms`);
});

// ---------------------------------------------------------------------------
// 2. PE parseCHPELoadConfig low VA (< imageBase) handling (Finding 5)
// ---------------------------------------------------------------------------
function makeCHPEFixture({ bits = 64, imageBase = 0x140000000n, chpePointerVa }) {
  const buf = new Uint8Array(0x4000);
  const dv = new DataView(buf.buffer);

  // Load config at file offset 0x1000 (RVA 0x1000)
  const loadConfigOff = 0x1000;
  const declared = bits === 64 ? 208 : 144;
  const chpeOffset = bits === 64 ? 200 : 140;
  dv.setUint32(loadConfigOff, declared, true);
  if (bits === 64) {
    dv.setBigUint64(loadConfigOff + chpeOffset, chpePointerVa, true);
  } else {
    dv.setUint32(loadConfigOff + chpeOffset, Number(chpePointerVa & 0xffffffffn), true);
  }

  // Valid IMAGE_ARM64EC_METADATA at file offset 0x2000 (RVA 0x2000)
  const metaRva = 0x2000;
  const mapRva = 0x2100;
  dv.setUint32(metaRva, 1, true);      // Version = 1
  dv.setUint32(metaRva + 4, mapRva, true);
  dv.setUint32(metaRva + 8, 1, true);  // CodeMapCount = 1

  // Valid CHPE code map entry covering [0x3000, 0x3100) type 1 (arm64ec)
  dv.setUint32(mapRva, 0x3000 | 1, true);
  dv.setUint32(mapRva + 4, 0x100, true);

  const partials = [];
  const budget = {
    take: () => true,
    partial: (reason, msg) => partials.push({ reason, msg }),
  };
  const image = {
    format: 'pe',
    bits,
    arch: 'x86_64',
    imageBase,
    metadata: { sizeOfImage: 0x4000 },
    functions: [],
  };
  const mappedFileSpanForRva = (_img, rva, length) => {
    if (rva < 0 || length < 0 || rva + length > buf.length) return null;
    return { start: rva, end: rva + length };
  };

  parseCHPELoadConfig(
    new ByteView(buf, { littleEndian: true }),
    loadConfigOff,
    declared,
    image,
    budget,
    null,
    mappedFileSpanForRva,
  );
  return { image, partials };
}

test('PE parseCHPELoadConfig rejects low VA (< imageBase) instead of aliasing it as an RVA', () => {
  // Valid VA = imageBase + 0x2000n must succeed
  const valid = makeCHPEFixture({
    bits: 64,
    imageBase: 0x140000000n,
    chpePointerVa: 0x140002000n,
  });
  assert.equal(valid.partials.length, 0);
  assert.equal(valid.image.chpeCodeMap.length, 1);
  assert.equal(valid.image.chpeCodeMap[0].startRva, 0x3000);
  assert.equal(valid.image.chpeCodeMap[0].arch, 'arm64ec');

  // Low VA 0x2000n (< imageBase 0x140000000n) aliases the valid metadata RVA 0x2000 — MUST fail closed!
  const lowVa64 = makeCHPEFixture({
    bits: 64,
    imageBase: 0x140000000n,
    chpePointerVa: 0x2000n,
  });
  assert.equal(lowVa64.image.chpeCodeMap.length, 0);
  assert.equal(lowVa64.image.metadata.loadConfig.chpeCodeMapInvalid, true);
  assert.equal(lowVa64.image.metadata.loadConfig.chpeMetadata, null);
  assert.ok(lowVa64.partials.some((p) => p.reason === 'load-config:chpe-codemap-invalid'));

  // 32-bit PE low VA 0x2000n (< imageBase 0x400000n) — MUST fail closed!
  const lowVa32 = makeCHPEFixture({
    bits: 32,
    imageBase: 0x400000n,
    chpePointerVa: 0x2000n,
  });
  assert.equal(lowVa32.image.chpeCodeMap.length, 0);
  assert.equal(lowVa32.image.metadata.loadConfig.chpeCodeMapInvalid, true);
  assert.ok(lowVa32.partials.some((p) => p.reason === 'load-config:chpe-codemap-invalid'));

  // 32-bit PE valid VA = imageBase + 0x2000n — MUST succeed!
  const valid32 = makeCHPEFixture({
    bits: 32,
    imageBase: 0x400000n,
    chpePointerVa: 0x402000n,
  });
  assert.equal(valid32.partials.length, 0);
  assert.equal(valid32.image.chpeCodeMap.length, 1);

  // VA exceeding 32-bit RVA range above imageBase — MUST fail closed!
  const highVa = makeCHPEFixture({
    bits: 64,
    imageBase: 0x140000000n,
    chpePointerVa: 0x240000000n,
  });
  assert.equal(highVa.image.chpeCodeMap.length, 0);
  assert.equal(highVa.image.metadata.loadConfig.chpeCodeMapInvalid, true);
  assert.ok(highVa.partials.some((p) => p.reason === 'load-config:chpe-codemap-invalid'));
});

// ---------------------------------------------------------------------------
// 3. ELF prefetchELFRanges O(N log N) consolidation (Finding 6)
// ---------------------------------------------------------------------------
function makeSyntheticElf64Source({ sections, fileSize }) {
  const headerSize = 64;
  const shentsize = 64;
  const shnum = sections.length;
  const shoff = 64;
  const shTableSize = shnum * shentsize;
  const headerAndSh = new Uint8Array(shoff + shTableSize);
  const dv = new DataView(headerAndSh.buffer);

  // ELF64 little-endian header
  headerAndSh[0] = 0x7f;
  headerAndSh[1] = 0x45;
  headerAndSh[2] = 0x4c;
  headerAndSh[3] = 0x46;
  headerAndSh[4] = 2; // ELFCLASS64
  headerAndSh[5] = 1; // ELFDATA2LSB
  headerAndSh[6] = 1; // EV_CURRENT
  dv.setBigUint64(32, 0n, true);            // e_phoff
  dv.setBigUint64(40, BigInt(shoff), true); // e_shoff
  dv.setUint16(54, 56, true);               // e_phentsize
  dv.setUint16(56, 0, true);                // e_phnum
  dv.setUint16(58, shentsize, true);        // e_shentsize
  dv.setUint16(60, shnum, true);            // e_shnum
  dv.setUint16(62, 0, true);                // e_shstrndx

  for (let i = 0; i < shnum; i++) {
    const s = sections[i];
    const p = shoff + i * shentsize;
    dv.setUint32(p, s.nameOffset ?? 0, true);
    dv.setUint32(p + 4, s.type ?? 0, true);
    dv.setBigUint64(p + 8, BigInt(s.flags ?? 0n), true);
    dv.setBigUint64(p + 16, BigInt(s.addr ?? 0n), true);
    dv.setBigUint64(p + 24, BigInt(s.offset ?? 0n), true);
    dv.setBigUint64(p + 32, BigInt(s.size ?? 0n), true);
    dv.setUint32(p + 40, s.link ?? 0, true);
    dv.setUint32(p + 44, s.info ?? 0, true);
    dv.setBigUint64(p + 56, BigInt(s.entsize ?? 0n), true);
  }

  const sizeBig = BigInt(Math.max(fileSize, headerAndSh.length));
  const source = {
    size: sizeBig,
    maxReadLength: 16 * 1024 * 1024,
    async readExactly(offset, length) {
      const off = Number(offset);
      const out = new Uint8Array(length);
      if (off < headerAndSh.length) {
        const copyLen = Math.min(length, headerAndSh.length - off);
        out.set(headerAndSh.subarray(off, off + copyLen), 0);
      }
      return out;
    },
  };
  return { source, prefix: headerAndSh.subarray(0, 64), shoff, shTableSize };
}

function referenceConsolidate(candidateRanges, maxCachedBytes) {
  const GAP_MERGE_THRESHOLD = 64 * 1024;
  const sorted = [...candidateRanges].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.offset < b.offset) return -1;
    if (a.offset > b.offset) return 1;
    return a.size - b.size;
  });
  let admittedSpans = [];
  let currentBudgetUsed = 0;
  for (const item of sorted) {
    const start = item.offset;
    const end = start + BigInt(item.size);
    let overlap = 0n;
    for (const span of admittedSpans) {
      if (span.start >= end || span.end <= start) continue;
      const lo = span.start > start ? span.start : start;
      const hi = span.end < end ? span.end : end;
      if (hi > lo) overlap += hi - lo;
    }
    const additional = item.size - Number(overlap);
    if (additional <= 0) continue;
    if (currentBudgetUsed + additional > maxCachedBytes) break;
    currentBudgetUsed += additional;
    admittedSpans.push({ start, end });
    admittedSpans.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const consolidated = [];
    for (const span of admittedSpans) {
      if (!consolidated.length) {
        consolidated.push({ start: span.start, end: span.end });
      } else {
        const last = consolidated[consolidated.length - 1];
        if (span.start <= last.end) {
          if (span.end > last.end) last.end = span.end;
        } else {
          consolidated.push({ start: span.start, end: span.end });
        }
      }
    }
    admittedSpans = consolidated;
  }
  if (admittedSpans.length > 1) {
    const coalesced = [admittedSpans[0]];
    for (let i = 1; i < admittedSpans.length; i++) {
      const prev = coalesced[coalesced.length - 1];
      const cur = admittedSpans[i];
      const gap = Number(cur.start - prev.end);
      if (gap >= 0 && gap < GAP_MERGE_THRESHOLD && currentBudgetUsed + gap <= maxCachedBytes) {
        currentBudgetUsed += gap;
        prev.end = cur.end;
      } else {
        coalesced.push({ start: cur.start, end: cur.end });
      }
    }
    admittedSpans = coalesced;
  }
  return admittedSpans;
}

test('ELF prefetchELFRanges produces exact same merged spans and respects tight budget limits', async () => {
  const SHT_SYMTAB = 2;
  const SHT_STRTAB = 3;
  const SHT_NOTE = 7;

  // Sections include:
  // - overlapping Priority 1 (header/shoff)
  // - nested, touching, and partially overlapping Priority 2 ranges
  // - gap < 64 KiB and gap >= 64 KiB
  // - linked SHT_STRTAB and unlinked SHT_STRTAB
  const sections = [
    { type: 0, offset: 0, size: 0 }, // SHT_NULL
    { type: SHT_NOTE, offset: 32, size: 256 },              // overlaps ELF header + shoff (Priority 1)
    { type: SHT_NOTE, offset: 0x100000, size: 0x4000 },     // base span
    { type: SHT_NOTE, offset: 0x101000, size: 0x1000 },     // strictly nested inside previous
    { type: SHT_NOTE, offset: 0x103000, size: 0x3000 },     // partially overlaps previous
    { type: SHT_NOTE, offset: 0x106000, size: 0x1000 },     // touches previous at 0x106000
    { type: SHT_SYMTAB, offset: 0x108000, size: 0x1000, link: 7 }, // gap 0x1000 (< 64 KiB)
    { type: SHT_STRTAB, offset: 0x120000, size: 0x2000 },   // linked from SHT_SYMTAB -> included, gap 0x17000 (>= 64 KiB)
    { type: SHT_STRTAB, offset: 0x140000, size: 0x2000 },   // unlinked -> excluded
    { type: SHT_NOTE, offset: 0x160000, size: 0x5000 },     // later span to test budget cutoff
  ];

  const { source, prefix, shoff, shTableSize } = makeSyntheticElf64Source({
    sections,
    fileSize: 0x200000,
  });

  const expectedCandidates = [
    { offset: 0n, size: 64, priority: 1 },
    { offset: BigInt(shoff), size: shTableSize, priority: 1 },
    { offset: 32n, size: 256, priority: 2 },
    { offset: 0x100000n, size: 0x4000, priority: 2 },
    { offset: 0x101000n, size: 0x1000, priority: 2 },
    { offset: 0x103000n, size: 0x3000, priority: 2 },
    { offset: 0x106000n, size: 0x1000, priority: 2 },
    { offset: 0x108000n, size: 0x1000, priority: 2 },
    { offset: 0x120000n, size: 0x2000, priority: 2 },
    { offset: 0x160000n, size: 0x5000, priority: 2 },
  ];

  for (const maxCachedBytes of [64 * 1024 * 1024, 0x9000, 0x8500, 0x4200, 1024]) {
    const actual = await prefetchELFRanges(source, prefix, { maxCachedBytes });
    const expectedSpans = referenceConsolidate(expectedCandidates, maxCachedBytes);
    assert.deepEqual(
      actual.map((r) => ({ start: r.offset, end: r.offset + BigInt(r.bytes.byteLength) })),
      expectedSpans,
      `Mismatch for maxCachedBytes=${maxCachedBytes}`,
    );
  }
});

test('ELF prefetchELFRanges scales in O(N log N) for thousands of non-contiguous sections', async () => {
  const SHT_NOTE = 7;
  const sectionCount = 4000;
  const stride = 128 * 1024; // > 64 KiB gap so spans remain distinct
  const baseOffset = 1024 * 1024;
  const sections = [{ type: 0, offset: 0, size: 0 }];
  for (let i = 0; i < sectionCount; i++) {
    sections.push({
      type: SHT_NOTE,
      offset: baseOffset + i * stride,
      size: 64,
    });
  }

  const { source, prefix } = makeSyntheticElf64Source({
    sections,
    fileSize: baseOffset + sectionCount * stride + 1024,
  });

  const t0 = performance.now();
  const ranges = await prefetchELFRanges(source, prefix, {
    maxCachedBytes: 64 * 1024 * 1024,
    maxReads: 5000,
  });
  const elapsedMs = performance.now() - t0;

  // 1 consolidated header+shTable span + 4000 distinct SHT_NOTE spans
  assert.equal(ranges.length, sectionCount + 1);
  assert.equal(ranges[1].offset, BigInt(baseOffset));
  assert.equal(ranges[sectionCount].offset, BigInt(baseOffset + (sectionCount - 1) * stride));
  assert.ok(elapsedMs < 3000, `Expected O(N log N) prefetch planning, took ${elapsedMs.toFixed(1)}ms`);
});

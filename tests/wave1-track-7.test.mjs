import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { ByteView } from '../js/binary/reader.js';
import { createMachOMetadataBudget, ensureMachOMetadataBudget } from '../js/binary/macho-budget.js';
import { mappedFileRangeForRva, mappedFileSpanForRva } from '../js/binary/pe-loader.js';
import { parseCHPELoadConfig } from '../js/binary/pe-chpe.js';
import { prefetchELFRanges } from '../js/binary/elf-prefetch.js';
import { parseEhFrameHeader } from '../js/binary/elf-unwind.js';
import { parseChainedImports, parseClassicBindings } from '../js/binary/macho-dyld.js';
import { applyMachOIndirectSymbols } from '../js/binary/macho-indirect-symbols.js';
import { applyMachOTlvInitializers } from '../js/binary/macho-tlv-init.js';
import { demangleRustSymbol, demangleRustLegacy } from '../js/metadata/rust.js';

function loadLegacyMachO() {
  const code = fs.readFileSync(new URL('../js/macho.js', import.meta.url), 'utf8');
  const ctx = {
    BigInt, DataView, Uint8Array, Int32Array, Uint32Array, ArrayBuffer,
    TextDecoder, Map, Set, Math, Number, String, Array, Object,
    Error, RangeError, TypeError, console,
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.runInNewContext(code, ctx, { filename: 'js/macho.js' });
  return ctx.MachO;
}

/* ── [W1-T7-#1] pe-chpe.js: 32-bit CHPE offset 124 and no arm64ec arch overwrite ── */
test('[W1-T7-#1] parseCHPELoadConfig uses offset 124 on 32-bit PE and does not overwrite 32-bit image.arch to arm64ec', () => {
  const buf = new Uint8Array(0x2000);
  const dv = new DataView(buf.buffer);
  // Load Config at file offset 0x1000 (RVA 0x1000): declared size 148
  dv.setUint32(0x1000, 148, true);
  // 32-bit CHPEMetadataPointer at offset 124 (0x7C): VA 0x401200 -> RVA 0x1200
  dv.setUint32(0x1000 + 124, 0x401200, true);
  // CHPE metadata header at 0x1200: version 1, codeMap RVA 0x1300, codeMapCount 1
  dv.setUint32(0x1200, 1, true);
  dv.setUint32(0x1204, 0x1300, true);
  dv.setUint32(0x1208, 1, true);
  // 1 CHPE code map entry at 0x1300: startOffset=(0x1400 | 1) [arm64ec], length=0x100
  dv.setUint32(0x1300, 0x1400 | 1, true);
  dv.setUint32(0x1304, 0x100, true);

  const image = {
    format: 'pe',
    bits: 32,
    arch: 'x86',
    imageBase: 0x400000n,
    sections: [{ name: '.rdata', address: 0x401000n, size: 0x1000n, fileOffset: 0x1000n, fileSize: 0x1000n }],
    segments: [],
    functions: [],
    warnings: [],
    metadata: { sizeOfImage: 0x3000 },
  };
  const budget = ensureMachOMetadataBudget(image);
  parseCHPELoadConfig(new ByteView(buf, { littleEndian: true }), 0x1000, 148, image, budget, mappedFileRangeForRva, mappedFileSpanForRva);
  assert.equal(image.arch, 'x86', '32-bit PE arch must not become arm64ec');
  assert.equal(image.metadata._chpeParsed, true);
  assert.equal(image.chpeCodeMap.length, 1);
  assert.equal(image.metadata.loadConfig.chpeCodeMap[0].arch, 'arm64ec');
});

/* ── [W1-T7-#2] elf-prefetch.js: bounded phTableSize, shTableSize, shstrtab, and gnu_hash ── */
test('[W1-T7-#2] prefetchELFRanges bounds phTableSize, shTableSize, and shstrtab against maxCachedBytes without OOM', async () => {
  const buf = new Uint8Array(256);
  const dv = new DataView(buf.buffer);
  // ELF64 little-endian header
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
  buf[4] = 2; // 64-bit
  buf[5] = 1; // little-endian
  buf[6] = 1;
  dv.setUint16(16, 2, true);
  dv.setUint16(18, 0x3e, true);
  dv.setUint32(20, 1, true);
  dv.setBigUint64(32, 64n, true); // phoff
  dv.setBigUint64(40, 128n, true); // shoff
  dv.setUint16(54, 56, true); // phentsize
  dv.setUint16(56, 1000, true); // phnum -> 56000 bytes > maxCachedBytes
  dv.setUint16(58, 64, true); // shentsize
  dv.setUint16(60, 1000, true); // shnum -> 64000 bytes > maxCachedBytes

  let reads = 0;
  const source = {
    size: 1024n * 1024n,
    async readExactly(offset, length) {
      reads++;
      const start = Number(offset);
      const out = new Uint8Array(length);
      if (start < buf.length) out.set(buf.subarray(start, Math.min(buf.length, start + length)));
      return out;
    },
  };
  const cache = await prefetchELFRanges(source, buf, { maxCachedBytes: 4096 });
  assert.ok(cache);
  assert.ok(reads <= 2, 'must not read oversized ph/sh tables beyond maxCachedBytes');
});

/* ── [W1-T7-#3] macho-dyld.js: parseChainedImports bounds import name scan by budget ── */
test('[W1-T7-#3] parseChainedImports enforces budget during import name scanning', () => {
  const buf = new Uint8Array(0x200);
  const dv = new DataView(buf.buffer);
  // dyld_chained_fixups_header at 0:
  // fixups_version=0, starts_offset=32, imports_offset=48, symbols_offset=64, imports_count=1, imports_format=1 (DYLD_CHAINED_IMPORT)
  dv.setUint32(0, 0, true);
  dv.setUint32(4, 32, true);
  dv.setUint32(8, 48, true);
  dv.setUint32(12, 64, true);
  dv.setUint32(16, 1, true);
  dv.setUint32(20, 1, true);
  // 1 import entry at 48: lib_ordinal=1, weak_import=0, name_offset=0 -> (0 << 9) | 1
  dv.setUint32(48, 1, true);
  // symbols at 64: long non-zero string (no NUL within tight budget)
  buf.fill(0x41, 64, 0x1ff);

  const image = { imports: [], warnings: [], metadata: {} };
  const tightBudget = createMachOMetadataBudget(image, { limits: { inputBytes: 16 } });
  parseChainedImports(new ByteView(buf, { littleEndian: true }), { offset: 0, size: 0x200 }, image, tightBudget);
  assert.equal(image.metadata.chainedFixups.importsComplete, false);
  assert.equal(image.metadata.chainedFixups.importsPartialReason, 'metadata-budget');
  assert.equal(tightBudget.stopped, true);
  assert.equal(image.metadata.machoMetadata.complete, false);
});

/* ── [W1-T7-#4] macho-dyld.js: parseClassicBindings deduplicates warnings and stops repeat on error ── */
test('[W1-T7-#4] parseClassicBindings deduplicates repeated warnings and stops repeat loop on invalid bind', () => {
  // Opcode 0xa0 | 15 (DO_BIND_ADD_ADDR_IMM_SCALED) without symbol set, followed by 0x00 (DONE)
  // Actually 0xc0 + uleb(20) = DO_BIND_ULEB_TIMES_SKIPPING_ULEB (20 repeats with no symbol)
  const buf = new Uint8Array([0xc0, 20, 8, 0x00]);
  const image = { imports: [], warnings: [], metadata: {} };
  parseClassicBindings(new ByteView(buf, { littleEndian: true }), { offset: 0, size: buf.length }, image, [], 'bind');
  assert.equal(image.warnings.length, 1, 'repeated bind failure must not spam duplicate warnings');
  assert.equal(image.metadata.dyldBindings.complete, false);
});

/* ── [W1-T7-#5] macho-indirect-symbols.js: readIndexedSymbol bounds name scan by budget ── */
test('[W1-T7-#5] parseMachOIndirectSymbols stops on metadata-budget when symbol name scan exceeds budget', () => {
  // 64-bit little-endian Mach-O buffer with LC_SYMTAB + LC_DYSYMTAB -> nlist64 -> long string
  const buf = new Uint8Array(0x300);
  const dv = new DataView(buf.buffer);
  // Mach-O 64-bit header at 0x00 (32 bytes)
  dv.setUint32(0x00, 0xfeedfacf, true);
  dv.setUint32(0x04, 0x0100000c, true); // CPU_TYPE_ARM64
  dv.setUint32(0x0c, 2, true);          // MH_EXECUTE
  dv.setUint32(0x10, 2, true);          // ncmds = 2
  dv.setUint32(0x14, 24 + 80, true);    // sizeofcmds = LC_SYMTAB(24) + LC_DYSYMTAB(80)
  // LC_SYMTAB at 0x20 (cmd=0x2, cmdsize=24)
  dv.setUint32(0x20, 0x2, true);
  dv.setUint32(0x24, 24, true);
  dv.setUint32(0x28, 0x120, true);      // symoff
  dv.setUint32(0x2c, 1, true);          // nsyms
  dv.setUint32(0x30, 0x140, true);      // stroff
  dv.setUint32(0x34, 0x180, true);      // strsize
  // LC_DYSYMTAB at 0x38 (cmd=0xb, cmdsize=80)
  dv.setUint32(0x38, 0xb, true);
  dv.setUint32(0x3c, 80, true);
  dv.setUint32(0x38 + 56, 0x100, true); // indirectsymoff
  dv.setUint32(0x38 + 60, 1, true);     // nindirectsyms
  // indirect symtab at 0x100: index 0
  dv.setUint32(0x100, 0, true);
  // nlist64 at 0x120: n_strx=0, n_type=0x01 (N_EXT, N_UNDF=0), n_sect=0, n_desc=0, n_value=0
  dv.setUint32(0x120, 0, true);
  buf[0x124] = 0x01;
  // strtab at 0x140, size 0x180: all 'A's with NUL at end
  buf.fill(0x41, 0x140, 0x2bf);

  const image = {
    bits: 64,
    sections: [{ name: '__stubs', segment: '__TEXT', flags: 0x8, address: 0x1000n, size: 6n, fileOffset: 0x1000n, reserved1: 0, reserved2: 6 }],
    imports: [],
    warnings: [],
    metadata: {},
  };
  const tightBudget = ensureMachOMetadataBudget(image, createMachOMetadataBudget(image, { limits: { inputBytes: 64 } }));
  applyMachOIndirectSymbols(buf, image);
  assert.equal(image.imports.length, 0);
  assert.equal(image.metadata.indirectSymbols.complete, false);
  assert.equal(image.metadata.indirectSymbols.partialReason, 'metadata-budget');
  assert.equal(tightBudget.stopped, true);
  assert.equal(image.metadata.machoMetadata.complete, false);
});

/* ── [W1-T7-#6] elf-unwind.js: decodeEhValue decodes relative format 0x00 as signed ── */
test('[W1-T7-#6] parseEhFrameHeader decodes DW_EH_PE_pcrel | DW_EH_PE_absptr (0x10) as signed relative offset', () => {
  const buf = new Uint8Array(32);
  const dv = new DataView(buf.buffer);
  buf[0] = 1;    // version = 1
  buf[1] = 0x10; // eh_frame_ptr_enc = DW_EH_PE_pcrel | DW_EH_PE_absptr
  buf[2] = 0x03; // fde_count_enc = DW_EH_PE_udata4
  buf[3] = 0x10; // table_enc = DW_EH_PE_pcrel | DW_EH_PE_absptr
  dv.setBigInt64(4, -0x100n, true);  // eh_frame_ptr = 0x2004 + (-0x100) = 0x1f04n
  dv.setUint32(12, 1, true);         // fde_count = 1
  dv.setBigInt64(16, -0x100n, true); // initial_location = 0x2010 + (-0x100) = 0x1f10n
  dv.setBigInt64(24, 0x100n, true);  // fde_ptr
  const image = {
    sections: [
      { name: '.text', address: 0x1f00n, size: 0x100n, offset: 0n, perms: { read: true, write: false, execute: true } },
      { name: '.eh_frame', address: 0x2104n, size: 0x40n, offset: 0n, perms: { read: true, write: false, execute: false } },
    ],
    segments: [
      { name: 'LOAD_EXEC', vaddr: 0x1f00n, memsz: 0x100n, perms: { read: true, write: false, execute: true } },
    ],
    functions: [],
    warnings: [],
    metadata: {},
  };
  parseEhFrameHeader(
    new ByteView(buf, { littleEndian: true }),
    { name: '.eh_frame_hdr', addr: 0x2000n, offset: 0n, size: 32n },
    image,
    64,
  );
  assert.equal(image.metadata.ehFrameHeader.ehFrameAddress, 0x1f04n, 'negative pcrel absptr must resolve to 0x1f04n, not wrap around');
});

/* ── [W1-T7-#7] macho-tlv-init.js: budget exhaustion breaks scan cleanly and records partial ── */
test('[W1-T7-#7] applyMachOTlvInitializers breaks cleanly on budget exhaustion and records metadata', () => {
  const buf = new Uint8Array(0x200);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < 8; i++) dv.setBigUint64(0x100 + i * 8, 0x4000n, true);
  const image = {
    arch: 'arm64',
    bits: 64,
    endian: 'little',
    sections: [
      { name: '__thread_init', segment: '__DATA', address: 0x5000n, size: 64n, fileOffset: 0x100n, fileSize: 64n, flags: 0x15 },
      { name: '__text', segment: '__TEXT', address: 0x4000n, size: 0x20n, fileOffset: 0x40n, fileSize: 0x20n, flags: 0x80000000, perms: { read: true, write: false, execute: true } },
    ],
    segments: [],
    functions: [],
    warnings: [],
    metadata: {},
    sectionAt(addr) { return this.sections.find((s) => addr >= s.address && addr < s.address + s.size) || null; },
    segmentAt() { return null; },
    addressToOffset(addr) { const s = this.sectionAt(addr); return s ? s.fileOffset + (addr - s.address) : null; },
  };
  ensureMachOMetadataBudget(image, createMachOMetadataBudget(image, { limits: { records: 2 } }));
  applyMachOTlvInitializers(buf, image);
  assert.equal(image.metadata.tlvInitializers.length, 2);
});

/* ── [W1-T7-#8] metadata/rust.js: v0 const hex limit & legacy demangler budget ── */
test('[W1-T7-#8] rust.js enforces v0 const hex digit limit and legacy demangler resource budget', () => {
  const longConst = '_RNvC3foo' + 'K' + 'a'.repeat(80) + '_';
  const v0Res = demangleRustSymbol(longConst);
  assert.equal(v0Res.parsed, false);

  const manyComponents = '_ZN' + '1a'.repeat(600) + 'E';
  const legRes = demangleRustLegacy(manyComponents);
  assert.equal(legRes.parsed, false);
  assert.equal(legRes.resourceLimited, true);
  assert.equal(legRes.reason, 'legacy-resource-budget-exceeded');
});

/* ── [W1-T7-#9] macho.js: duplicate LSDA groupEndIdx & 32-bit ObjC method list stride ── */
test('[W1-T7-#9] legacy MachO handles duplicate LSDA entries and 32-bit ObjC method list stride', () => {
  const MachO = loadLegacyMachO();
  // 1. Duplicate LSDA entries sharing the same lsda address both get parsed without zero-length truncation
  // lpEncoding=omit(0xff), ttype=omit(0xff), callSiteEncoding=udata4(0x03), tableLen=16
  const lsdaBuf = new Uint8Array(20);
  lsdaBuf[0] = 0xff; lsdaBuf[1] = 0xff; lsdaBuf[2] = 0x03; lsdaBuf[3] = 16;
  const dvLsda = new DataView(lsdaBuf.buffer);
  dvLsda.setUint32(4, 0x10, true); // start
  dvLsda.setUint32(8, 0x08, true); // len
  dvLsda.setUint32(12, 0x20, true); // lpad (non-zero -> functionStart + 0x20)
  dvLsda.setUint32(16, 0, true); // action
  const pads = MachO.parseLsdaLandingPads(lsdaBuf, 0x1000n, [
    { functionStart: 0x2000n, lsda: 0x1000n },
    { functionStart: 0x3000n, lsda: 0x1000n },
  ]);
  assert.deepEqual(pads, [0x2020n, 0x3020n]);

  // 2. 32-bit ObjC method list (flags=0, entsize=12, count=1)
  const methodBuf = new Uint8Array(24);
  const dv = new DataView(methodBuf.buffer);
  dv.setUint32(0, 12, true); // entsizeAndFlags = 12 (non-relative, 3 * 4-byte ptrs)
  dv.setUint32(4, 1, true);  // count = 1
  dv.setUint32(8, 0x3000, true);  // name
  dv.setUint32(12, 0x4000, true); // types
  dv.setUint32(16, 0x5000, true); // imp (4-byte aligned for armv7/arm64_32)
  const scanned = MachO.parseObjcMethodStarts(methodBuf, 0x2000n, {
    architecture: 'arm64_32',
    pointerBits: 32,
    regions: [
      { section: '__objc_methname', vmAddr: 0x3000n, size: 0x100n },
      { section: '__objc_methtype', vmAddr: 0x4000n, size: 0x100n },
      { exec: true, vmAddr: 0x5000n, size: 0x100n },
    ],
  });
  assert.deepEqual([...scanned], [0x5000n]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { parseMachO } from '../js/binary/macho-core.js';
import { explain, brief, clearBriefCache } from '../js/arm64.js';
import { instructionNote } from '../js/viewer/architecture-presentation.js';
import { CodeViewer } from '../js/viewer.js';

function loadMachO() {
  const code = fs.readFileSync(new URL('../js/macho.js', import.meta.url), 'utf8');
  const sandbox = {
    globalThis: {},
    BigInt, DataView, ArrayBuffer, Uint8Array, BigUint64Array, Int32Array, Uint32Array,
    Map, Set, Math, Number, String, Object, Array, Error, TextDecoder,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.MachO;
}

function writeAscii16(u8, offset, text) {
  for (let i = 0; i < 16; i++) u8[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
}

/**
 * Build a minimal 64-bit ARM64 Mach-O binary.
 * When `truncatedFileSize` < declared segment filesize, simulates a truncated file.
 */
function buildThinMachO64({
  filetype = 2, // MH_EXECUTE
  segFileSize = 4096,
  segVmSize = 4096,
  actualFileSize = 4096,
  withRelocs = false,
} = {}) {
  const hdrSize = 32;
  const segCmdSize = 72 + 80 * (withRelocs ? 2 : 1); // 1 or 2 sections
  const symtabCmdSize = withRelocs ? 24 : 0;
  const sizeofcmds = segCmdSize + symtabCmdSize;
  const ncmds = withRelocs ? 2 : 1;

  const textOff = 512;
  const textSize = 16;
  const cstrOff = 528;
  const cstrSize = 16;
  const relocOff = 600;
  const nreloc = withRelocs ? 2 : 0;
  const symOff = 640;
  const nsyms = withRelocs ? 2 : 0;
  const strOff = 704;
  const strTable = '\0_func_at_zero\0_printf\0';
  const strSize = strTable.length;

  const bufSize = Math.max(actualFileSize, withRelocs ? 800 : actualFileSize);
  const buf = new ArrayBuffer(bufSize);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // mach_header_64
  dv.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64
  dv.setInt32(4, 0x0100000c, true);  // CPU_TYPE_ARM64
  dv.setInt32(8, 0, true);
  dv.setUint32(12, filetype, true);
  dv.setUint32(16, ncmds, true);
  dv.setUint32(20, sizeofcmds, true);
  dv.setUint32(24, 0, true);
  dv.setUint32(28, 0, true);

  // LC_SEGMENT_64
  let off = hdrSize;
  dv.setUint32(off, 0x19, true); // LC_SEGMENT_64
  dv.setUint32(off + 4, segCmdSize, true);
  writeAscii16(u8, off + 8, filetype === 1 ? '' : '__TEXT');
  dv.setBigUint64(off + 24, filetype === 1 ? 0n : 0x100000000n, true); // vmaddr
  dv.setBigUint64(off + 32, BigInt(segVmSize), true);                   // vmsize
  dv.setBigUint64(off + 40, filetype === 1 ? BigInt(textOff) : 0n, true); // fileoff
  dv.setBigUint64(off + 48, BigInt(segFileSize), true);                 // filesize
  dv.setInt32(off + 56, 7, true); // maxprot
  dv.setInt32(off + 60, 5, true); // initprot (r-x)
  dv.setUint32(off + 64, withRelocs ? 2 : 1, true); // nsects
  dv.setUint32(off + 68, 0, true);

  // Section 1: __TEXT,__text
  let s1 = off + 72;
  writeAscii16(u8, s1, '__text');
  writeAscii16(u8, s1 + 16, '__TEXT');
  dv.setBigUint64(s1 + 32, filetype === 1 ? 0n : 0x100000000n + BigInt(textOff), true);
  dv.setBigUint64(s1 + 40, BigInt(textSize), true);
  dv.setUint32(s1 + 48, textOff, true);
  dv.setUint32(s1 + 52, 2, true); // align
  dv.setUint32(s1 + 56, withRelocs ? relocOff : 0, true);
  dv.setUint32(s1 + 60, nreloc, true);
  dv.setUint32(s1 + 64, 0x80000400, true); // S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS

  if (withRelocs) {
    // Section 2: __DATA,__cstring
    let s2 = s1 + 80;
    writeAscii16(u8, s2, '__cstring');
    writeAscii16(u8, s2 + 16, '__DATA');
    dv.setBigUint64(s2 + 32, BigInt(textSize), true);
    dv.setBigUint64(s2 + 40, BigInt(cstrSize), true);
    dv.setUint32(s2 + 48, cstrOff, true);
    dv.setUint32(s2 + 52, 0, true);
    dv.setUint32(s2 + 56, 0, true);
    dv.setUint32(s2 + 60, 0, true);
    dv.setUint32(s2 + 64, 0x2, true); // S_CSTRING_LITERALS

    // LC_SYMTAB
    let lcSym = off + segCmdSize;
    dv.setUint32(lcSym, 0x2, true); // LC_SYMTAB
    dv.setUint32(lcSym + 4, 24, true);
    dv.setUint32(lcSym + 8, symOff, true);
    dv.setUint32(lcSym + 12, nsyms, true);
    dv.setUint32(lcSym + 16, strOff, true);
    dv.setUint32(lcSym + 20, strSize, true);

    // Relocation entries at relocOff (8 bytes each):
    // Entry 0: r_address=0x04, extern=1, sym=1 (_printf), type=3 (ARM64_RELOC_PAGE21), pcrel=1, length=2
    dv.setInt32(relocOff, 0x04, true);
    const info0 = (1 & 0xffffff) | (1 << 24) | (2 << 25) | (1 << 27) | (3 << 28);
    dv.setUint32(relocOff + 4, info0 >>> 0, true);

    // Entry 1: r_address=0x08, extern=0, section=2 (__DATA,__cstring), type=4 (ARM64_RELOC_PAGEOFF12), pcrel=0, length=2
    dv.setInt32(relocOff + 8, 0x08, true);
    const info1 = (2 & 0xffffff) | (0 << 24) | (2 << 25) | (0 << 27) | (4 << 28);
    dv.setUint32(relocOff + 12, info1 >>> 0, true);

    // nlist_64 entries at symOff (16 bytes each):
    // sym 0: _func_at_zero (defined in sect 1 at addr 0)
    dv.setUint32(symOff, 1, true); // n_strx = 1 ("_func_at_zero")
    u8[symOff + 4] = 0x0f; // N_SECT | N_EXT
    u8[symOff + 5] = 1;    // n_sect = 1
    dv.setBigUint64(symOff + 8, 0n, true);

    // sym 1: _printf (N_UNDF | N_EXT)
    dv.setUint32(symOff + 16, 15, true); // n_strx = 15 ("_printf")
    u8[symOff + 20] = 0x01; // N_UNDF | N_EXT
    u8[symOff + 21] = 0;
    dv.setBigUint64(symOff + 24, 0n, true);

    // String table
    for (let i = 0; i < strTable.length; i++) u8[strOff + i] = strTable.charCodeAt(i);
  }

  return buf.slice(0, actualFileSize);
}

test('MachO.parseSlice detects truncated Mach-O segment exceeding file size', () => {
  const MachO = loadMachO();
  // Simulate 2MB truncation: header declares 16MB __TEXT, actual file is 2048 bytes.
  const buf = buildThinMachO64({
    filetype: 2,
    segFileSize: 16 * 1024 * 1024,
    segVmSize: 16 * 1024 * 1024,
    actualFileSize: 2048,
  });
  const info = MachO.parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.equal(info.truncated, true);
  assert.ok(info.diagnostics.some((d) => d.includes('invalid segment file/VM range')));
});

test('MachO.parseFatDetailed detects truncated fat binary while keeping parseFat compatible', () => {
  const MachO = loadMachO();
  const buf = new ArrayBuffer(64);
  const dv = new DataView(buf);
  dv.setUint32(0, 0xcafebabe, false); // FAT_MAGIC
  dv.setUint32(4, 1, false);          // nfat_arch = 1
  dv.setInt32(8, 0x0100000c, false);  // arm64
  dv.setInt32(12, 0, false);
  dv.setUint32(16, 4096, false);      // offset = 4096
  dv.setUint32(20, 8192, false);      // size = 8192 (exceeds 2048-byte file)
  dv.setUint32(24, 14, false);

  assert.equal(MachO.parseFat(buf, 2048n), null, 'parseFat keeps null return on truncated fat');
  const detail = MachO.parseFatDetailed(buf, 2048n);
  assert.equal(detail.truncated, true);
  assert.equal(detail.arches, null);
  assert.ok(detail.warnings.some((w) => /truncated|exceeds/i.test(w)));
});

test('MachO.parseSlice extracts reloff/nreloc and parseSectionRelocations resolves extern & section relocs', () => {
  const MachO = loadMachO();
  const buf = buildThinMachO64({
    filetype: 1, // MH_OBJECT
    segFileSize: 64,
    segVmSize: 64,
    actualFileSize: 800,
    withRelocs: true,
  });
  const info = MachO.parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.equal(info.filetype, 1);
  assert.equal(info.truncated, false);
  const textSec = info.segments[0].sections[0];
  assert.equal(textSec.name, '__text');
  assert.equal(textSec.reloff, 600);
  assert.equal(textSec.nreloc, 2);

  const relocBytes = new Uint8Array(buf, textSec.reloff, textSec.nreloc * 8);
  const relocs = MachO.parseSectionRelocations(
    relocBytes,
    textSec,
    ['_func_at_zero', '_printf'],
    info.segments[0].sections,
    true,
  );
  assert.equal(relocs.length, 2);
  assert.equal(relocs[0].address, 0x04n);
  assert.equal(relocs[0].extern, true);
  assert.equal(relocs[0].symbol, '_printf');
  assert.equal(relocs[0].type, 3);
  assert.equal(relocs[1].address, 0x08n);
  assert.equal(relocs[1].extern, false);
  assert.equal(relocs[1].symbol, '__DATA,__cstring');
  assert.equal(relocs[1].type, 4);

  // 32-bit scattered relocation (bit 31 set) must be safely skipped
  const scat = new Uint8Array(8);
  const sdv = new DataView(scat.buffer);
  sdv.setUint32(0, 0x80000010, true);
  sdv.setUint32(4, 0, true);
  const skipped = MachO.parseSectionRelocations(scat, textSec, [], info.segments[0].sections, false);
  assert.equal(skipped.length, 0);
});

test('macho-core parseMachO populates image.relocations for MH_OBJECT (.o)', () => {
  const buf = buildThinMachO64({
    filetype: 1,
    segFileSize: 64,
    segVmSize: 64,
    actualFileSize: 800,
    withRelocs: true,
  });
  const image = parseMachO(new Uint8Array(buf));
  assert.equal(image.metadata.filetype, 1);
  assert.ok(Array.isArray(image.relocations));
  assert.equal(image.relocations.length, 2);
  assert.equal(image.relocations[0].address, 0x04n);
  assert.equal(image.relocations[0].symbol, '_printf');
  assert.equal(image.relocations[1].address, 0x08n);
  assert.equal(image.relocations[1].symbol, '__DATA,__cstring');
});

test('arm64 explain/brief/instructionNote use relocation symbols and prevent 0-addr function misattribution', () => {
  clearBriefCache();
  const relocs = new Map([
    ['16', { address: 0x10n, symbol: '_printf', type: 3, extern: true }],
    ['32', { address: 0x20n, symbol: '_malloc', type: 3, extern: true }],
  ]);
  const ctx = {
    gen: 1,
    lang: 'ja',
    symbolFor: (addr) => (addr === 0n ? '_func_at_zero' : null),
    isRelocatableObject: true,
    relocationFor: (addr) => (addr == null ? null : (relocs.get(BigInt(addr).toString()) || null)),
  };

  // 1. adrp with resolved relocation
  const eAdrp = explain('adrp', 'x0, #0', 0x10n, ctx);
  assert.equal(eAdrp.target, null);
  assert.match(eAdrp.summary, /_printf/);
  assert.doesNotMatch(eAdrp.summary, /_func_at_zero/);

  // 2. adrp in MH_OBJECT without relocation entry (placeholder 0)
  const eUnresolved = explain('adrp', 'x0, #0', 0x40n, ctx);
  assert.equal(eUnresolved.target, null);
  assert.doesNotMatch(eUnresolved.summary, /_func_at_zero/);
  assert.match(eUnresolved.summary, /再配置|relocat/i);

  // 3. adrp + add pair with relocation on prev.address
  const addNote = instructionNote('arm64', {
    mnemonic: 'add',
    operands: 'x0, x0, #0',
    address: 0x14n,
    style: 'ja',
    context: ctx,
    previous: { mnemonic: 'adrp', operands: 'x0, #0', address: 0x10n },
  });
  assert.match(addNote, /_printf/);
  assert.doesNotMatch(addNote, /_func_at_zero/);

  // 4. adrp + ldr pair with relocation on prev.address
  const ldrNote = instructionNote('arm64', {
    mnemonic: 'ldr',
    operands: 'x1, [x0]',
    address: 0x14n,
    style: 'ja',
    context: ctx,
    previous: { mnemonic: 'adrp', operands: 'x0, #0', address: 0x10n },
  });
  assert.match(ldrNote, /_printf/);
  assert.doesNotMatch(ldrNote, /_func_at_zero/);

  // 5. brief() must not pollute cache across different addresses in .o files
  const b1 = brief('adrp', 'x0, #0', 'ja', ctx, 0x10n);
  const b2 = brief('adrp', 'x0, #0', 'ja', ctx, 0x20n);
  assert.match(b1, /_printf/);
  assert.match(b2, /_malloc/);
  assert.notEqual(b1, b2);

  // 6. Normal executable (not MH_OBJECT, no relocationFor) still resolves 0x100004000n normally
  const normalCtx = {
    gen: 2,
    lang: 'ja',
    symbolFor: (addr) => (addr === 0x100004000n ? '_my_global' : null),
  };
  const eNormal = explain('adrp', 'x0, #0x100004000', 0x100001000n, normalCtx);
  assert.equal(eNormal.target, 0x100004000n);
  assert.match(eNormal.summary, /_my_global/);
});

test('worker-legacy.js wires truncation propagation and MH_OBJECT relocation reading', () => {
  const src = fs.readFileSync(new URL('../js/worker-legacy.js', import.meta.url), 'utf8');
  assert.match(src, /parseFatDetailed/);
  assert.match(src, /readObjectRelocationsForSlice/);
  assert.match(src, /out\.truncated\s*=\s*true/);
  assert.match(src, /MachO\.parseSectionRelocations/);
});

test('ARM64_RELOC_ADDEND + ARM64_RELOC_PAGE21 pair at same address resolves primary symbol without clobbering', () => {
  const MachO = loadMachO();
  // Two 8-byte relocation entries at the SAME r_address = 0x10:
  // Entry 0 (first): ARM64_RELOC_ADDEND (type=10, extern=0, symbolIndex=16 -> addend=+16, NOT section index 16)
  // Entry 1 (second): ARM64_RELOC_PAGE21 (type=3, extern=1, symbolIndex=1 -> "_printf")
  const relocBytes = new Uint8Array(16);
  const dv = new DataView(relocBytes.buffer);
  dv.setInt32(0, 0x10, true);
  dv.setUint32(4, ((16 & 0xffffff) | (0 << 24) | (2 << 25) | (0 << 27) | (10 << 28)) >>> 0, true);
  dv.setInt32(8, 0x10, true);
  dv.setUint32(12, ((1 & 0xffffff) | (1 << 24) | (2 << 25) | (1 << 27) | (3 << 28)) >>> 0, true);

  const section = { name: '__text', segment: '__TEXT', addr: 0n };
  const sections = [section, { name: '__cstring', segment: '__DATA', addr: 0x20n }];
  const parsed = MachO.parseSectionRelocations(relocBytes, section, ['_func_at_zero', '_printf'], sections, true);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].isAddend, true);
  assert.equal(parsed[0].addend, 16);
  assert.equal(parsed[0].symbol, null, 'ADDEND must not resolve addend as a section name');
  assert.equal(parsed[1].symbol, '_printf');

  // Directly test CodeViewer.prototype.setRelocations, _explainCtx, and _noteFor with BigInt row
  const mockViewer = {
    _relocMap: null,
    _isRelocatableObject: false,
    _ctx: null,
    symbols: { gen: 1, nameAt: (a) => (a === 0n ? '_func_at_zero' : null) },
    architectureId: () => 'arm64',
    noteStyle: 'ja',
    rowAddress(r) { return BigInt(r) * 4n; },
    _explainCtx: CodeViewer.prototype._explainCtx,
  };
  CodeViewer.prototype.setRelocations.call(mockViewer, parsed, { isRelocatableObject: true });
  assert.equal(mockViewer._relocMap.get('16').symbol, '_printf', 'setRelocations must prefer PAGE21 over leading ADDEND');

  // Row 5n (addr 0x14) with previous row 4n (addr 0x10 = 16): must not throw TypeError on BigInt row - 1
  const note = CodeViewer.prototype._noteFor.call(mockViewer, 5n, 1, 'add', 'x0, x0, #0', {
    mn: ['adrp', 'add'],
    ops: ['x0, #0', 'x0, x0, #0'],
  });
  assert.match(note, /_printf/);
  assert.doesNotMatch(note, /_func_at_zero/);
});

test('arm64 unresolved MH_OBJECT adrp fallback suppresses misattribution on pages >= 0x1000', () => {
  clearBriefCache();
  const ctx = {
    gen: 3,
    lang: 'ja',
    symbolFor: (addr) => (addr === 0x1000n ? '_func_at_page_1000' : null),
    isRelocatableObject: true,
    relocationFor: () => null,
  };
  const eAdrp = explain('adrp', 'x0, #0x1000', 0x1004n, ctx);
  assert.equal(eAdrp.target, null);
  assert.equal(eAdrp.unresolvedRelocation, true);
  assert.doesNotMatch(eAdrp.summary, /_func_at_page_1000/);

  const addNote = instructionNote('arm64', {
    mnemonic: 'add',
    operands: 'x0, x0, #0',
    address: 0x1008n,
    style: 'ja',
    context: ctx,
    previous: { mnemonic: 'adrp', operands: 'x0, #0x1000', address: 0x1004n },
  });
  assert.doesNotMatch(addNote, /_func_at_page_1000/);
  assert.match(addNote, /再配置|relocat/i);
});

test('ARM64_RELOC_ADDEND merges addend into primary relocation, suppresses standalone addend, and formats +/-0x in arm64 explain', () => {
  clearBriefCache();
  const mockViewer = {
    _relocMap: null,
    _isRelocatableObject: false,
    _ctx: null,
    symbols: { gen: 1, nameAt: (a) => (a === 0n ? '_func_at_zero' : null) },
    architectureId: () => 'arm64',
    noteStyle: 'ja',
    rowAddress(r) { return BigInt(r) * 4n; },
    _explainCtx: CodeViewer.prototype._explainCtx,
  };

  CodeViewer.prototype.setRelocations.call(mockViewer, [
    // Positive addend before primary at 0x10
    { address: 0x10n, type: 10, extern: false, isAddend: true, addend: 0x10, symbol: null },
    { address: 0x10n, type: 3, extern: true, symbol: '_printf' },
    // Negative addend after primary at 0x20
    { address: 0x20n, type: 3, extern: true, symbol: '_malloc' },
    { address: 0x20n, type: 10, extern: false, isAddend: true, addend: -0x18, symbol: null },
    // Standalone addend at 0x30 (must NOT be registered as a primary candidate)
    { address: 0x30n, type: 10, extern: false, isAddend: true, addend: 0x8, symbol: null },
  ], { isRelocatableObject: true });

  assert.equal(mockViewer._relocMap.get('16').symbol, '_printf');
  assert.equal(mockViewer._relocMap.get('16').addend, 0x10);
  assert.equal(mockViewer._relocMap.get('32').symbol, '_malloc');
  assert.equal(mockViewer._relocMap.get('32').addend, -0x18);
  assert.equal(mockViewer._relocMap.get('48'), undefined, 'standalone isAddend must not be returned as primary');

  const ctx = mockViewer._explainCtx();
  const ePos = explain('adrp', 'x0, #0', 0x10n, ctx);
  assert.equal(ePos.target, null);
  assert.match(ePos.pseudo, /_printf \+ 0x10/);
  assert.match(ePos.summary, /_printf \+ 0x10/);

  const eNeg = explain('adrp', 'x1, #0', 0x20n, ctx);
  assert.equal(eNeg.target, null);
  assert.match(eNeg.pseudo, /_malloc - 0x18/);
  assert.match(eNeg.summary, /_malloc - 0x18/);

  // Standalone addend address falls back to unresolved reloc rather than leaking addend entry
  const eStandalone = explain('adrp', 'x2, #0', 0x30n, ctx);
  assert.equal(eStandalone.target, null);
  assert.equal(eStandalone.unresolvedRelocation, true);
});

test('non-ARM64 MH_OBJECT does not misclassify type=10 !extern as ARM64_RELOC_ADDEND', () => {
  const MachO = loadMachO();
  const CPU_TYPE_X86_64 = 0x01000007;

  // 1. MachO.parseSectionRelocations with x86_64 vs arm64
  const relocBytes = new Uint8Array(8);
  const dv = new DataView(relocBytes.buffer);
  dv.setInt32(0, 0x08, true);
  // symbolIndex=2 (section 2), extern=0, type=10
  dv.setUint32(4, ((2 & 0xffffff) | (0 << 24) | (2 << 25) | (0 << 27) | (10 << 28)) >>> 0, true);
  const section = { name: '__text', segment: '__TEXT', addr: 0n };
  const sections = [section, { name: '__cstring', segment: '__DATA', addr: 0x20n }];

  const x64Parsed = MachO.parseSectionRelocations(relocBytes, section, [], sections, true, { cputype: CPU_TYPE_X86_64, architecture: 'x86_64' });
  assert.equal(x64Parsed.length, 1);
  assert.equal(x64Parsed[0].isAddend, undefined);
  assert.equal(x64Parsed[0].symbol, '__DATA,__cstring');

  const armParsed = MachO.parseSectionRelocations(relocBytes, section, [], sections, true, { cputype: MachO.CPU_TYPE_ARM64, architecture: 'arm64' });
  assert.equal(armParsed.length, 1);
  assert.equal(armParsed[0].isAddend, true);
  assert.equal(armParsed[0].addend, 2);
  assert.equal(armParsed[0].symbol, null);

  // 2. macho-core parseMachO with CPU_TYPE_X86_64 MH_OBJECT
  const buf = buildThinMachO64({
    filetype: 1,
    segFileSize: 64,
    segVmSize: 64,
    actualFileSize: 800,
    withRelocs: true,
  });
  const x64Dv = new DataView(buf);
  x64Dv.setInt32(4, CPU_TYPE_X86_64, true);
  // Overwrite Entry 1 at relocOff+8 (608) to type=10, extern=0, section=2
  x64Dv.setUint32(600 + 12, ((2 & 0xffffff) | (0 << 24) | (2 << 25) | (0 << 27) | (10 << 28)) >>> 0, true);
  const image = parseMachO(new Uint8Array(buf));
  assert.equal(image.arch, 'x86_64');
  assert.equal(image.relocations.length, 2);
  assert.equal(image.relocations[1].type, 10);
  assert.equal(image.relocations[1].isAddend, undefined);
  assert.equal(image.relocations[1].symbol, '__DATA,__cstring');
});

test('arm64 HANDLERS.bl and HANDLERS.b resolve MH_OBJECT ARM64_RELOC_BRANCH26 and prevent 0-addr misattribution', () => {
  clearBriefCache();
  const relocs = new Map([
    ['16', { address: 0x10n, symbol: '_printf', type: 2, extern: true }],
    ['32', { address: 0x20n, symbol: '_tail_target', type: 2, extern: true, addend: 4 }],
  ]);
  const ctx = {
    gen: 10,
    lang: 'ja',
    symbolFor: (addr) => (addr === 0n ? '_func_at_zero' : null),
    isRelocatableObject: true,
    relocationFor: (addr) => (addr == null ? null : (relocs.get(BigInt(addr).toString()) || null)),
  };

  // Resolved bl
  const eBl = explain('bl', '#0', 0x10n, ctx);
  assert.equal(eBl.target, null);
  assert.equal(eBl.pseudo, '_printf()');
  assert.match(eBl.summary, /_printf/);
  assert.doesNotMatch(eBl.summary, /_func_at_zero/);

  // Resolved b with addend
  const eB = explain('b', '#0', 0x20n, ctx);
  assert.equal(eB.target, null);
  assert.equal(eB.pseudo, 'goto _tail_target + 0x4');
  assert.match(eB.summary, /_tail_target \+ 0x4/);
  assert.doesNotMatch(eB.summary, /_func_at_zero/);

  // Unresolved bl/b at 0 or self-PC placeholder
  const eUnresBl = explain('bl', '#0', 0x40n, ctx);
  assert.equal(eUnresBl.target, null);
  assert.equal(eUnresBl.unresolvedRelocation, true);
  assert.equal(eUnresBl.pseudo, '<reloc>()');
  assert.doesNotMatch(eUnresBl.summary, /_func_at_zero/);

  const eUnresBSelf = explain('b', '#0x44', 0x44n, ctx);
  assert.equal(eUnresBSelf.target, null);
  assert.equal(eUnresBSelf.unresolvedRelocation, true);
  assert.equal(eUnresBSelf.pseudo, 'goto <reloc>');
});

test('MachO.parseSlice sets info.truncated=true for short load commands and out-of-slice DYSYMTAB/FUNCTION_STARTS/DATA_IN_CODE/ENCRYPTION_INFO', () => {
  const MachO = loadMachO();
  function buildSingleCmdMachO(cmd, cmdsize, writer) {
    const buf = new ArrayBuffer(256);
    const dv = new DataView(buf);
    dv.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64
    dv.setInt32(4, 0x0100000c, true);  // CPU_TYPE_ARM64
    dv.setUint32(12, 2, true);         // MH_EXECUTE
    dv.setUint32(16, 1, true);         // ncmds = 1
    dv.setUint32(20, cmdsize, true);   // sizeofcmds
    dv.setUint32(32, cmd, true);
    dv.setUint32(36, cmdsize, true);
    if (writer) writer(dv, 32);
    return buf;
  }

  // 1. cmdsize < ABI minimum (LC_SYMTAB requires 24, give 16)
  {
    const buf = buildSingleCmdMachO(0x2, 16);
    const info = MachO.parseSlice(buf, 0n, BigInt(buf.byteLength));
    assert.equal(info.truncated, true);
    assert.ok(info.diagnostics.some((d) => d.includes('shorter than ABI minimum')));
  }
  // 2. LC_DYSYMTAB outside slice
  {
    const buf = buildSingleCmdMachO(0xb, 80, (dv, off) => {
      dv.setUint32(off + 56, 512, true); // indirectsymoff > 256
      dv.setUint32(off + 60, 4, true);   // nindirectsyms
    });
    const info = MachO.parseSlice(buf, 0n, BigInt(buf.byteLength));
    assert.equal(info.truncated, true);
    assert.ok(info.diagnostics.some((d) => d.includes('LC_DYSYMTAB')));
  }
  // 3. LC_FUNCTION_STARTS outside slice
  {
    const buf = buildSingleCmdMachO(0x26, 16, (dv, off) => {
      dv.setUint32(off + 8, 512, true);
      dv.setUint32(off + 12, 16, true);
    });
    const info = MachO.parseSlice(buf, 0n, BigInt(buf.byteLength));
    assert.equal(info.truncated, true);
    assert.ok(info.diagnostics.some((d) => d.includes('LC_FUNCTION_STARTS')));
  }
  // 4. LC_DATA_IN_CODE outside slice
  {
    const buf = buildSingleCmdMachO(0x29, 16, (dv, off) => {
      dv.setUint32(off + 8, 512, true);
      dv.setUint32(off + 12, 16, true);
    });
    const info = MachO.parseSlice(buf, 0n, BigInt(buf.byteLength));
    assert.equal(info.truncated, true);
    assert.ok(info.diagnostics.some((d) => d.includes('LC_DATA_IN_CODE')));
  }
  // 5. LC_ENCRYPTION_INFO_64 outside slice
  {
    const buf = buildSingleCmdMachO(0x2c, 24, (dv, off) => {
      dv.setUint32(off + 8, 512, true);
      dv.setUint32(off + 12, 64, true);
      dv.setUint32(off + 16, 1, true);
    });
    const info = MachO.parseSlice(buf, 0n, BigInt(buf.byteLength));
    assert.equal(info.truncated, true);
    assert.equal(info.encrypted, false);
    assert.ok(info.diagnostics.some((d) => d.includes('LC_ENCRYPTION_INFO')));
  }
});

test('panels-base.js relocationFor avoids linear sliceRelocs fallback when _relocMap exists and merges addend', () => {
  const src = fs.readFileSync(new URL('../js/panels-base.js', import.meta.url), 'utf8');
  assert.match(src, /const relocMap = app\.viewer\?\._relocMap;\s*if \(relocMap\)\s*\{\s*const hit = relocMap\.get\?\.\(key\) \|\| null;\s*return hit && !hit\.isAddend \? hit : null;\s*\}/);
  assert.match(src, /if \(r\.isAddend\)/);
  assert.match(src, /addend !== 0 && \(best\.addend == null \|\| best\.addend === 0\)/);
});

test('macho-core readRawMachOSymbolNames interns repeated strx and bounds total decoded bytes', () => {
  // Build an MH_OBJECT with 2000 symbols all pointing to the same strx=1 ("_shared_sym")
  // and one relocation referencing symbol index 1999.
  const nsyms = 2000;
  const hdrSize = 32;
  const segCmdSize = 72 + 80;
  const symtabCmdSize = 24;
  const sizeofcmds = segCmdSize + symtabCmdSize;
  const textOff = 256;
  const relocOff = 288;
  const symOff = 320;
  const strOff = symOff + nsyms * 16;
  const strTable = '\0' + '_shared_sym'.repeat(20) + '\0';
  const totalSize = strOff + strTable.length + 16;

  const buf = new ArrayBuffer(totalSize);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  dv.setUint32(0, 0xfeedfacf, true);
  dv.setInt32(4, 0x0100000c, true);
  dv.setUint32(12, 1, true); // MH_OBJECT
  dv.setUint32(16, 2, true); // ncmds
  dv.setUint32(20, sizeofcmds, true);

  let off = hdrSize;
  dv.setUint32(off, 0x19, true);
  dv.setUint32(off + 4, segCmdSize, true);
  dv.setBigUint64(off + 24, 0n, true);
  dv.setBigUint64(off + 32, 32n, true);
  dv.setBigUint64(off + 40, BigInt(textOff), true);
  dv.setBigUint64(off + 48, 32n, true);
  dv.setInt32(off + 56, 7, true);
  dv.setInt32(off + 60, 5, true);
  dv.setUint32(off + 64, 1, true);

  const s1 = off + 72;
  writeAscii16(u8, s1, '__text');
  writeAscii16(u8, s1 + 16, '__TEXT');
  dv.setBigUint64(s1 + 32, 0n, true);
  dv.setBigUint64(s1 + 40, 16n, true);
  dv.setUint32(s1 + 48, textOff, true);
  dv.setUint32(s1 + 52, 2, true);
  dv.setUint32(s1 + 56, relocOff, true);
  dv.setUint32(s1 + 60, 1, true);
  dv.setUint32(s1 + 64, 0x80000400, true);

  const lcSym = off + segCmdSize;
  dv.setUint32(lcSym, 0x2, true);
  dv.setUint32(lcSym + 4, 24, true);
  dv.setUint32(lcSym + 8, symOff, true);
  dv.setUint32(lcSym + 12, nsyms, true);
  dv.setUint32(lcSym + 16, strOff, true);
  dv.setUint32(lcSym + 20, strTable.length, true);

  // Relocation referencing symbol index 1999
  dv.setInt32(relocOff, 0x04, true);
  dv.setUint32(relocOff + 4, ((1999 & 0xffffff) | (1 << 24) | (2 << 25) | (1 << 27) | (2 << 28)) >>> 0, true);

  for (let i = 0; i < nsyms; i++) {
    dv.setUint32(symOff + i * 16, 1, true); // all point to strx = 1
    u8[symOff + i * 16 + 4] = 0x01; // N_UNDF | N_EXT
  }
  for (let i = 0; i < strTable.length; i++) u8[strOff + i] = strTable.charCodeAt(i);

  const image = parseMachO(new Uint8Array(buf));
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].symbol, '_shared_sym'.repeat(20));

  // Source contract check for intern Map and byte budget cap
  const coreSrc = fs.readFileSync(new URL('../js/binary/macho-core.js', import.meta.url), 'utf8');
  assert.match(coreSrc, /MAX_RAW_SYMBOL_NAME_BYTES\s*=\s*8\s*\*\s*1024\s*\*\s*1024/);
  assert.match(coreSrc, /const intern = new Map\(\)/);
});

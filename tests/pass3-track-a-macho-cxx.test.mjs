import test from 'node:test';
import assert from 'node:assert/strict';

import '../js/macho.js';
import {
  decodeChainedPointer,
  parseChainedBindingSites,
  chainedPointerSites,
} from '../js/binary/macho-dyld.js';
import { parseMachO } from '../js/binary/macho.js';
import { chainedImportSymbols } from '../js/chained.js';
import { ByteView } from '../js/binary/reader.js';
import { MemoryByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/source-loaders.js';
import { buildAppleKnowledge } from '../js/apple/knowledge.js';
import { buildCppClassTypeIndex } from '../js/analysis/cxx/class-type.js';
import { createCppTypedArgumentEvidence } from '../js/analysis/cxx/typed-argument.js';
import { createCxxEvidenceProvider } from '../js/analysis/cxx/project.js';

function setAscii(bytes, offset, text, width = text.length) {
  const encoded = new TextEncoder().encode(text);
  bytes.set(encoded.subarray(0, width), offset);
}

test('P3-S03-001: format 9 (ARM64E_KERNEL) and format 12 (ARM64E_USERLAND24) use 4-byte stride in macho-dyld and chained', () => {
  // Direct decodeChainedPointer stride check
  assert.equal(decodeChainedPointer(0x100n, 1, 0x1000n).stride, 8);
  assert.equal(decodeChainedPointer(0x100n, 7, 0x1000n).stride, 4);
  assert.equal(decodeChainedPointer(0x100n, 9, 0x1000n).stride, 4);
  assert.equal(decodeChainedPointer(0x100n, 10, 0x1000n).stride, 4);
  assert.equal(decodeChainedPointer(0x100n, 12, 0x1000n).stride, 4);

  // Multi-entry chain walk in parseChainedBindingSites for format 12 and format 9:
  // Two consecutive 8-byte GOT bind slots at offsets 0 and 8 -> next = 2 (2 * 4 = 8 bytes).
  for (const format of [9, 12]) {
    const bytes = new Uint8Array(0x1200);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 28, true); // starts_offset
    view.setUint32(28, 1, true); // seg_count
    view.setUint32(32, 8, true); // seg_info_offset[0]
    view.setUint32(36, 24, true); // structSize
    view.setUint16(40, 0x1000, true); // page_size
    view.setUint16(42, format, true); // pointer_format
    view.setBigUint64(44, 0x1000n, true); // segment_offset
    view.setUint32(52, 0, true);
    view.setUint16(56, 1, true); // page_count
    view.setUint16(58, 0, true); // page_start[0] = 0

    // Slot 0 at 0x100: bind=1, next=2 (2 * 4 = 8 bytes -> 0x108), ordinal=0
    const bind0 = (1n << 62n) | (2n << 51n) | 0n;
    // Slot 1 at 0x108: bind=1, next=0 (end of chain), ordinal=1
    const bind1 = (1n << 62n) | (0n << 51n) | 1n;
    view.setBigUint64(0x100, bind0, true);
    view.setBigUint64(0x108, bind1, true);

    const segment = { name: '__DATA', address: 0x2000n, size: 0x1000n, fileOffset: 0x100n, fileSize: 0x1000n };
    const image = {
      arch: 'arm64e',
      imageBase: 0x1000n,
      segments: [segment],
      metadata: { chainedFixups: { version: 0, complete: true, importsComplete: true } },
      warnings: [],
      addressToOffset(address) {
        return address >= segment.address && address < segment.address + segment.fileSize
          ? segment.fileOffset + (address - segment.address)
          : null;
      },
    };
    const imports = [
      { name: '_first_sym', sites: [] },
      { name: '_second_sym', sites: [] },
    ];
    parseChainedBindingSites(new ByteView(bytes), { offset: 0, size: 0x80 }, image, imports, [segment]);
    const sites = chainedPointerSites(image);
    assert.equal(sites.length, 2, `format ${format} must walk both chained slots with 4-byte stride`);
    assert.equal(imports[0].sites.length, 1);
    assert.equal(imports[0].sites[0].address, 0x2000n);
    assert.equal(imports[1].sites.length, 1);
    assert.equal(imports[1].sites[0].address, 0x2008n);
  }
});

test('P3-S03-001: chainedImportSymbols walks format 12 chain with 4-byte stride for __stubs', async () => {
  // Build a minimal 64-bit Mach-O with __TEXT (__stubs), __DATA (__got), and LC_DYLD_CHAINED_FIXUPS (format 12).
  const fileSize = 0x3000;
  const bytes = new Uint8Array(fileSize);
  const dv = new DataView(bytes.buffer);

  // Mach-O 64-bit header (32 bytes)
  const segCmdSize = 72 + 80; // LC_SEGMENT_64 + 1 section_64
  const fixupCmdSize = 16; // LC_DYLD_CHAINED_FIXUPS
  const sizeofcmds = segCmdSize * 2 + fixupCmdSize;
  dv.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64
  dv.setUint32(4, 0x0100000c, true); // CPU_TYPE_ARM64
  dv.setUint32(8, 2, true); // CPU_SUBTYPE_ARM64E
  dv.setUint32(12, 2, true); // MH_EXECUTE
  dv.setUint32(16, 3, true); // ncmds = 3
  dv.setUint32(20, sizeofcmds, true);

  let cmd = 32;
  // LC_SEGMENT_64: __TEXT (vm=0x100000000, fileOff=0, size=0x1000) with __stubs (vm=0x100000800, fileOff=0x800, size=24)
  dv.setUint32(cmd + 0, 0x19, true); // LC_SEGMENT_64
  dv.setUint32(cmd + 4, segCmdSize, true);
  setAscii(bytes, cmd + 8, '__TEXT', 16);
  dv.setBigUint64(cmd + 24, 0x100000000n, true); // vmaddr
  dv.setBigUint64(cmd + 32, 0x1000n, true); // vmsize
  dv.setBigUint64(cmd + 40, 0n, true); // fileoff
  dv.setBigUint64(cmd + 48, 0x1000n, true); // filesize
  dv.setUint32(cmd + 56, 5, true); // maxprot
  dv.setUint32(cmd + 60, 5, true); // initprot
  dv.setUint32(cmd + 64, 1, true); // nsects
  const sec0 = cmd + 72;
  setAscii(bytes, sec0 + 0, '__stubs', 16);
  setAscii(bytes, sec0 + 16, '__TEXT', 16);
  dv.setBigUint64(sec0 + 32, 0x100000800n, true); // addr
  dv.setBigUint64(sec0 + 40, 24n, true); // size
  dv.setUint32(sec0 + 48, 0x800, true); // offset
  dv.setUint32(sec0 + 64, 0x80000408, true); // flags (S_SYMBOL_STUBS)
  dv.setUint32(sec0 + 72, 12, true); // reserved2 (stub size = 12)
  cmd += segCmdSize;

  // LC_SEGMENT_64: __DATA (vm=0x100001000, fileOff=0x1000, size=0x1000) with __got
  dv.setUint32(cmd + 0, 0x19, true); // LC_SEGMENT_64
  dv.setUint32(cmd + 4, segCmdSize, true);
  setAscii(bytes, cmd + 8, '__DATA', 16);
  dv.setBigUint64(cmd + 24, 0x100001000n, true); // vmaddr
  dv.setBigUint64(cmd + 32, 0x1000n, true); // vmsize
  dv.setBigUint64(cmd + 40, 0x1000n, true); // fileoff
  dv.setBigUint64(cmd + 48, 0x1000n, true); // filesize
  dv.setUint32(cmd + 56, 3, true);
  dv.setUint32(cmd + 60, 3, true);
  dv.setUint32(cmd + 64, 1, true); // nsects
  const sec1 = cmd + 72;
  setAscii(bytes, sec1 + 0, '__got', 16);
  setAscii(bytes, sec1 + 16, '__DATA', 16);
  dv.setBigUint64(sec1 + 32, 0x100001000n, true);
  dv.setBigUint64(sec1 + 40, 16n, true);
  dv.setUint32(sec1 + 48, 0x1000, true);
  dv.setUint32(sec1 + 64, 0x6, true);
  cmd += segCmdSize;

  // LC_DYLD_CHAINED_FIXUPS at fileOff=0x2000
  const fixupsOff = 0x2000;
  const fixupsSize = 0x100;
  dv.setUint32(cmd + 0, 0x80000034, true); // LC_DYLD_CHAINED_FIXUPS
  dv.setUint32(cmd + 4, fixupCmdSize, true);
  dv.setUint32(cmd + 8, fixupsOff, true); // dataoff
  dv.setUint32(cmd + 12, fixupsSize, true); // datasize

  // Stub 0 at 0x100000800 -> loads GOT 0x100001000:
  //   adrp x16, #0x1000 (immlo=1 -> bit 29): 0xb0000010
  //   ldr  x16, [x16, #0]:                   0xf9400210
  //   br   x16:                              0xd61f0200
  dv.setUint32(0x800, 0xb0000010, true);
  dv.setUint32(0x804, 0xf9400210, true);
  dv.setUint32(0x808, 0xd61f0200, true);

  // Stub 1 at 0x10000080c -> loads GOT 0x100001008:
  //   adrp x16, #0x1000:                     0xb0000010
  //   ldr  x16, [x16, #8]:                   0xf9400610
  //   br   x16:                              0xd61f0200
  dv.setUint32(0x80c, 0xb0000010, true);
  dv.setUint32(0x810, 0xf9400610, true);
  dv.setUint32(0x814, 0xd61f0200, true);

  // GOT slots at fileOff 0x1000 and 0x1008 (format 12, next=2 -> 2 * 4 = 8 bytes)
  dv.setBigUint64(0x1000, (1n << 62n) | (2n << 51n) | 0n, true);
  dv.setBigUint64(0x1008, (1n << 62n) | (0n << 51n) | 1n, true);

  // Chained fixups header at 0x2000
  const startsOff = 28;
  const importsOff = 68;
  const symbolsOff = 80;
  dv.setUint32(fixupsOff + 0, 0, true); // fixups_version
  dv.setUint32(fixupsOff + 4, startsOff, true);
  dv.setUint32(fixupsOff + 8, importsOff, true);
  dv.setUint32(fixupsOff + 12, symbolsOff, true);
  dv.setUint32(fixupsOff + 16, 2, true); // imports_count
  dv.setUint32(fixupsOff + 20, 1, true); // imports_format = DYLD_CHAINED_IMPORT
  dv.setUint32(fixupsOff + 24, 0, true); // symbols_format

  // starts_in_image (2 segments: __TEXT=0, __DATA=segInfo)
  const st = fixupsOff + startsOff;
  dv.setUint32(st + 0, 2, true); // seg_count = 2
  dv.setUint32(st + 4, 0, true); // seg 0 (__TEXT): no fixups
  dv.setUint32(st + 8, 12, true); // seg 1 (__DATA): offset 12 from starts
  const seg = st + 12;
  dv.setUint32(seg + 0, 24, true); // size
  dv.setUint16(seg + 4, 0x1000, true); // page_size
  dv.setUint16(seg + 6, 12, true); // pointer_format = DYLD_CHAINED_PTR_ARM64E_USERLAND24
  dv.setBigUint64(seg + 8, 0x1000n, true); // segment_offset
  dv.setUint32(seg + 16, 0, true); // max_valid_pointer
  dv.setUint16(seg + 20, 1, true); // page_count
  dv.setUint16(seg + 22, 0, true); // page_start[0] = 0

  // imports (DYLD_CHAINED_IMPORT: name_offset in bits 9..31)
  // symbol 0 at +0: "_alpha\0" (len 7), symbol 1 at +7: "_beta\0"
  dv.setUint32(fixupsOff + importsOff + 0, (0 << 9) | 1, true);
  dv.setUint32(fixupsOff + importsOff + 4, (7 << 9) | 1, true);
  setAscii(bytes, fixupsOff + symbolsOff + 0, '_alpha\0_beta\0');

  const resolved = await chainedImportSymbols(new Blob([bytes]), 0);
  const byAddr = new Map(resolved.map((entry) => [entry.addr, entry.name]));
  assert.equal(byAddr.get(0x100000800n), '_alpha');
  assert.equal(byAddr.get(0x10000080cn), '_beta');
});

test('P3-S06-004: parseEhFrameRanges accepts ARM64e PAC B-key CIE augmentation "zBR"', () => {
  // Construct a minimal .eh_frame with a CIE carrying augmentation "zBR" and one FDE.
  const buf = new Uint8Array(64);
  const dv = new DataView(buf.buffer);
  let p = 0;

  // CIE at offset 0:
  const cieStart = p;
  p += 4;
  dv.setUint32(p, 0, true); p += 4; // CIE_id = 0
  buf[p++] = 1; // version = 1
  setAscii(buf, p, 'zBR\0'); p += 4; // augmentation = "zBR"
  buf[p++] = 4; // code_align = 4
  buf[p++] = 0x78; // data_align = -8 (SLEB)
  buf[p++] = 30; // return_address_register = x30
  buf[p++] = 1; // augmentation data length = 1 ('B' consumes 0 bytes, 'R' consumes 1 byte)
  buf[p++] = 0x1b; // FDE encoding: DW_EH_PE_pcrel (0x10) | DW_EH_PE_sdata4 (0x0b)
  // Pad CIE body to 4-byte boundary
  while ((p - (cieStart + 4)) % 4 !== 0) buf[p++] = 0;
  dv.setUint32(cieStart, p - (cieStart + 4), true);

  // FDE at offset p:
  const fdeStart = p;
  p += 4;
  const ciePtrPos = p;
  dv.setUint32(p, ciePtrPos - cieStart, true); p += 4; // backwards offset to CIE
  const sectionVM = 0x100008000n;
  // initial_location (pcrel sdata4): pc = sectionVM + p; target = 0x100004000n
  const relStart = Number(0x100004000n - (sectionVM + BigInt(p)));
  dv.setInt32(p, relStart, true); p += 4;
  dv.setInt32(p, 0x40, true); p += 4; // address_range = 0x40
  buf[p++] = 0; // augmentation data length = 0
  while ((p - (fdeStart + 4)) % 4 !== 0) buf[p++] = 0;
  dv.setUint32(fdeStart, p - (fdeStart + 4), true);

  // Terminator (length = 0)
  dv.setUint32(p, 0, true); p += 4;

  const ranges = globalThis.MachO.parseEhFrameRanges(buf.subarray(0, p), sectionVM, {
    pointerSize: 8,
    regions: [{ vmAddr: 0x100004000n, size: 0x1000n, exec: true }],
  });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start, 0x100004000n);
  assert.equal(ranges[0].end, 0x100004040n);
});

test('P3-S06-006: parseObjcMethodStarts accepts 32-bit ARM Thumb IMPs (LSB=1) and normalizes to even address', () => {
  const buildMethodList32 = (impValues) => {
    const buf = new Uint8Array(8 + impValues.length * 12);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 12, true); // non-relative stride = 12 (3 x 4B pointers)
    dv.setUint32(4, impValues.length, true);
    for (let i = 0; i < impValues.length; i++) {
      const q = 8 + i * 12;
      dv.setUint32(q + 0, 0x2000 + i * 8, true); // selector in __objc_methname
      dv.setUint32(q + 4, 0x3000 + i * 8, true); // type in __objc_methtype
      dv.setUint32(q + 8, impValues[i], true); // IMP in __text
    }
    return buf;
  };

  const regions = [
    { vmAddr: 0x2000n, size: 0x100n, section: '__objc_methname', exec: false },
    { vmAddr: 0x3000n, size: 0x100n, section: '__objc_methtype', exec: false },
    { vmAddr: 0x4000n, size: 0x1000n, section: '__text', exec: true },
  ];

  // Thumb IMPs (0x4001 and 0x4013) must be accepted and normalized for all 32-bit ARM arch names
  for (const arch of ['arm', 'armv7', 'armv7s', 'armv7k']) {
    const buf = buildMethodList32([0x4001, 0x4013]);
    const starts = globalThis.MachO.parseObjcMethodStarts(buf, 0x8000n, {
      architecture: arch,
      pointerBits: 32,
      regions,
    });
    assert.deepEqual([...starts].sort((a, b) => Number(a - b)), [0x4000n, 0x4012n], `arch=${arch}`);
  }

  // ARM64 must still reject unaligned (odd or 2-byte aligned) IMPs
  const buf64 = new Uint8Array(8 + 24);
  const dv64 = new DataView(buf64.buffer);
  dv64.setUint32(0, 24, true);
  dv64.setUint32(4, 1, true);
  dv64.setBigUint64(8, 0x2000n, true);
  dv64.setBigUint64(16, 0x3000n, true);
  dv64.setBigUint64(24, 0x4001n, true);
  const starts64 = globalThis.MachO.parseObjcMethodStarts(buf64, 0x8000n, {
    architecture: 'arm64',
    pointerBits: 64,
    regions,
  });
  assert.equal(starts64.length, 0, 'arm64 must reject odd/unaligned IMP');
});

test('P3-S02-002: buildAppleKnowledge preserves partial status for deferred large LC_CODE_SIGNATURE', async () => {
  // 1. Produce a genuine deferred partial signature from parseMachOSource with LC_CODE_SIGNATURE > 256 KiB.
  const sigOffset = 0x100;
  const sigSize = 300 * 1024; // > MAX_SOURCE_BACKED_SIGNATURE_BYTES (256 KiB)
  const deferredBytes = new Uint8Array(sigOffset + sigSize);
  const dvDeferred = new DataView(deferredBytes.buffer);
  dvDeferred.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64
  dvDeferred.setUint32(4, 0x0100000c, true); // CPU_TYPE_ARM64
  dvDeferred.setUint32(8, 2, true); // CPU_SUBTYPE_ARM64E
  dvDeferred.setUint32(12, 2, true); // MH_EXECUTE
  dvDeferred.setUint32(16, 1, true); // ncmds = 1
  dvDeferred.setUint32(20, 16, true); // sizeofcmds = 16
  dvDeferred.setUint32(32, 0x1d, true); // LC_CODE_SIGNATURE
  dvDeferred.setUint32(36, 16, true); // cmdsize
  dvDeferred.setUint32(40, sigOffset, true); // dataoff
  dvDeferred.setUint32(44, sigSize, true); // datasize
  const deferredImage = await parseMachOSource(new MemoryByteSource(deferredBytes));
  assert.equal(deferredImage.metadata.codeSignature.status, 'partial');
  assert.ok(deferredImage.metadata.codeSignature.reasons.includes('signature-bytes-deferred'));

  // 2. Attach the partial codeSignature to an authoritative, complete resident Mach-O image
  // so buildAppleKnowledge exercises identityAuthoritative=true && machoComplete=true && signature.status==='partial'.
  const residentBytes = new Uint8Array(0x100);
  const dvRes = new DataView(residentBytes.buffer);
  dvRes.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64
  dvRes.setUint32(4, 0x0100000c, true); // CPU_TYPE_ARM64
  dvRes.setUint32(8, 2, true); // CPU_SUBTYPE_ARM64E
  dvRes.setUint32(12, 2, true); // MH_EXECUTE
  dvRes.setUint32(16, 0, true); // ncmds = 0
  dvRes.setUint32(20, 0, true); // sizeofcmds = 0
  const residentImage = parseMachO(residentBytes);
  residentImage.metadata.codeSignature = deferredImage.metadata.codeSignature;

  const knowledge = buildAppleKnowledge({ image: residentImage });
  assert.equal(knowledge.identity.authoritative, true);
  assert.equal(knowledge.cells.codeSigning.status, 'partial');
  assert.equal(knowledge.cells.codeSigning.complete, false);
  assert.equal(knowledge.complete, false);
  assert.ok(knowledge.reasons.includes('codeSigning:signature-bytes-deferred'));
});

test('P3-S01-001: buildCppClassTypeIndex recognizes Mach-O (__ZN...) constructor and destructor symbols', () => {
  const symbols = {
    funcs: [0x1000n, 0x2000n, 0x3000n],
    addrs: [0x1000n, 0x2000n, 0x3000n],
    names: ['__ZN6PlayerC1Ev', '__ZN3Foo3BarD1Ev', '_ZN5EnemyC2Ei'],
  };
  const index = buildCppClassTypeIndex({ symbols, snapshotId: 'snap-macho-1' });
  assert.equal(index.has('Player'), true);
  assert.equal(index.get('Player').symbol, '__ZN6PlayerC1Ev');
  assert.equal(index.has('Foo::Bar'), true);
  assert.equal(index.get('Foo::Bar').symbol, '__ZN3Foo3BarD1Ev');
  assert.equal(index.has('Enemy'), true);
  assert.equal(index.get('Enemy').symbol, '_ZN5EnemyC2Ei');
});

test('P3-S01-002: createCppTypedArgumentEvidence and createCxxEvidenceProvider support Mach-O (__Z / __ZL) symbols', async () => {
  const pubProof = createCppTypedArgumentEvidence({
    symbol: '__Z6updateP6Player',
    functionAddress: 0x4000n,
    architecture: 'arm64',
  });
  assert.ok(pubProof);
  assert.equal(pubProof.symbol, '__Z6updateP6Player');
  assert.equal(pubProof.functionName, 'update');
  assert.equal(pubProof.className, 'Player');
  assert.equal(pubProof.pointeeConst, false);
  assert.equal(pubProof.internalLinkage, undefined);

  const localProof = createCppTypedArgumentEvidence({
    symbol: '__ZL10get_healthPK6Playeri',
    functionAddress: 0x4100n,
    architecture: 'arm64',
  });
  assert.ok(localProof);
  assert.equal(localProof.symbol, '__ZL10get_healthPK6Playeri');
  assert.equal(localProof.functionName, 'get_health');
  assert.equal(localProof.className, 'Player');
  assert.equal(localProof.pointeeConst, true);
  assert.equal(localProof.internalLinkage, true);
  assert.equal(localProof.parameterCount, 2);

  // End-to-end projection through createCxxEvidenceProvider with Mach-O symbols
  const symbols = {
    funcs: [0x1000n, 0x4000n],
    addrs: [0x1000n, 0x4000n],
    names: ['__ZN6PlayerC1Ev', '__Z6updateP6Player'],
  };
  const provider = createCxxEvidenceProvider({
    symbols,
    read: async () => null,
    architecture: 'arm64',
    snapshotId: 'snap-macho-2',
  });
  await provider.build();
  const projection = provider.projectForFunction({
    functionId: 'sub_4000',
    functionAddress: 0x4000n,
    ir: {
      values: [{ id: 'v0', kind: 'arg', reg: 'x0', label: 'x0', bits: 64 }],
      instructions: [],
    },
    enableTypedArguments: true,
  });
  assert.ok(projection, 'Mach-O typed-argument function must produce a canonical projection');
  assert.equal(projection.receiver.receiverRole, 'typed-argument');
  assert.equal(projection.receiver.classIdentity.className, 'Player');
  assert.equal(projection.receiver.argumentProof.symbol, '__Z6updateP6Player');
});

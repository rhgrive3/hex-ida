import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMachO, DICE_KIND_DATA, DICE_KIND_JUMP_TABLE8, DICE_KIND_JUMP_TABLE16, DICE_KIND_JUMP_TABLE32, DICE_KIND_ABS_JUMP_TABLE32 } from '../../../js/binary/macho.js';

function buildMacho64({
  cpu = 0x0100000c, // ARM64
  subtype = 0,
  filetype = 2, // MH_EXECUTE
  textAddr = 0x1000n,
  textSize = 0x1000n,
  textOffset = 0,
  textFileSize = 0x218,
  codeAddr = 0x1200n,
  codeOffset = 0x200,
  codeSize = 12,
  codeBytes = [
    0x1f, 0x20, 0x03, 0xd5, // nop
    0x00, 0x00, 0x00, 0x14, // b . (0x14000000)
    0xc0, 0x03, 0x5f, 0xd6, // ret
  ],
  withDataInCode = true,
  dataInCodeOffset = 0x210,
  dataInCodeSize = null,
  dataInCodeEntries = [
    { offset: 0x204, length: 4, kind: 1 }, // DICE_KIND_DATA
  ],
  totalSize = null,
} = {}) {
  const actualDicSize = dataInCodeSize != null ? dataInCodeSize : (dataInCodeEntries.length * 8);
  const totalCmdSize = 152 + 24 + (withDataInCode ? 16 : 0);
  const ncmds = 2 + (withDataInCode ? 1 : 0);
  const calculatedFileSize = Math.max(0x218, codeOffset + codeSize, (withDataInCode && dataInCodeOffset < 0x10000) ? dataInCodeOffset + actualDicSize : 0);
  const totalFileSize = totalSize != null ? totalSize : calculatedFileSize;
  const actualTextFileSize = Math.max(textFileSize, totalFileSize);

  const bytes = new Uint8Array(totalFileSize);
  const v = new DataView(bytes.buffer);
  const u32 = (o, x) => v.setUint32(o, x, true);
  const i32 = (o, x) => v.setInt32(o, x, true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  // mach_header_64
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0); // MH_MAGIC_64
  i32(4, cpu);
  i32(8, subtype);
  u32(12, filetype);
  u32(16, ncmds);
  u32(20, totalCmdSize);
  u32(24, 0);
  u32(28, 0);

  // LC_SEGMENT_64: __TEXT
  let p = 32;
  u32(p, 0x19); // LC_SEGMENT_64
  u32(p + 4, 152); // cmdsize
  put(p + 8, '__TEXT');
  u64(p + 24, textAddr);
  u64(p + 32, textSize);
  u64(p + 40, BigInt(textOffset));
  u64(p + 48, BigInt(actualTextFileSize));
  i32(p + 56, 7); // maxprot: rwx
  i32(p + 60, 5); // initprot: rx
  u32(p + 64, 1); // nsects
  u32(p + 68, 0);

  // section_64: __text
  let q = p + 72;
  put(q, '__text');
  put(q + 16, '__TEXT');
  u64(q + 32, codeAddr);
  u64(q + 40, BigInt(codeSize));
  u32(q + 48, codeOffset);
  u32(q + 52, 2); // align = 2^2 = 4
  u32(q + 56, 0);
  u32(q + 60, 0);
  u32(q + 64, 0x80000400); // S_ATTR_SOME_INSTRUCTIONS | S_ATTR_PURE_INSTRUCTIONS

  p += 152;

  // LC_MAIN
  u32(p, 0x80000028); // LC_MAIN
  u32(p + 4, 24);
  u64(p + 8, BigInt(codeOffset)); // entryoff
  u64(p + 16, 0); // stacksize

  p += 24;

  // LC_DATA_IN_CODE
  if (withDataInCode) {
    u32(p, 0x29); // LC_DATA_IN_CODE
    u32(p + 4, 16);
    u32(p + 8, dataInCodeOffset);
    u32(p + 12, actualDicSize);
    p += 16;
  }

  // Code bytes
  if (codeBytes && codeBytes.length) {
    bytes.set(codeBytes, codeOffset);
  }

  // Data in code entries
  if (withDataInCode && dataInCodeEntries) {
    let ep = dataInCodeOffset;
    for (const e of dataInCodeEntries) {
      if (ep + 8 <= bytes.length) {
        u32(ep, e.offset);
        v.setUint16(ep + 4, e.length, true);
        v.setUint16(ep + 6, e.kind, true);
        ep += 8;
      }
    }
  }

  return bytes;
}

test('1. ARM64 thin Mach-O reproduction: one DICE_KIND_DATA word -> published data-in-code interval, no instruction decode at 0x1204', () => {
  const bytes = buildMacho64();
  const image = parseMachO(bytes);

  assert.ok(Array.isArray(image.metadata.dataInCode), 'image.metadata.dataInCode must be an array');
  assert.equal(image.metadata.dataInCode.length, 1);
  const entry = image.metadata.dataInCode[0];
  assert.equal(entry.offset, 0x204);
  assert.equal(entry.length, 4);
  assert.equal(entry.kind, DICE_KIND_DATA);
  assert.equal(entry.kindName, 'DICE_KIND_DATA');
  assert.equal(entry.address, 0x1204n);

  assert.equal(image.isDataInCode(0x1204n), true);
  assert.equal(image.isDataInCode(0x1200n), false);
  assert.equal(image.isDataInCode(0x1208n), false);

  assert.equal(image.isInstructionAllowed(0x1204n), false, 'instruction decode must not be allowed at 0x1204');
  assert.equal(image.isInstructionAllowed(0x1200n), true, 'instruction decode is allowed at 0x1200 (nop)');
  assert.equal(image.isInstructionAllowed(0x1208n), true, 'instruction decode is allowed at 0x1208 (ret)');

  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.warnings.length, 0);
});

test('2. Same bytes with LC_DATA_IN_CODE command absent -> normal instruction decoding remains allowed', () => {
  const bytes = buildMacho64({ withDataInCode: false });
  const image = parseMachO(bytes);

  assert.equal(image.metadata.dataInCode, undefined, 'dataInCode metadata must be undefined when command is absent');
  assert.equal(image.dataInCode.length, 0);
  assert.equal(image.isDataInCode(0x1204n), false);
  assert.equal(image.isInstructionAllowed(0x1204n), true, 'without LC_DATA_IN_CODE 0x1204 is allowed as instruction');
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.warnings.length, 0);
});

test('3. All five defined DICE_KIND_* kinds are retained with correct interval/kind', () => {
  const bytes = buildMacho64({
    codeSize: 40,
    codeBytes: new Uint8Array(40),
    dataInCodeOffset: 0x250,
    dataInCodeEntries: [
      { offset: 0x200, length: 4, kind: DICE_KIND_DATA },
      { offset: 0x204, length: 4, kind: DICE_KIND_JUMP_TABLE8 },
      { offset: 0x208, length: 4, kind: DICE_KIND_JUMP_TABLE16 },
      { offset: 0x20c, length: 4, kind: DICE_KIND_JUMP_TABLE32 },
      { offset: 0x210, length: 4, kind: DICE_KIND_ABS_JUMP_TABLE32 },
    ],
  });
  const image = parseMachO(bytes);

  assert.equal(image.metadata.dataInCode.length, 5);
  const kinds = image.metadata.dataInCode.map((e) => e.kind);
  const names = image.metadata.dataInCode.map((e) => e.kindName);
  assert.deepEqual(kinds, [1, 2, 3, 4, 5]);
  assert.deepEqual(names, [
    'DICE_KIND_DATA',
    'DICE_KIND_JUMP_TABLE8',
    'DICE_KIND_JUMP_TABLE16',
    'DICE_KIND_JUMP_TABLE32',
    'DICE_KIND_ABS_JUMP_TABLE32',
  ]);
  assert.equal(image.metadata.machoMetadata.complete, true);
});

test('4. Multiple sorted valid records are retained without merging away their kind boundaries', () => {
  const bytes = buildMacho64({
    codeSize: 20,
    codeBytes: new Uint8Array(20),
    dataInCodeOffset: 0x250,
    dataInCodeEntries: [
      { offset: 0x200, length: 4, kind: DICE_KIND_DATA },
      { offset: 0x204, length: 8, kind: DICE_KIND_JUMP_TABLE32 },
    ],
  });
  const image = parseMachO(bytes);

  assert.equal(image.metadata.dataInCode.length, 2, 'adjacent records must not be merged');
  assert.equal(image.metadata.dataInCode[0].length, 4);
  assert.equal(image.metadata.dataInCode[0].kind, DICE_KIND_DATA);
  assert.equal(image.metadata.dataInCode[1].length, 8);
  assert.equal(image.metadata.dataInCode[1].kind, DICE_KIND_JUMP_TABLE32);
});

test('5. dataoff/datasize outside the file -> partial diagnostic; no out-of-range read', () => {
  const bytes = buildMacho64({
    totalSize: 0x218,
    dataInCodeOffset: 0x90000, // outside file
    dataInCodeSize: 16,
  });
  const image = parseMachO(bytes);

  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.metadata.machoMetadata.reasons.some((r) => r.includes('data-in-code')));
  assert.ok(image.warnings.some((w) => w.includes('LC_DATA_IN_CODE')));
});

test('6. datasize % 8 != 0 -> partial/truncated diagnostic', () => {
  const bytes = buildMacho64({
    dataInCodeOffset: 0x210,
    dataInCodeSize: 12, // 12 bytes = 1 entry (8) + 4 dangling
    dataInCodeEntries: [
      { offset: 0x204, length: 4, kind: DICE_KIND_DATA },
    ],
  });
  const image = parseMachO(bytes);

  // Recovers the 1 full entry safely
  assert.equal(image.metadata.dataInCode.length, 1);
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.metadata.machoMetadata.reasons.some((r) => r.includes('data-in-code')));
  assert.ok(image.warnings.some((w) => w.includes('LC_DATA_IN_CODE')));
});

test('7. entry offset + length overflow/outside the selected Mach-O slice -> partial diagnostic', () => {
  const bytes = buildMacho64({
    dataInCodeOffset: 0x210,
    dataInCodeEntries: [
      { offset: 0x90000, length: 4, kind: DICE_KIND_DATA }, // offset exceeds slice
    ],
  });
  const image = parseMachO(bytes);

  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.metadata.machoMetadata.reasons.some((r) => r.includes('data-in-code')));
});

test('8. ARM64 data range starting/ending inside instruction-width boundaries prevents instruction start in covered bytes', () => {
  const bytes = buildMacho64({
    dataInCodeEntries: [
      { offset: 0x205, length: 2, kind: DICE_KIND_DATA }, // bytes 0x205..0x207 (VA 0x1205..0x1207)
    ],
  });
  const image = parseMachO(bytes);

  // The 4-byte instruction slot [0x1204, 0x1208) contains [0x1205, 0x1207), so instruction cannot start at 0x1204
  assert.equal(image.isInstructionAllowed(0x1204n), false, 'overlapping data range must prevent instruction start at 0x1204');
  assert.equal(image.isInstructionAllowed(0x1200n), true, 'uncovered slot 0x1200 is allowed');
  assert.equal(image.isInstructionAllowed(0x1208n), true, 'uncovered slot 0x1208 is allowed');
});

test('9. Fat Mach-O: offsets are interpreted relative to selected thin Mach-O slice, not outer container', () => {
  const thinSlice = buildMacho64();
  const sliceOffset = 0x4000;
  const fatBytes = new Uint8Array(sliceOffset + thinSlice.length);
  const dv = new DataView(fatBytes.buffer);

  // Fat header: FAT_MAGIC (0xcafebabe), 1 architecture
  dv.setUint32(0, 0xcafebabe, false); // big-endian
  dv.setUint32(4, 1, false); // nfat_arch = 1

  // fat_arch: cputype (ARM64 = 0x0100000c), cpusubtype (0), offset, size, align
  dv.setUint32(8, 0x0100000c, false);
  dv.setUint32(12, 0, false);
  dv.setUint32(16, sliceOffset, false);
  dv.setUint32(20, thinSlice.length, false);
  dv.setUint32(24, 14, false); // 2^14 = 16384 (ARM64 page size)

  fatBytes.set(thinSlice, sliceOffset);

  const image = parseMachO(fatBytes);
  assert.ok(Array.isArray(image.metadata.dataInCode));
  assert.equal(image.metadata.dataInCode.length, 1);
  const entry = image.metadata.dataInCode[0];
  assert.equal(entry.offset, 0x204, 'offset is relative to thin slice');
  assert.equal(entry.address, 0x1204n, 'maps to virtual address within thin slice');
  assert.equal(image.isInstructionAllowed(0x1204n), false);
  assert.equal(image.isInstructionAllowed(0x1200n), true);
});

test('10. Ordinary Mach-O without LC_DATA_IN_CODE remains unchanged', () => {
  const bytes = buildMacho64({ withDataInCode: false });
  const image = parseMachO(bytes);

  assert.equal(image.metadata.dataInCode, undefined);
  assert.equal(image.dataInCode.length, 0);
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.warnings.length, 0);
});

test('11. Minimal reproduction from issue #8124', () => {
  const out = new Uint8Array(0x218);
  const v = new DataView(out.buffer);
  const u32 = (o, x) => v.setUint32(o, x, true);
  const i32 = (o, x) => v.setInt32(o, x, true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => out.set(Buffer.from(s), o);

  // Header: 0xfeedfacf, 0x0100000c, 0, 2, 3, 152 + 24 + 16, 0, 0
  u32(0, 0xfeedfacf);
  i32(4, 0x0100000c);
  i32(8, 0);
  u32(12, 2);
  u32(16, 3);
  u32(20, 152 + 24 + 16);
  u32(24, 0);
  u32(28, 0);

  // Segment __TEXT
  let p = 32;
  u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__TEXT');
  u64(p + 24, 0x1000); u64(p + 32, 0x1000);
  u64(p + 40, 0); u64(p + 48, 0x218);
  i32(p + 56, 7); i32(p + 60, 5); u32(p + 64, 1); u32(p + 68, 0);

  // Section __text
  let q = p + 72;
  put(q, '__text'); put(q + 16, '__TEXT');
  u64(q + 32, 0x1200); u64(q + 40, 12);
  u32(q + 48, 0x200); u32(q + 52, 2);
  u32(q + 56, 0); u32(q + 60, 0);
  u32(q + 64, 0x80000400); u32(q + 68, 0);

  p += 152;
  // LC_MAIN
  u32(p, 0x80000028); u32(p + 4, 24); u64(p + 8, 0x200); u64(p + 16, 0);

  p += 24;
  // LC_DATA_IN_CODE
  u32(p, 0x29); u32(p + 4, 16); u32(p + 8, 0x210); u32(p + 12, 8);

  // AArch64: nop ; word 0x14000000 ; ret
  out.set(Buffer.from('1f2003d500000014c0035fd6', 'hex'), 0x200);
  // data_in_code_entry { offset=0x204, length=4, kind=DICE_KIND_DATA }
  u32(0x210, 0x204);
  v.setUint16(0x214, 4, true);
  v.setUint16(0x216, 1, true);

  const image = parseMachO(out);
  assert.equal(image.isDataInCode(0x1204n), true);
  assert.equal(image.isInstructionAllowed(0x1204n), false);
  assert.equal(image.isInstructionAllowed(0x1200n), true);
  assert.equal(image.isInstructionAllowed(0x1208n), true);
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.warnings.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMachO } from '../../../js/binary/macho.js';

function buildMacho64({
  tuples = [[0x1180n, 0x1184n]],
  interposeFlags = 0x0d,
  interposeName = '__interpose',
  interposeSegment = '__DATA',
  interposeSize = null,
  withInterpose = true,
  codeSize = 8,
  textFileSize = 0x200,
} = {}) {
  const headerSize = 32;
  const segmentCommandSize = 152;
  const ncmds = withInterpose ? 2 : 1;
  const sizeofcmds = ncmds * segmentCommandSize;
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, Number(x) >>> 0, true);
  const i32 = (o, x) => view.setInt32(o, Number(x), true);
  const u64 = (o, x) => view.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  i32(4, 0x0100000c); // CPU_TYPE_ARM64
  i32(8, 0);
  u32(12, 6); // MH_DYLIB
  u32(16, ncmds);
  u32(20, sizeofcmds);
  u32(24, 0);
  u32(28, 0);

  let p = headerSize;
  // __TEXT + __text
  u32(p, 0x19);
  u32(p + 4, segmentCommandSize);
  put(p + 8, '__TEXT');
  u64(p + 24, 0x1000n);
  u64(p + 32, 0x1000n);
  u64(p + 40, 0n);
  u64(p + 48, BigInt(textFileSize));
  i32(p + 56, 5);
  i32(p + 60, 5);
  u32(p + 64, 1);
  const q = p + 72;
  put(q, '__text');
  put(q + 16, '__TEXT');
  u64(q + 32, 0x1180n);
  u64(q + 40, BigInt(codeSize));
  u32(q + 48, 0x180);
  u32(q + 52, 2);
  u32(q + 64, 0x80000400);

  if (withInterpose) {
    p += segmentCommandSize;
    const encodedSize = interposeSize == null ? tuples.length * 16 : interposeSize;
    u32(p, 0x19);
    u32(p + 4, segmentCommandSize);
    put(p + 8, interposeSegment);
    u64(p + 24, 0x2000n);
    u64(p + 32, 0x1000n);
    u64(p + 40, 0x200n);
    u64(p + 48, 0x100n);
    i32(p + 56, 3);
    i32(p + 60, 3);
    u32(p + 64, 1);
    const dq = p + 72;
    put(dq, interposeName);
    put(dq + 16, interposeSegment);
    u64(dq + 32, 0x2000n);
    u64(dq + 40, BigInt(encodedSize));
    u32(dq + 48, 0x200);
    u32(dq + 52, 3);
    u32(dq + 64, interposeFlags);

    for (let i = 0; i < tuples.length; i++) {
      u64(0x200 + i * 16, tuples[i][0]);
      u64(0x208 + i * 16, tuples[i][1]);
    }
  }

  u32(0x180, 0xd65f03c0);
  u32(0x184, 0xd65f03c0);
  return bytes;
}

function interposeReasons(image) {
  return image.metadata.machoMetadata?.reasons?.filter((reason) => String(reason).startsWith('interpose:')) ?? [];
}

test('valid S_INTERPOSING tuple publishes loader metadata and exact replacement function', () => {
  const image = parseMachO(buildMacho64());
  assert.equal(image.metadata.interpose.length, 1);
  assert.deepEqual(image.metadata.interpose[0], {
    section: '__interpose',
    segment: '__DATA',
    source: 'S_INTERPOSING',
    tupleAddress: 0x2000n,
    replacementSlotAddress: 0x2000n,
    replaceeSlotAddress: 0x2008n,
    rawReplacement: 0x1180n,
    rawReplacee: 0x1184n,
    replacement: 0x1180n,
    replacee: 0x1184n,
    replaceeImport: null,
    valid: true,
  });
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, 0x1180n);
  assert.equal(image.functions[0].source, 'interpose');
  assert.equal(image.functions[0].exactFunctionStart, true);
  assert.match(image.functions[0].functionStartEvidence, /S_INTERPOSING/);
  assert.equal(image.metadata.machoMetadata.complete, true);
});

test('conventional __DATA,__interpose fallback is recognized even with S_REGULAR type', () => {
  const image = parseMachO(buildMacho64({ interposeFlags: 0 }));
  assert.equal(image.metadata.interpose.length, 1);
  assert.equal(image.metadata.interpose[0].source, '__DATA,__interpose');
  assert.equal(image.metadata.interpose[0].valid, true);
  assert.deepEqual(image.functions.map((f) => f.address), [0x1180n]);
});

test('malformed tuple tail is partial and never fabricates a second tuple', () => {
  const image = parseMachO(buildMacho64({ interposeSize: 24 }));
  assert.equal(image.metadata.interpose.length, 1);
  assert.equal(image.metadata.interpose[0].valid, true);
  assert.ok(interposeReasons(image).some((reason) => reason === 'interpose:truncated-section'));
  assert.equal(image.metadata.machoMetadata.complete, false);
});

test('unmapped replacement is retained as invalid metadata but not function authority', () => {
  const image = parseMachO(buildMacho64({ tuples: [[0x3000n, 0x1184n]] }));
  assert.equal(image.metadata.interpose.length, 1);
  assert.equal(image.metadata.interpose[0].replacement, null);
  assert.equal(image.metadata.interpose[0].valid, false);
  assert.equal(image.functions.length, 0);
  assert.ok(interposeReasons(image).some((reason) => reason === 'interpose:replacement-unresolved'));
});

test('non-executable replacement is rejected fail-closed', () => {
  const image = parseMachO(buildMacho64({ tuples: [[0x2000n, 0x1184n]] }));
  assert.equal(image.metadata.interpose[0].replacement, 0x2000n);
  assert.equal(image.metadata.interpose[0].valid, false);
  assert.equal(image.functions.length, 0);
  assert.ok(interposeReasons(image).some((reason) => reason === 'interpose:replacement-not-instruction'));
});

test('ARM64-misaligned replacement is rejected fail-closed', () => {
  const image = parseMachO(buildMacho64({ tuples: [[0x1182n, 0x1184n]] }));
  assert.equal(image.metadata.interpose[0].replacement, 0x1182n);
  assert.equal(image.metadata.interpose[0].valid, false);
  assert.equal(image.functions.length, 0);
  assert.ok(interposeReasons(image).some((reason) => reason === 'interpose:replacement-not-instruction'));
});

test('duplicate tuples preserve relations but dedupe canonical replacement seed', () => {
  const image = parseMachO(buildMacho64({ tuples: [[0x1180n, 0x1184n], [0x1180n, 0x1184n]] }));
  assert.equal(image.metadata.interpose.length, 2);
  assert.equal(image.metadata.interpose.every((entry) => entry.valid), true);
  assert.deepEqual(image.functions.map((f) => f.address), [0x1180n]);
});

test('binary without an interpose section is unchanged', () => {
  const image = parseMachO(buildMacho64({ withInterpose: false }));
  assert.equal(image.metadata.interpose, undefined);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.machoMetadata.complete, true);
});


test('replacement whose first ARM64 instruction is not fully file-backed is rejected', () => {
  const image = parseMachO(buildMacho64({
    tuples: [[0x1180n, 0x1184n]],
    codeSize: 2,
    textFileSize: 0x182,
  }));
  assert.equal(image.metadata.interpose[0].replacement, 0x1180n);
  assert.equal(image.metadata.interpose[0].valid, false);
  assert.equal(image.functions.length, 0);
  assert.ok(interposeReasons(image).includes('interpose:replacement-not-instruction'));
});

test('chained-fixup rebase at replacement slot resolves through canonical pointer authority', () => {
  const bytes = buildMacho64();
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, Number(x) >>> 0, true);
  const u64 = (o, x) => view.setBigUint64(o, BigInt(x), true);

  // Add LC_DYLD_CHAINED_FIXUPS after the two 152-byte segment commands.
  u32(16, 3);
  u32(20, 152 * 2 + 16);
  const cmd = 32 + 152 * 2;
  u32(cmd, 0x80000034);
  u32(cmd + 4, 16);
  u32(cmd + 8, 0x300);
  u32(cmd + 12, 0x80);

  // dyld_chained_fixups_header
  u32(0x300, 0);
  u32(0x304, 0x20); // starts_offset
  u32(0x308, 0);    // imports_offset, imports_count=0
  u32(0x30c, 0);    // symbols_offset
  u32(0x310, 0);
  u32(0x314, 1);    // imports_format
  u32(0x318, 0);    // symbols_format

  // starts_in_image: two segments; __DATA has one page chain beginning at +0.
  u32(0x320, 2);
  u32(0x324, 0);
  u32(0x328, 12);
  u32(0x32c, 24);
  view.setUint16(0x330, 0x1000, true);
  view.setUint16(0x332, 6, true); // DYLD_CHAINED_PTR_64_OFFSET
  u64(0x334, 0x1000n);           // __DATA vmaddr 0x2000 - imageBase 0x1000
  u32(0x33c, 0);
  view.setUint16(0x340, 1, true);
  view.setUint16(0x342, 0, true);

  // Encoded vm-offset 0x180 -> canonical target 0x1180.
  u64(0x200, 0x180n);

  const image = parseMachO(bytes);
  assert.equal(image.metadata.interpose[0].rawReplacement, 0x180n);
  assert.equal(image.metadata.interpose[0].replacement, 0x1180n);
  assert.equal(image.metadata.interpose[0].valid, true);
  assert.deepEqual(image.functions.map((f) => f.address), [0x1180n]);
});

test('externally bound replacee preserves import identity without dropping valid replacement', () => {
  const bytes = buildMacho64({ tuples: [[0x1180n, 0n]] });
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, Number(x) >>> 0, true);

  // Add LC_DYLD_INFO_ONLY ending exactly where __text file bytes begin.
  u32(16, 3);
  u32(20, 152 * 2 + 48);
  const cmd = 32 + 152 * 2;
  u32(cmd, 0x80000022);
  u32(cmd + 4, 48);
  const weak = Buffer.from([0x40, 0x5f, 0x6f, 0x6c, 0x64, 0x00, 0x51, 0x71, 0x08, 0x90, 0x00]);
  u32(cmd + 24, 0x300);
  u32(cmd + 28, weak.length);
  bytes.set(weak, 0x300);

  const image = parseMachO(bytes);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].name, '_old');
  assert.equal(image.imports[0].ordinal, -3);
  const tuple = image.metadata.interpose[0];
  assert.equal(tuple.replacee, null);
  assert.deepEqual(tuple.replaceeImport, {
    name: '_old',
    library: '<weak-lookup>',
    ordinal: -3,
    weak: false,
    source: 'weak-bind',
  });
  assert.equal(tuple.valid, true);
  assert.deepEqual(image.functions.map((f) => f.address), [0x1180n]);
});

function buildMacho32Interpose() {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, Number(x) >>> 0, true);
  const i32 = (o, x) => view.setInt32(o, Number(x), true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  bytes.set([0xce, 0xfa, 0xed, 0xfe], 0);
  i32(4, 7); // CPU_TYPE_I386
  i32(8, 3);
  u32(12, 6);
  u32(16, 2);
  u32(20, 124 * 2);
  u32(24, 0);

  let p = 28;
  u32(p, 1);
  u32(p + 4, 124);
  put(p + 8, '__TEXT');
  u32(p + 24, 0x1000);
  u32(p + 28, 0x1000);
  u32(p + 32, 0);
  u32(p + 36, 0x200);
  i32(p + 40, 5);
  i32(p + 44, 5);
  u32(p + 48, 1);
  let q = p + 56;
  put(q, '__text');
  put(q + 16, '__TEXT');
  u32(q + 32, 0x1180);
  u32(q + 36, 2);
  u32(q + 40, 0x180);
  u32(q + 44, 0);
  u32(q + 56, 0x80000400);

  p += 124;
  u32(p, 1);
  u32(p + 4, 124);
  put(p + 8, '__DATA');
  u32(p + 24, 0x2000);
  u32(p + 28, 0x1000);
  u32(p + 32, 0x200);
  u32(p + 36, 0x100);
  i32(p + 40, 3);
  i32(p + 44, 3);
  u32(p + 48, 1);
  q = p + 56;
  put(q, '__interpose');
  put(q + 16, '__DATA');
  u32(q + 32, 0x2000);
  u32(q + 36, 8);
  u32(q + 40, 0x200);
  u32(q + 44, 2);
  u32(q + 56, 0x0d);

  bytes[0x180] = 0xc3;
  bytes[0x181] = 0xc3;
  u32(0x200, 0x1180);
  u32(0x204, 0x1181);
  return bytes;
}

test('32-bit Mach-O decodes S_INTERPOSING as two 4-byte pointers', () => {
  const image = parseMachO(buildMacho32Interpose());
  assert.equal(image.metadata.interpose.length, 1);
  assert.equal(image.metadata.interpose[0].replacementSlotAddress, 0x2000n);
  assert.equal(image.metadata.interpose[0].replaceeSlotAddress, 0x2004n);
  assert.equal(image.metadata.interpose[0].replacement, 0x1180n);
  assert.equal(image.metadata.interpose[0].replacee, 0x1181n);
  assert.equal(image.metadata.interpose[0].valid, true);
  assert.deepEqual(image.functions.map((f) => f.address), [0x1180n]);
});

test('independent LC_FUNCTION_STARTS evidence merges with interpose provenance without duplicate functions', () => {
  const bytes = buildMacho64();
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, Number(x) >>> 0, true);

  u32(16, 3);
  u32(20, 152 * 2 + 16);
  const cmd = 32 + 152 * 2;
  u32(cmd, 0x26); // LC_FUNCTION_STARTS
  u32(cmd + 4, 16);
  u32(cmd + 8, 0x300);
  u32(cmd + 12, 3);
  bytes.set([0x80, 0x03, 0x00], 0x300); // imageBase + 0x180 -> 0x1180, then terminator

  const image = parseMachO(bytes);
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, 0x1180n);
  assert.ok(image.functions[0].sources.includes('function_starts'));
  assert.ok(image.functions[0].sources.includes('interpose'));
  assert.equal(image.metadata.interpose[0].valid, true);
});

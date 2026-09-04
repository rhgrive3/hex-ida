import test from 'node:test';
import assert from 'node:assert/strict';
import { openBinary } from '../js/binary/index.js';
import { MemoryByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/source-loaders.js';

const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;

function makeThinSlice({ cpu = CPU_ARM64, subtype = 0, filetype = 2, size = 64 } = {}) {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64 LE
  v.setInt32(4, cpu, true);
  v.setInt32(8, subtype, true);
  v.setUint32(12, filetype, true);
  v.setUint32(16, 0, true);
  v.setUint32(20, 0, true);
  v.setUint32(24, 0, true);
  v.setUint32(28, 0, true);
  return b;
}

function makeFatBinary(slices, { magic = 0xcafebabe, totalSize = null } = {}) {
  const is64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  const isLE = magic === 0xbebafeca || magic === 0xbfbafeca;
  const entrySize = is64 ? 32 : 20;
  let maxEnd = 8 + slices.length * entrySize;
  for (const s of slices) {
    if (s.offset + s.data.length > maxEnd) {
      maxEnd = s.offset + s.data.length;
    }
  }
  const size = totalSize ?? Math.max(maxEnd, 0x10000);
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  if (magic === 0xcafebabe) {
    b.set([0xca, 0xfe, 0xba, 0xbe], 0);
  } else if (magic === 0xbebafeca) {
    b.set([0xbe, 0xba, 0xfe, 0xca], 0);
  } else if (magic === 0xcafebabf) {
    b.set([0xca, 0xfe, 0xba, 0xbf], 0);
  } else if (magic === 0xbfbafeca) {
    b.set([0xbf, 0xba, 0xfe, 0xca], 0);
  }
  v.setUint32(4, slices.length, isLE);
  let p = 8;
  for (const s of slices) {
    v.setInt32(p, s.cpu, isLE);
    v.setInt32(p + 4, s.subtype, isLE);
    if (is64) {
      v.setBigUint64(p + 8, BigInt(s.offset), isLE);
      v.setBigUint64(p + 16, BigInt(s.data.length), isLE);
      v.setUint32(p + 24, s.align, isLE);
      v.setUint32(p + 28, 0, isLE);
      p += 32;
    } else {
      v.setUint32(p + 8, s.offset, isLE);
      v.setUint32(p + 12, s.data.length, isLE);
      v.setUint32(p + 16, s.align, isLE);
      p += 20;
    }
    b.set(s.data, s.offset);
  }
  return b;
}

test('#6314 reject duplicate arm64 architecture slices in universal container', () => {
  const s1 = { cpu: CPU_ARM64, subtype: 0, align: 14, offset: 0x4000, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0 }) };
  const s2 = { cpu: CPU_ARM64, subtype: 0, align: 14, offset: 0x8000, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0 }) };
  const fat = makeFatBinary([s1, s2]);

  assert.throws(
    () => openBinary(fat),
    /Mach-O universal binary contains duplicate arm64 architecture/
  );
});

test('#6314 reject duplicate x86_64 architecture slices in universal container', () => {
  const s1 = { cpu: CPU_X86_64, subtype: 3, align: 12, offset: 0x1000, data: makeThinSlice({ cpu: CPU_X86_64, subtype: 3 }) };
  const s2 = { cpu: CPU_X86_64, subtype: 3, align: 12, offset: 0x2000, data: makeThinSlice({ cpu: CPU_X86_64, subtype: 3 }) };
  const fat = makeFatBinary([s1, s2]);

  assert.throws(
    () => openBinary(fat),
    /Mach-O universal binary contains duplicate x86_64 architecture/
  );
});

test('#6314 allow distinct arm64 and arm64e slices without duplicate error', () => {
  const sArm64 = { cpu: CPU_ARM64, subtype: 0, align: 14, offset: 0x4000, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0 }) };
  const sArm64e = { cpu: CPU_ARM64, subtype: 2, align: 14, offset: 0x8000, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 2 }) };
  const fat = makeFatBinary([sArm64, sArm64e]);

  const img = openBinary(fat);
  assert.ok(img, 'successfully opens multi-arch binary with arm64 and arm64e');
  assert.equal(img.metadata.fat.slices.length, 2);
  assert.equal(img.metadata.fat.selected.arch, 'arm64e');
});

test('#6314 reject duplicate architecture in little-endian FAT container', () => {
  const s1 = { cpu: CPU_ARM64, subtype: 0, align: 14, offset: 0x4000, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0 }) };
  const s2 = { cpu: CPU_ARM64, subtype: 0, align: 14, offset: 0x8000, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0 }) };
  const fatLE = makeFatBinary([s1, s2], { magic: 0xbebafeca });

  assert.throws(
    () => openBinary(fatLE),
    /Mach-O universal binary contains duplicate arm64 architecture/
  );
});

test('#6314 reject duplicate architecture in source-backed loader', async () => {
  const s1 = { cpu: CPU_ARM64, subtype: 0, align: 14, offset: 0x4000, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0 }) };
  const s2 = { cpu: CPU_ARM64, subtype: 0, align: 14, offset: 0x8000, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0 }) };
  const fat = makeFatBinary([s1, s2]);

  await assert.rejects(
    parseMachOSource(new MemoryByteSource(fat)),
    /Mach-O universal binary contains duplicate arm64 architecture/
  );
});

test('#6314 reject overlapping slices in universal container', () => {
  const s1 = { cpu: CPU_X86_64, subtype: 3, align: 2, offset: 0x1000, data: makeThinSlice({ cpu: CPU_X86_64, subtype: 3, filetype: 1, size: 0x80 }) };
  const s2 = { cpu: CPU_ARM64, subtype: 0, align: 2, offset: 0x1040, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0, filetype: 1, size: 0x80 }) };
  const fat = makeFatBinary([s1, s2]);

  assert.throws(
    () => openBinary(fat),
    /Mach-O universal binary slices overlap/
  );
});

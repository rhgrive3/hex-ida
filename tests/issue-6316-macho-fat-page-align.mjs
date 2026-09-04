import test from 'node:test';
import assert from 'node:assert/strict';
import { openBinary } from '../js/binary/index.js';
import { MemoryByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/source-loaders.js';
import { validateFatSlice } from '../js/binary/macho-fat.js';

const CPU_X86_64 = 0x01000007;
const CPU_ARM = 12;
const CPU_ARM64 = 0x0100000c;
const CPU_SUBTYPE_ARM_V7K = 12;

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
  b.set([0xca, 0xfe, 0xba, 0xbe], 0);
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

test('#6316 reject arm64 final-image slice with 4KB (non-16KB) alignment', () => {
  const s = { cpu: CPU_ARM64, subtype: 0, align: 12, offset: 0x1000, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0, filetype: 2 }) };
  const fat = makeFatBinary([s]);

  assert.throws(
    () => openBinary(fat),
    /Mach-O universal binary slice is not page aligned/
  );
});

test('#6316 accept arm64 final-image slice with 16KB alignment', () => {
  const s = { cpu: CPU_ARM64, subtype: 0, align: 14, offset: 0x4000, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0, filetype: 2 }) };
  const fat = makeFatBinary([s]);

  const img = openBinary(fat);
  assert.ok(img);
  assert.equal(img.metadata.fat.selected.arch, 'arm64');
  assert.equal(img.metadata.fat.selected.offset, 0x4000n);
});

test('#6316 reject armv7k final image at 4KB-only alignment', () => {
  assert.throws(
    () => validateFatSlice(
      { cpu: CPU_ARM, subtype: CPU_SUBTYPE_ARM_V7K, align: 12, offset: 0x1000n, size: 0x40n },
      { cpu: CPU_ARM, subtype: CPU_SUBTYPE_ARM_V7K, filetype: 2 },
      0x10000n,
    ),
    /Mach-O universal binary slice is not page aligned/,
  );
});

test('#6316 accept armv7k final image at 16KB alignment', () => {
  assert.doesNotThrow(() => validateFatSlice(
    { cpu: CPU_ARM, subtype: CPU_SUBTYPE_ARM_V7K, align: 14, offset: 0x4000n, size: 0x40n },
    { cpu: CPU_ARM, subtype: CPU_SUBTYPE_ARM_V7K, filetype: 2 },
    0x10000n,
  ));
});

test('#6316 reject x86_64 final-image slice with misaligned offset', () => {
  const s = { cpu: CPU_X86_64, subtype: 3, align: 10, offset: 0x400, data: makeThinSlice({ cpu: CPU_X86_64, subtype: 3, filetype: 2 }) };
  const fat = makeFatBinary([s]);

  assert.throws(
    () => openBinary(fat),
    /Mach-O universal binary slice is not page aligned/
  );
});

test('#6316 accept x86_64 final-image slice with 4KB alignment', () => {
  const s = { cpu: CPU_X86_64, subtype: 3, align: 12, offset: 0x1000, data: makeThinSlice({ cpu: CPU_X86_64, subtype: 3, filetype: 2 }) };
  const fat = makeFatBinary([s]);

  const img = openBinary(fat);
  assert.ok(img);
  assert.equal(img.metadata.fat.selected.arch, 'x86_64');
  assert.equal(img.metadata.fat.selected.offset, 0x1000n);
});

test('#6316 allow MH_OBJECT slice without 4KB/16KB page alignment', () => {
  const s = { cpu: CPU_ARM64, subtype: 0, align: 2, offset: 0x100, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0, filetype: 1 }) };
  const fat = makeFatBinary([s]);

  const img = openBinary(fat);
  assert.ok(img);
  assert.equal(img.metadata.fat.selected.offset, 0x100n);
});

test('#6316 distinguish declared align failure from page alignment failure', () => {
  const sDeclaredBad = { cpu: CPU_X86_64, subtype: 3, align: 14, offset: 0x1000, data: makeThinSlice({ cpu: CPU_X86_64, subtype: 3, filetype: 2 }) };
  const fat = makeFatBinary([sDeclaredBad]);

  assert.throws(
    () => openBinary(fat),
    /Mach-O universal binary slice is not aligned to declared align/
  );
});

test('#6316 enforce page alignment in source-backed loader', async () => {
  const s = { cpu: CPU_ARM64, subtype: 0, align: 12, offset: 0x1000, data: makeThinSlice({ cpu: CPU_ARM64, subtype: 0, filetype: 2 }) };
  const fat = makeFatBinary([s]);

  await assert.rejects(
    parseMachOSource(new MemoryByteSource(fat)),
    /Mach-O universal binary slice is not page aligned/
  );
});

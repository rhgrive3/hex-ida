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

function makeFatWithHiddenArm64({ corruptCandidate = false, isFat64 = false, candidateSubtype = 0 } = {}) {
  const size = 0x10000;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);

  const x86Data = makeThinSlice({ cpu: CPU_X86_64, subtype: 3, filetype: 2, size: 64 });
  const armData = makeThinSlice({ cpu: CPU_ARM64, subtype: candidateSubtype, filetype: 2, size: 64 });
  b.set(x86Data, 0x1000);
  b.set(armData, 0x4000);

  if (isFat64) {
    b.set([0xca, 0xfe, 0xba, 0xbf], 0);
    v.setUint32(4, 1, false); // declared count = 1
    // entry 0: x86_64
    v.setInt32(8, CPU_X86_64, false);
    v.setInt32(12, 3, false);
    v.setBigUint64(16, 0x1000n, false);
    v.setBigUint64(24, 64n, false);
    v.setUint32(32, 12, false);
    // past-end entry at 8 + 32 = 40
    v.setInt32(40, CPU_ARM64, false);
    v.setInt32(44, candidateSubtype, false);
    v.setBigUint64(48, 0x4000n, false);
    v.setBigUint64(56, 64n, false);
    v.setUint32(64, 14, false);
  } else {
    b.set([0xca, 0xfe, 0xba, 0xbe], 0);
    v.setUint32(4, 1, false); // declared count = 1
    // entry 0: x86_64
    v.setInt32(8, CPU_X86_64, false);
    v.setInt32(12, 3, false);
    v.setUint32(16, 0x1000, false);
    v.setUint32(20, 64, false);
    v.setUint32(24, 12, false);

    // past-end entry at 8 + 20 = 28
    v.setInt32(28, corruptCandidate ? 0x1234 : CPU_ARM64, false);
    v.setInt32(32, candidateSubtype, false);
    v.setUint32(36, corruptCandidate ? 0x20000 : 0x4000, false); // corrupt points outside file
    v.setUint32(40, 64, false);
    v.setUint32(44, 14, false);
  }

  return b;
}

test('#6317 discover past-end arm64 compatibility slice in FAT32 container', () => {
  const fat = makeFatWithHiddenArm64();
  const img = openBinary(fat);

  assert.ok(img);
  assert.equal(img.metadata.fat.slices.length, 2, 'both declared x86_64 and compat arm64 are listed');
  assert.equal(img.metadata.fat.selected.arch, 'arm64', 'arm64 is selected by default');
  assert.equal(img.metadata.fat.selected.offset, 0x4000n);
});

test('#6317 accept ARM64_V8 subtype 1 compatibility slice in resident and source-backed loaders', async () => {
  const fat = makeFatWithHiddenArm64({ candidateSubtype: 1 });

  const resident = openBinary(fat);
  assert.equal(resident.metadata.fat.slices.length, 2);
  assert.equal(resident.metadata.fat.selected.arch, 'arm64');
  assert.equal(resident.metadata.fat.selected.subtype, 1);
  assert.equal(resident.metadata.fat.selected.offset, 0x4000n);

  const source = await parseMachOSource(new MemoryByteSource(fat));
  assert.equal(source.metadata.fat.slices.length, 2);
  assert.equal(source.metadata.fat.selected.arch, 'arm64');
  assert.equal(source.metadata.fat.selected.subtype, 1);
  assert.equal(source.metadata.fat.selected.offset, 0x4000n);
});

test('#6317 allow requesting declared slice or past-end arm64 slice by arch', () => {
  const fat = makeFatWithHiddenArm64();

  const imgArm = openBinary(fat, { arch: 'arm64' });
  assert.equal(imgArm.metadata.fat.selected.arch, 'arm64');
  assert.equal(imgArm.metadata.fat.selected.offset, 0x4000n);

  const imgX86 = openBinary(fat, { arch: 'x86_64' });
  assert.equal(imgX86.metadata.fat.selected.arch, 'x86_64');
  assert.equal(imgX86.metadata.fat.selected.offset, 0x1000n);
});

test('#6317 discover past-end arm64 slice in source-backed loader', async () => {
  const fat = makeFatWithHiddenArm64();
  const source = new MemoryByteSource(fat);
  const img = await parseMachOSource(source);

  assert.ok(img);
  assert.equal(img.metadata.fat.slices.length, 2);
  assert.equal(img.metadata.fat.selected.arch, 'arm64');
  assert.equal(img.metadata.fat.selected.offset, 0x4000n);
});

test('#6317 safely ignore corrupted past-end entry and fall back to declared slices', () => {
  const fat = makeFatWithHiddenArm64({ corruptCandidate: true });
  const img = openBinary(fat);

  assert.ok(img);
  assert.equal(img.metadata.fat.slices.length, 1, 'corrupted candidate ignored');
  assert.equal(img.metadata.fat.selected.arch, 'x86_64', 'falls back to declared slice');
});

test('#6317 do not probe past-end entry in FAT64 container', () => {
  const fat = makeFatWithHiddenArm64({ isFat64: true });
  const img = openBinary(fat);

  assert.ok(img);
  assert.equal(img.metadata.fat.slices.length, 1, 'FAT64 does not probe past-end');
  assert.equal(img.metadata.fat.selected.arch, 'x86_64');
});

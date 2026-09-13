import assert from 'node:assert/strict';
import { openBinary, openBinarySource } from '../../../js/binary/index.js';

const CPU_ARM = 12;
const CPU_ARM64_32 = 0x0200000c;
const CPU_SUBTYPE_ARM_V7K = 12;
const CPU_SUBTYPE_ARM64_32_V8 = 1;

function writeThin32(dv, offset, cpu, subtype) {
  dv.setUint32(offset, 0xfeedface, true);
  dv.setInt32(offset + 4, cpu, true);
  dv.setInt32(offset + 8, subtype, true);
  dv.setUint32(offset + 12, 1, true); // MH_OBJECT
  dv.setUint32(offset + 16, 0, true); // ncmds
  dv.setUint32(offset + 20, 0, true); // sizeofcmds
  dv.setUint32(offset + 24, 0, true); // flags
}

function writeThin64(dv, offset, cpu, subtype) {
  dv.setUint32(offset, 0xfeedfacf, true);
  dv.setInt32(offset + 4, cpu, true);
  dv.setInt32(offset + 8, subtype, true);
  dv.setUint32(offset + 12, 1, true); // MH_OBJECT
  dv.setUint32(offset + 16, 0, true); // ncmds
  dv.setUint32(offset + 20, 0, true); // sizeofcmds
  dv.setUint32(offset + 24, 0, true); // flags
  dv.setUint32(offset + 28, 0, true); // reserved
}

function makeFat({ arm64_32First = false } = {}) {
  const bytes = new Uint8Array(0x9000);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xcafebabe, false);
  dv.setUint32(4, 2, false);

  const entries = arm64_32First
    ? [
        { cpu: CPU_ARM64_32, subtype: CPU_SUBTYPE_ARM64_32_V8, offset: 0x4000, size: 32 },
        { cpu: CPU_ARM, subtype: CPU_SUBTYPE_ARM_V7K, offset: 0x8000, size: 28 },
      ]
    : [
        { cpu: CPU_ARM, subtype: CPU_SUBTYPE_ARM_V7K, offset: 0x4000, size: 28 },
        { cpu: CPU_ARM64_32, subtype: CPU_SUBTYPE_ARM64_32_V8, offset: 0x8000, size: 32 },
      ];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const p = 8 + i * 20;
    dv.setUint32(p, entry.cpu, false);
    dv.setUint32(p + 4, entry.subtype, false);
    dv.setUint32(p + 8, entry.offset, false);
    dv.setUint32(p + 12, entry.size, false);
    dv.setUint32(p + 16, 14, false);
    if (entry.cpu === CPU_ARM64_32) writeThin64(dv, entry.offset, entry.cpu, entry.subtype);
    else writeThin32(dv, entry.offset, entry.cpu, entry.subtype);
  }
  return bytes;
}

for (const arm64_32First of [false, true]) {
  const bytes = makeFat({ arm64_32First });
  const resident = openBinary(bytes);
  const source = await openBinarySource(bytes, { ranges: { pageSize: 128, maxCachedBytes: 1 << 20 } });
  assert.equal(resident.metadata.fat.selected.arch, 'arm64_32');
  assert.equal(source.metadata.fat.selected.arch, 'arm64_32');

  assert.equal(openBinary(bytes, { arch: 'arm' }).metadata.fat.selected.arch, 'arm');
  assert.equal(openBinary(bytes, { arch: 'arm64_32' }).metadata.fat.selected.arch, 'arm64_32');
  assert.equal((await openBinarySource(bytes, { arch: 'arm' })).metadata.fat.selected.arch, 'arm');
  assert.equal((await openBinarySource(bytes, { arch: 'arm64_32' })).metadata.fat.selected.arch, 'arm64_32');

  const expectedFirst = arm64_32First ? 'arm64_32' : 'arm';
  const expectedSecond = arm64_32First ? 'arm' : 'arm64_32';
  assert.equal(openBinary(bytes, { sliceIndex: 0 }).metadata.fat.selected.arch, expectedFirst);
  assert.equal(openBinary(bytes, { sliceIndex: 1 }).metadata.fat.selected.arch, expectedSecond);
  assert.equal((await openBinarySource(bytes, { sliceIndex: 0 })).metadata.fat.selected.arch, expectedFirst);
  assert.equal((await openBinarySource(bytes, { sliceIndex: 1 })).metadata.fat.selected.arch, expectedSecond);
}

console.log('issue #8610 Mach-O FAT arm64_32 default-selection regression: PASS');

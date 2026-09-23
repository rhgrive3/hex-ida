import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

const PT_LOAD = 1, PT_DYNAMIC = 2, PF_R = 4;
const EM_AARCH64 = 183;

/**
 * Builds an AArch64 ELF with a large DT_STRTAB (> 1 MiB) and short DT_NEEDED entries.
 * When charging the full 1 MiB scan window per DT_NEEDED entry, 8 entries consume
 * the 8 MiB DYNAMIC_STRING_SCAN_BUDGET. Charging only actual string length + 1 allows
 * 40 short names to be decoded without exhausting the scan budget.
 */
function buildAarch64ElfWithLargeStrtab({ neededCount = 40, strsz = 1024 * 1024 + 4096 } = {}) {
  const ehsize = 64, phentsize = 56;
  const dynoff = 0x200;
  const dynEntries = 2 + neededCount + 1; // STRTAB, STRSZ, NEEDED..., NULL
  const dynSize = dynEntries * 16;
  const strOff = dynoff + dynSize;
  const fileLen = strOff + strsz;
  const b = Buffer.alloc(fileLen);

  // ELF Header (64-bit, little-endian, AArch64)
  b.set([0x7f, 0x45, 0x4c, 0x46], 0);
  b.writeUInt8(2, 4); // 64-bit
  b.writeUInt8(1, 5); // little-endian
  b.writeUInt8(1, 6); // version 1
  b.writeUInt16LE(3, 16); // ET_DYN
  b.writeUInt16LE(EM_AARCH64, 18); // AArch64 (183)
  b.writeUInt32LE(1, 20); // e_version
  b.writeBigUInt64LE(0n, 24); // e_entry
  b.writeBigUInt64LE(BigInt(ehsize), 32); // e_phoff
  b.writeBigUInt64LE(0n, 40); // e_shoff
  b.writeUInt32LE(0, 48); // e_flags
  b.writeUInt16LE(ehsize, 52); // e_ehsize
  b.writeUInt16LE(phentsize, 54); // e_phentsize
  b.writeUInt16LE(2, 56); // e_phnum (PT_LOAD, PT_DYNAMIC)

  const p0 = ehsize;
  b.writeUInt32LE(PT_LOAD, p0 + 0);
  b.writeUInt32LE(PF_R, p0 + 4);
  b.writeBigUInt64LE(0n, p0 + 8);
  b.writeBigUInt64LE(0x400000n, p0 + 16);
  b.writeBigUInt64LE(0x400000n, p0 + 24);
  b.writeBigUInt64LE(BigInt(fileLen), p0 + 32);
  b.writeBigUInt64LE(BigInt(fileLen), p0 + 40);
  b.writeBigUInt64LE(1n, p0 + 48);

  const p1 = ehsize + phentsize;
  b.writeUInt32LE(PT_DYNAMIC, p1 + 0);
  b.writeUInt32LE(PF_R, p1 + 4);
  b.writeBigUInt64LE(BigInt(dynoff), p1 + 8);
  b.writeBigUInt64LE(0x400000n + BigInt(dynoff), p1 + 16);
  b.writeBigUInt64LE(0x400000n + BigInt(dynoff), p1 + 24);
  b.writeBigUInt64LE(BigInt(dynSize), p1 + 32);
  b.writeBigUInt64LE(BigInt(dynSize), p1 + 40);
  b.writeBigUInt64LE(1n, p1 + 48);

  // Lay out 40 short names at the beginning of strtab: "\0lib0.so\0lib1.so\0..."
  // and keep the rest filled up to strsz so DT_STRSZ > 1 MiB.
  b[strOff] = 0x00;
  const offsets = [];
  let curr = 1;
  const expectedLibraries = [];
  for (let i = 0; i < neededCount; i++) {
    const name = `libtest${i}.so`;
    expectedLibraries.push(name);
    offsets.push(curr);
    b.write(name, strOff + curr, 'latin1');
    curr += name.length;
    b[strOff + curr] = 0x00;
    curr += 1;
  }
  // Fill the remainder of strtab up to strsz
  b[strOff + strsz - 1] = 0x00;

  let d = dynoff;
  const writeDyn = (tag, val) => {
    b.writeBigUInt64LE(BigInt(tag), d);
    b.writeBigUInt64LE(BigInt(val), d + 8);
    d += 16;
  };
  writeDyn(5, 0x400000 + strOff); // DT_STRTAB
  writeDyn(10, strsz);            // DT_STRSZ
  for (let i = 0; i < neededCount; i++) {
    writeDyn(1, offsets[i]);      // DT_NEEDED
  }
  writeDyn(0, 0);                 // DT_NULL

  return { buffer: b, expectedLibraries };
}

test('DT_NEEDED scan budget charges actual decoded length, not 1 MiB window', () => {
  const { buffer, expectedLibraries } = buildAarch64ElfWithLargeStrtab({ neededCount: 40 });
  const img = parseELF(buffer);

  assert.equal(img.libraries.length, 40, `expected 40 decoded libraries, got ${img.libraries.length}`);
  assert.deepEqual(img.libraries, expectedLibraries);

  const diagnostics = [
    ...(img.metadata.programDynamicDiagnostics || []),
    ...(img.warnings || []),
  ].join('\n');
  assert.doesNotMatch(diagnostics, /dynamic strings:resource-budget/);
});

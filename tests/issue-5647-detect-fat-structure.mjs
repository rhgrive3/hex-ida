import assert from 'node:assert/strict';
import { detectBinary } from '../js/binary/detect.js';

// Issue #5647: detectBinary() confirmed Mach-O universal (fat) from the
// 4-byte magic alone. CAFEBABE is also the JVM class-file magic, and a fat
// header needs at least magic + nfat_arch plus the declared arch table, so a
// magic-only match laundered truncated input and Java class files into a
// confirmed Mach-O fat binary.

// 4-byte truncated input: fail closed.
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe])),
  { format: 'unknown' },
  '4-byte CAFEBABE is structurally incomplete',
);
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca, 0xfe, 0xba, 0xbf])),
  { format: 'unknown' },
  '4-byte CAFEBABF (FAT64) is structurally incomplete',
);

// JVM class file: magic CAFEBABE + minor:major version words (Java 8: 52).
// major_version >= 45 for every real class file, so bytes 4-7 never declare a
// plausible nfat_arch.
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34])),
  { format: 'unknown' },
  'Java 8 class file is not a Mach-O fat binary',
);
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x2d])),
  { format: 'unknown' },
  'Java 1.1 class file is not a Mach-O fat binary',
);
{
  // A larger class file with extra constant-pool bytes still fails the
  // declared-arch-table bounds.
  const classFile = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34, ...new Array(64).fill(0)]);
  assert.deepEqual(detectBinary(classFile), { format: 'unknown' }, 'oversized nfat_arch declaration fails the table bounds');
}

// JVM class files fail on nfat_arch plausibility regardless of trailing bytes.
{
  // Java class files place minor_version:major_version in bytes 4-7; the
  // major version is >= 45 for every real class file, far outside a plausible
  // architecture count.
  assert.deepEqual(
    detectBinary(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34, ...new Array(1048).fill(0)])),
    { format: 'unknown' },
    'a >1048-byte class file still fails the nfat_arch plausibility window',
  );
}

// nfat_arch = 0 is not a usable universal binary: fail closed.
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x00, ...new Array(20).fill(0)])),
  { format: 'unknown' },
  'nfat_arch = 0 declares no architectures',
);

// Implausible oversized arch counts (crafted or misparsed) fail closed.
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x11, ...new Array(64).fill(0)])),
  { format: 'unknown' },
  'nfat_arch beyond the plausible window is rejected',
);

// The little-endian CIGAM encoding uses little-endian nfat_arch fields.
{
  const fat32Little = Uint8Array.from([0xbe, 0xba, 0xfe, 0xca, 0x01, 0x00, 0x00, 0x00, ...new Array(20).fill(0)]);
  const result = detectBinary(fat32Little);
  assert.equal(result.format, 'macho');
  assert.equal(result.fat, true, 'little-endian FAT32 header confirms macho/fat');
}

// Valid minimal FAT32 image (1 arch entry = 20 bytes) still detects.
{
  const fat32 = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x01, ...new Array(20).fill(0)]);
  const result = detectBinary(fat32);
  assert.equal(result.format, 'macho');
  assert.equal(result.fat, true, 'valid minimal FAT32 header confirms macho/fat');
}

// Valid minimal FAT64 image (CAFEBABF magic, 32-byte fat_arch_64 entries).
{
  const fat64 = Uint8Array.from([0xca, 0xfe, 0xba, 0xbf, 0x00, 0x00, 0x00, 0x01, ...new Array(32).fill(0)]);
  const result = detectBinary(fat64);
  assert.equal(result.format, 'macho');
  assert.equal(result.fat, true, 'valid minimal FAT64 header confirms macho/fat');
}

// A short probe prefix of a real fat image still detects: source-backed
// openBinarySource()/worker routes hand detectBinary() only 16 bytes, so they
// declare the input truncated and the arch-table bounds belong to the Mach-O
// parser, which owns the full input.
{
  const prefix = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x01, ...new Array(8).fill(0)]);
  const result = detectBinary(prefix, { truncated: true });
  assert.equal(result.format, 'macho');
  assert.equal(result.fat, true, '16-byte prefix probe of a real fat image remains confirmed');
}

// #5647 review: a COMPLETE 8-byte input declaring nfat_arch=1 but carrying no
// fat_arch entry must not confirm a FAT32 image — the declared arch table
// must fit within the input when the caller sees the whole file.
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x01])),
  { format: 'unknown' },
  'complete input without the declared 20-byte fat_arch entry is fail-closed',
);
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca, 0xfe, 0xba, 0xbf, 0x00, 0x00, 0x00, 0x01])),
  { format: 'unknown' },
  'complete input without the declared 32-byte fat_arch_64 entry is fail-closed',
);
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x01, ...new Array(19).fill(0)])),
  { format: 'unknown' },
  'a 19-byte arch entry is one byte short of the declared FAT32 table',
);

// FAT64 CIGAM (BF BA FE CA on disk) uses little-endian nfat_arch but still
// declares 32-byte fat_arch_64 entries — the 64-bit table geometry must be
// decided from the magic itself, independent of field byte order.
{
  const cigam64Short = Uint8Array.from([0xbf, 0xba, 0xfe, 0xca, 0x01, 0x00, 0x00, 0x00, ...new Array(20).fill(0)]);
  assert.deepEqual(detectBinary(cigam64Short), { format: 'unknown' }, 'FAT_CIGAM_64 with a 20-byte payload is fail-closed');
  const cigam64Complete = Uint8Array.from([0xbf, 0xba, 0xfe, 0xca, 0x01, 0x00, 0x00, 0x00, ...new Array(32).fill(0)]);
  const result = detectBinary(cigam64Complete);
  assert.equal(result.format, 'macho');
  assert.equal(result.fat, true, 'FAT_CIGAM_64 with a complete 32-byte fat_arch_64 entry confirms');
  const magic64Short = Uint8Array.from([0xca, 0xfe, 0xba, 0xbf, 0x00, 0x00, 0x00, 0x01, ...new Array(31).fill(0)]);
  assert.deepEqual(detectBinary(magic64Short), { format: 'unknown' }, 'FAT_MAGIC_64 with a 31-byte entry is fail-closed');
  const magic64Complete = Uint8Array.from([0xca, 0xfe, 0xba, 0xbf, 0x00, 0x00, 0x00, 0x01, ...new Array(32).fill(0)]);
  assert.equal(detectBinary(magic64Complete).fat, true, 'FAT_MAGIC_64 with a complete entry confirms');
}

// Thin Mach-O detection and unrelated magics are unchanged.
assert.deepEqual(detectBinary(Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe])), { format: 'macho', fat: false });
assert.deepEqual(detectBinary(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46])), { format: 'elf' });
assert.deepEqual(detectBinary(Uint8Array.from([1, 2, 3, 4])), { format: 'unknown' });

console.log('issue #5647 detectBinary fat-header structure regression: PASS');

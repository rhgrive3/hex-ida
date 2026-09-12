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

// A short probe prefix of a real fat image still routes, but remains
// explicitly provisional rather than minting the complete-table shape.
{
  const prefix = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x01, ...new Array(8).fill(0)]);
  const result = detectBinary(prefix, { probeLength: 16, totalSize: 0x4000 });
  assert.equal(result.format, 'macho');
  assert.equal(result.fat, true, '16-byte prefix probe keeps candidate routing');
  assert.equal(result.truncated, true, 'prefix-probe routing is provisional');
}

assert.deepEqual(
  detectBinary(Uint8Array.from([0xca,0xfe,0xba,0xbe, 0,0,0,1]), { truncated:true }),
  { format:'unknown' },
  'a forged truncated flag cannot bypass structural bounds',
);
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca,0xfe,0xba,0xbe, 0,0,0,1, ...new Array(19).fill(0)]), { probeLength:27, totalSize:27 }),
  { format:'unknown' },
  'complete short tables stay fail-closed',
);
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca,0xfe,0xba,0xbe, 0,0,0,1]), { probeLength:8n, totalSize:28n }),
  { format:'macho', fat:true, truncated:true },
  'consistent prefix metadata only mints the provisional shape',
);
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca,0xfe,0xba,0xbe, 0,0,0,1]), { probeLength:16n, totalSize:28n }),
  { format:'unknown' },
  'probe/input length mismatch is ignored',
);
assert.equal(
  detectBinary(Uint8Array.from([0xca,0xfe,0xba,0xbe, 0,0,0,1, ...new Array(8).fill(0)]), { probeLength:16n, totalSize:9007199254740993n }).fat,
  true,
  'BigInt source sizes above 2^53 preserve candidate routing',
);
for (const malformed of [
  { probeLength:'16', totalSize:28 },
  { probeLength:16.5, totalSize:28 },
  { probeLength:16, totalSize:-28 },
  { probeLength:-16, totalSize:28 },
  { probeLength:null, totalSize:28 },
]) {
  assert.deepEqual(
    detectBinary(Uint8Array.from([0xca,0xfe,0xba,0xbe, 0,0,0,1, ...new Array(8).fill(0)]), malformed),
    { format:'unknown' },
    `malformed probe metadata ${JSON.stringify(malformed)} fails closed`,
  );
}

assert.deepEqual(
  detectBinary(Uint8Array.from([0xca,0xfe,0xba,0xbe, 0,0,0,1])),
  { format:'unknown' },
  'complete FAT32 header without its declared arch entry is fail-closed',
);
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca,0xfe,0xba,0xbf, 0,0,0,1])),
  { format:'unknown' },
  'complete FAT64 header without its declared arch entry is fail-closed',
);
assert.deepEqual(
  detectBinary(Uint8Array.from([0xca,0xfe,0xba,0xbe, 0,0,0,1, ...new Array(19).fill(0)])),
  { format:'unknown' },
  'a FAT32 arch entry one byte short is fail-closed',
);
{
  const cigam64Short = Uint8Array.from([0xbf,0xba,0xfe,0xca, 1,0,0,0, ...new Array(20).fill(0)]);
  assert.deepEqual(detectBinary(cigam64Short), { format:'unknown' });
  const cigam64Complete = Uint8Array.from([0xbf,0xba,0xfe,0xca, 1,0,0,0, ...new Array(32).fill(0)]);
  assert.deepEqual(detectBinary(cigam64Complete), { format:'macho', fat:true });
}

// Thin Mach-O detection and unrelated magics are unchanged.
assert.deepEqual(detectBinary(Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe])), { format: 'macho', fat: false });
assert.deepEqual(detectBinary(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46])), { format: 'elf' });
assert.deepEqual(detectBinary(Uint8Array.from([1, 2, 3, 4])), { format: 'unknown' });

console.log('issue #5647 detectBinary fat-header structure regression: PASS');

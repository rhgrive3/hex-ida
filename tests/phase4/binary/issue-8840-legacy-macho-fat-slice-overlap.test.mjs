import assert from 'node:assert/strict';
import fs from 'node:fs';
import url from 'node:url';

// Issue #8840: the classic/legacy Mach-O fat parser `MachO.parseFat()` validated
// only each fat entry against the outer file size, so a crafted universal binary
// could publish ONE physical byte range as regions of TWO different
// architectures / virtual-address spaces, and could also carry duplicate
// architecture identities. The canonical loader (#6314/#6316,
// js/binary/macho-fat.js validateFatContainer) rejects slice overlap and
// duplicate architecture before opening any slice; the classic path now enforces
// the same container-ownership authority at the same point.

const machoSrc = fs.readFileSync(
  url.fileURLToPath(new URL('../../../js/macho.js', import.meta.url)),
  'utf8',
);
new Function('root', machoSrc)(globalThis);
const { parseFat } = globalThis.MachO;

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;

// A 32-bit fat header (20-byte entries) over `entries`.
function fat32(entries) {
  const buf = new ArrayBuffer(8 + entries.length * 20);
  const dv = new DataView(buf);
  dv.setUint32(0, FAT_MAGIC, false);
  dv.setUint32(4, entries.length, false);
  entries.forEach((e, i) => {
    const o = 8 + i * 20;
    dv.setInt32(o, e.cpu, false);
    dv.setInt32(o + 4, e.sub, false);
    dv.setUint32(o + 8, e.offset, false);
    dv.setUint32(o + 12, e.size, false);
    dv.setUint32(o + 16, e.align ?? 14, false);
  });
  return buf;
}

// A 64-bit fat header (32-byte entries) over `entries`.
function fat64(entries) {
  const buf = new ArrayBuffer(8 + entries.length * 32);
  const dv = new DataView(buf);
  dv.setUint32(0, FAT_MAGIC_64, false);
  dv.setUint32(4, entries.length, false);
  entries.forEach((e, i) => {
    const o = 8 + i * 32;
    dv.setInt32(o, e.cpu, false);
    dv.setInt32(o + 4, e.sub, false);
    dv.setBigUint64(o + 8, BigInt(e.offset), false);
    dv.setBigUint64(o + 16, BigInt(e.size), false);
    dv.setUint32(o + 24, e.align ?? 14, false);
  });
  return buf;
}

const FILE = 0x8000n;

// 1. The reproduced ARM64 / x86_64 overlapping slices are rejected.
{
  const overlapping = [
    { cpu: ARM64, sub: 0, offset: 0x4000, size: 0x2000 },
    { cpu: X86_64, sub: 3, offset: 0x5000, size: 0x2000 }, // overlaps [0x5000,0x6000)
  ];
  assert.equal(parseFat(fat32(overlapping), FILE), null, 'overlapping 32-bit fat slices rejected');
  assert.equal(parseFat(fat64(overlapping), FILE), null, 'overlapping 64-bit fat slices rejected');
  // Reversing the table order cannot change validity.
  assert.equal(parseFat(fat32(overlapping.slice().reverse()), FILE), null, 'overlap independent of table order');
}

// 2. A contained slice (B wholly inside A) is also rejected.
{
  const nested = [
    { cpu: ARM64, sub: 0, offset: 0x1000, size: 0x6000 },
    { cpu: X86_64, sub: 3, offset: 0x3000, size: 0x1000 },
  ];
  assert.equal(parseFat(fat32(nested), FILE), null, 'nested slice rejected');
}

// 3. Duplicate architecture identity is rejected.
{
  const dup = [
    { cpu: ARM64, sub: 0, offset: 0x1000, size: 0x1000 },
    { cpu: ARM64, sub: 0, offset: 0x4000, size: 0x1000 },
  ];
  assert.equal(parseFat(fat32(dup), FILE), null, 'duplicate ARM64 rejected');
  const dupX = [
    { cpu: X86_64, sub: 3, offset: 0x1000, size: 0x1000 },
    { cpu: X86_64, sub: 3, offset: 0x4000, size: 0x1000 },
  ];
  assert.equal(parseFat(fat32(dupX), FILE), null, 'duplicate x86_64 rejected');
}

// 4. arm64 vs arm64e remains distinct (canonical subtype normalization permits it).
{
  const arm64eVsArm64 = [
    { cpu: ARM64, sub: 0, offset: 0x1000, size: 0x1000 }, // arm64
    { cpu: ARM64, sub: 2, offset: 0x4000, size: 0x1000 }, // arm64e
  ];
  const r = parseFat(fat32(arm64eVsArm64), FILE);
  assert.ok(Array.isArray(r) && r.length === 2, 'arm64 and arm64e are distinct architectures');
}

// 5. Ordinary non-overlapping, distinct-architecture universals remain accepted.
{
  const ok = [
    { cpu: ARM64, sub: 0, offset: 0x1000, size: 0x2000 },
    { cpu: X86_64, sub: 3, offset: 0x3000, size: 0x2000 },
    { cpu: X86_64, sub: 8, offset: 0x5000, size: 0x1000 }, // x86_64h
  ];
  const r = parseFat(fat32(ok), FILE);
  assert.ok(Array.isArray(r) && r.length === 3, 'valid multi-arch fat accepted');
  assert.deepEqual(r.map((e) => [e.offset, e.size]),
    [[0x1000n, 0x2000n], [0x3000n, 0x2000n], [0x5000n, 0x1000n]], 'published slice descriptors preserved');
  const r64 = parseFat(fat64(ok), FILE);
  assert.ok(Array.isArray(r64) && r64.length === 3, 'valid 64-bit fat accepted');
}

// 6. Out-of-bounds / empty-size entries are rejected at the same authority.
{
  assert.equal(parseFat(fat32([{ cpu: ARM64, sub: 0, offset: 0x7000, size: 0x2000 }]), FILE), null,
    'slice past file end rejected');
  assert.equal(parseFat(fat32([{ cpu: ARM64, sub: 0, offset: 0x1000, size: 0 }]), FILE), null,
    'zero-size slice rejected');
}

// 7. Pre-existing sanity behaviour is preserved (Java class file / absurd count).
{
  const absurd = fat32(new Array(33).fill({ cpu: ARM64, sub: 0, offset: 0x1000, size: 0x10 }));
  assert.equal(parseFat(absurd, FILE), null, 'nfat > 32 still rejected');
}

console.log('issue #8840 legacy Mach-O fat slice-overlap / duplicate-arch container ownership: PASS');

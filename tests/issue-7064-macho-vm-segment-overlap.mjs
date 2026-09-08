// Issue #7064 regression: file-backed Mach-O segments whose VM ownership
// extents intersect must agree on the file mapping, or the same VM address
// resolves to different bytes depending on load-command order. Ambiguous
// layouts must fail closed at parse time instead of letting insertion order
// pick the canonical mapping.
import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho.js';
import { auditBinary } from '../js/binary/audit.js';
import { openBinarySource } from '../js/binary/source-loaders.js';
import { MemoryByteSource } from '../js/binary/source.js';

function u32(b, o, v) { new DataView(b.buffer).setUint32(o, v, true); }
function u64(b, o, v) { new DataView(b.buffer).setBigUint64(o, BigInt(v), true); }

const PAD = 0x500;
const HEADER64 = 32, SEGCMD64 = 72;

// Two LC_SEGMENT_64 commands: opts controls where each segment maps bytes from.
function thinMachO64(segments) {
  const b = new Uint8Array(PAD);
  const ncmds = segments.length;
  u32(b, 0, 0xfeedfacf); u32(b, 4, 0x0100000c); u32(b, 8, 0); u32(b, 12, 2);
  u32(b, 16, ncmds); u32(b, 20, ncmds * SEGCMD64); u32(b, 24, 0); u32(b, 28, 0);
  let p = HEADER64;
  for (const s of segments) {
    u32(b, p, 0x19); u32(b, p + 4, SEGCMD64);
    b.set(TextEncoder.prototype.encodeInto ? (() => { const t = new TextEncoder(); const out = new Uint8Array(16); t.encodeInto(s.name, out); return out; })() : new Uint8Array(16), p + 8);
    u64(b, p + 24, s.vmaddr); u64(b, p + 32, s.vmsize);
    u64(b, p + 40, s.fileoff); u64(b, p + 48, s.filesize);
    u32(b, p + 56, 5); u32(b, p + 60, 5); u32(b, p + 64, 0); u32(b, p + 68, 0); // maxprot/initprot RWX, nsects 0, flags
    p += SEGCMD64;
  }
  return b;
}

const SEG_A = { name: '__TEXTA', vmaddr: 0x1000, vmsize: 0x100, fileoff: 0x200, filesize: 0x100 };
const SEG_B = { name: '__TEXTB', vmaddr: 0x1000, vmsize: 0x100, fileoff: 0x300, filesize: 0x100 };

const AMBIGUOUS_TAIL_A = { name: '__TAILA', vmaddr: 0x1000, vmsize: 0x180, fileoff: 0x200, filesize: 0x80 };
const AMBIGUOUS_TAIL_B = { name: '__TAILB', vmaddr: 0x1080, vmsize: 0x200, fileoff: 0x300, filesize: 0x80 };

function fatMachO32(thin) {
  const offset = 0x1000;
  const bytes = new Uint8Array(offset + thin.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xcafebabe, false);
  view.setUint32(4, 1, false);
  view.setInt32(8, 0x0100000c, false);
  view.setInt32(12, 0, false);
  view.setUint32(16, offset, false);
  view.setUint32(20, thin.length, false);
  view.setUint32(24, 12, false);
  bytes.set(thin, offset);
  return bytes;
}

// 1. The issue repro: identical VM ranges with different file mappings must
//    fail closed regardless of load-command order.
assert.throws(() => parseMachO(thinMachO64([SEG_A, SEG_B])), /segment __TEXTB VM range overlaps segment __TEXTA with a different file mapping/);
assert.throws(() => parseMachO(thinMachO64([SEG_B, SEG_A])), /segment __TEXTA VM range overlaps segment __TEXTB with a different file mapping/);

// 2. A partial overlap with a different file mapping is equally ambiguous.
assert.throws(
  () => parseMachO(thinMachO64([
    { name: '__LO', vmaddr: 0x1000, vmsize: 0x200, fileoff: 0x200, filesize: 0x200 },
    { name: '__HI', vmaddr: 0x1080, vmsize: 0x80, fileoff: 0x300, filesize: 0x80 },
  ])),
  /different file mapping/,
);

// 2b. Full VM extents are ownership claims: a zero-fill tail overlapping
// another segment's file-backed bytes is ambiguous even when file-backed
// extents merely touch.
assert.throws(
  () => parseMachO(thinMachO64([AMBIGUOUS_TAIL_A, AMBIGUOUS_TAIL_B])),
  /ambiguous file\/zero ownership/,
);
assert.throws(
  () => parseMachO(thinMachO64([AMBIGUOUS_TAIL_B, AMBIGUOUS_TAIL_A])),
  /ambiguous file\/zero ownership/,
);

// 3. Non-overlapping file-backed segments keep parsing.
{
  const image = parseMachO(thinMachO64([
    { name: '__LO', vmaddr: 0x1000, vmsize: 0x100, fileoff: 0x200, filesize: 0x100 },
    { name: '__HI', vmaddr: 0x2000, vmsize: 0x100, fileoff: 0x300, filesize: 0x100 },
  ]));
  assert.equal(image.segments.length, 2);
  assert.equal(image.addressToOffset(0x1000n), 0x200n);
  assert.equal(image.addressToOffset(0x2000n), 0x300n);
}

// 4. A zero-fill segment (no file bytes) may share VM space with a file-backed
//    segment: no byte-ownership ambiguity exists.
{
  const image = parseMachO(thinMachO64([
    { name: '__TEXT', vmaddr: 0x1000, vmsize: 0x100, fileoff: 0x200, filesize: 0x100 },
    { name: '__PAGEZERO_BSS', vmaddr: 0x1000, vmsize: 0x200, fileoff: 0, filesize: 0 },
  ]));
  assert.equal(image.segments.length, 2);
  assert.equal(image.addressToOffset(0x1000n), 0x200n);
}

// 5. Identical file mappings for a shared VM range stay byte-unambiguous.
{
  const image = parseMachO(thinMachO64([
    { name: '__A', vmaddr: 0x1000, vmsize: 0x100, fileoff: 0x200, filesize: 0x100 },
    { name: '__B', vmaddr: 0x1000, vmsize: 0x100, fileoff: 0x200, filesize: 0x100 },
  ]));
  assert.equal(image.addressToOffset(0x1000n), 0x200n);
}

// 6. The same ownership contract holds for 32-bit Mach-O.
function thinMachO32(segments) {
  const b = new Uint8Array(PAD);
  const ncmds = segments.length, SEGCMD = 56, HEADER = 28;
  u32(b, 0, 0xfeedface); u32(b, 4, 0x00000007); u32(b, 8, 0); u32(b, 12, 2);
  u32(b, 16, ncmds); u32(b, 20, ncmds * SEGCMD); u32(b, 24, 0);
  let p = HEADER;
  for (const s of segments) {
    u32(b, p, 0x1); u32(b, p + 4, SEGCMD);
    u32(b, p + 24, s.vmaddr); u32(b, p + 28, s.vmsize);
    u32(b, p + 32, s.fileoff); u32(b, p + 36, s.filesize);
    u32(b, p + 40, 5); u32(b, p + 44, 5); u32(b, p + 48, 0); u32(b, p + 52, 0); // maxprot/initprot RWX, nsects 0, flags
    p += SEGCMD;
  }
  return b;
}
assert.throws(() => parseMachO(thinMachO32([
  { name: '__TEXTA', vmaddr: 0x1000, vmsize: 0x100, fileoff: 0x200, filesize: 0x100 },
  { name: '__TEXTB', vmaddr: 0x1000, vmsize: 0x100, fileoff: 0x300, filesize: 0x100 },
])), /different file mapping/);

// 7. The source-backed production loader rejects the same ambiguous thin
// layout, and an accepted image has no mapping round-trip audit errors.
{
  const valid = await openBinarySource(
    new MemoryByteSource(thinMachO64([
      { name: '__LO', vmaddr: 0x1000, vmsize: 0x100, fileoff: 0x200, filesize: 0x100 },
      { name: '__HI', vmaddr: 0x2000, vmsize: 0x100, fileoff: 0x300, filesize: 0x100 },
    ])),
    { ranges: { pageSize: 0x100, maxPageSize: 0x1000, maxCachedBytes: 0x2000, maxReads: 64 } },
  );
  const audit = auditBinary(valid);
  assert.equal(audit.issues.some((issue) => issue.code.includes('roundtrip')), false);
  await assert.rejects(
    () => openBinarySource(
      new MemoryByteSource(thinMachO64([SEG_A, SEG_B])),
      { ranges: { pageSize: 0x100, maxPageSize: 0x1000, maxCachedBytes: 0x2000, maxReads: 64 } },
    ),
    /MACHO_SEGMENT_VM_OVERLAP|different file mapping/,
  );
}

// 8. FAT32 selected slices must apply the same thin-segment ownership gate.
await assert.rejects(
  () => openBinarySource(
    new MemoryByteSource(fatMachO32(thinMachO64([SEG_A, SEG_B]))),
    { ranges: { pageSize: 0x100, maxPageSize: 0x1000, maxCachedBytes: 0x4000, maxReads: 128 } },
  ),
  /MACHO_SEGMENT_VM_OVERLAP|different file mapping/,
);

console.log('issue #7064 mach-o vm segment ownership ambiguity: PASS');

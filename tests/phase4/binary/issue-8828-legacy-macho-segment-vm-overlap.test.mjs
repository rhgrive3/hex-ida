import assert from 'node:assert/strict';
import fs from 'node:fs';
import url from 'node:url';

// Issue #8828: the classic/legacy js/macho.js parser published two individually
// valid LC_SEGMENT_64 commands that claimed the SAME VM range while mapping it to
// different file offsets, and `regionsFrom()` emitted both in load-command order.
// Classic consumers (`mappedFileOffset()` / `vmToFile()`) resolve the shared VM
// address to whichever segment came first, so attacker-controlled command order
// selected which physical bytes a virtual address "really" contained. The canonical
// loader fails closed on exactly this layout (#7064); the classic path now applies
// the same per-sub-interval ownership rule and demotes every conflicting segment so
// NO authoritative region is published for the ambiguous bytes.

const machoSrc = fs.readFileSync(
  url.fileURLToPath(new URL('../../../js/macho.js', import.meta.url)),
  'utf8',
);
new Function('root', machoSrc)(globalThis);
const { parseSlice, regionsFrom } = globalThis.MachO;

const SEGCMD = 72 + 80; // one file-backed section per segment

function thinMachO64(segs, fileLen = 0x800) {
  const bytes = new Uint8Array(fileLen);
  const dv = new DataView(bytes.buffer);
  const u32 = (o, v) => dv.setUint32(o, v, true);
  const i32 = (o, v) => dv.setInt32(o, v, true);
  const u64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
  const put = (o, s) => { const t = Buffer.from(s); bytes.set(t, o); };
  u32(0, 0xfeedfacf); i32(4, 0x0100000c); i32(8, 0); u32(12, 2);
  u32(16, segs.length); u32(20, segs.length * SEGCMD); u32(24, 0); u32(28, 0);
  let p = 32;
  for (const s of segs) {
    u32(p, 0x19); u32(p + 4, SEGCMD); put(p + 8, s.name);
    u64(p + 24, s.vmaddr); u64(p + 32, s.vmsize);
    u64(p + 40, s.fileoff); u64(p + 48, s.filesize);
    i32(p + 56, s.prot ?? 5); i32(p + 60, s.prot ?? 5);
    u32(p + 64, 1); u32(p + 68, 0);
    put(p + 72, s.secname); put(p + 72 + 16, s.name);
    u64(p + 72 + 32, s.addr); u64(p + 72 + 40, s.size);
    u32(p + 72 + 48, s.offset); u32(p + 72 + 52, 0);
    u32(p + 72 + 64, s.secflags ?? 0);
    p += SEGCMD;
  }
  return bytes;
}

const A = { name: '__TEXTA', secname: '__text', vmaddr: 0x1000, vmsize: 0x200, fileoff: 0x100, filesize: 0x200, addr: 0x1000, size: 0x200, offset: 0x100 };
const B = { name: '__TEXTB', secname: '__text', vmaddr: 0x1000, vmsize: 0x200, fileoff: 0x300, filesize: 0x200, addr: 0x1000, size: 0x200, offset: 0x300 };

// 1. Identical VM range mapped to different bytes: fail closed, publish nothing.
for (const order of [[A, B], [B, A]]) {
  const bytes = thinMachO64(order);
  const info = parseSlice(bytes.buffer, 0, bytes.length);
  assert.equal(info.segmentOwnershipConflict, true, 'conflict flagged (order ' + order.map(s => s.name).join(',') + ')');
  assert.equal(info.segments.every((s) => !s.validMapping && s.mappingConflict), true,
    'both conflicting segments demoted to non-authoritative');
  assert.ok(info.diagnostics.some((d) => /conflicting file mapping/.test(d)), 'diagnostic recorded');
  const regions = regionsFrom(info, 0n, BigInt(bytes.length), BigInt(bytes.length));
  assert.deepEqual(regions.map((r) => r.name), [], 'no authoritative region published for ambiguous bytes');
}

// 2. Partial VM overlap with different file mapping is equally ambiguous.
{
  const hi = { name: '__HI', secname: '__s', vmaddr: 0x1080, vmsize: 0x100, fileoff: 0x380, filesize: 0x100, addr: 0x1080, size: 0x100, offset: 0x380 };
  const lo = { name: '__LO', secname: '__s', vmaddr: 0x1000, vmsize: 0x200, fileoff: 0x100, filesize: 0x200, addr: 0x1000, size: 0x200, offset: 0x100 };
  const bytes = thinMachO64([lo, hi]);
  const info = parseSlice(bytes.buffer, 0, bytes.length);
  assert.equal(info.segmentOwnershipConflict, true, 'partial overlap flagged');
  assert.equal(regionsFrom(info, 0n, BigInt(bytes.length), BigInt(bytes.length)).length, 0);
}

// 3. Zero-fill tail hiding another segment's file-backed bytes is ambiguous.
{
  // __TA maps [0x1000,0x1100) file bytes, tail to 0x1180 zero; __TB file-backed
  // starts at 0x1080 (inside TA's file-backed range) with different bytes.
  const ta = { name: '__TA', secname: '__s', vmaddr: 0x1000, vmsize: 0x180, fileoff: 0x200, filesize: 0x80, addr: 0x1000, size: 0x180, offset: 0x200, secflags: 0x12 }; // S_ZEROFILL-ish handled at seg level
  const tb = { name: '__TB', secname: '__s', vmaddr: 0x1080, vmsize: 0x180, fileoff: 0x300, filesize: 0x80, addr: 0x1080, size: 0x80, offset: 0x300 };
  const bytes = thinMachO64([ta, tb]);
  const info = parseSlice(bytes.buffer, 0, bytes.length);
  // Segment-level ownership: TA owns [0x1000,0x1080) bytes, TB owns [0x1080,0x1100)
  // bytes; their full VM extents overlap [0x1080,0x1100) where TA is zero-fill and
  // TB is file-backed -> ambiguous file/zero ownership.
  assert.equal(info.segmentOwnershipConflict, true, 'ambiguous file/zero ownership flagged');
  assert.equal(info.segments.every((s) => !s.validMapping), true);
}

// 4. Non-overlapping file-backed segments keep parsing and publishing.
{
  const hi = { name: '__HI', secname: '__s', vmaddr: 0x2000, vmsize: 0x100, fileoff: 0x300, filesize: 0x100, addr: 0x2000, size: 0x100, offset: 0x300 };
  const lo = { ...A, vmsize: 0x100, filesize: 0x100, size: 0x100 };
  const bytes = thinMachO64([lo, hi]);
  const info = parseSlice(bytes.buffer, 0, bytes.length);
  assert.notEqual(info.segmentOwnershipConflict, true, 'clean layout has no conflict');
  const regions = regionsFrom(info, 0n, BigInt(bytes.length), BigInt(bytes.length));
  assert.equal(regions.length, 2, 'both regions published');
  assert.deepEqual(regions.map((r) => r.vmAddr.toString(16)).sort(), ['2000', '1000'].sort(), 'distinct owners preserved');
}

// 5. A zero-fill segment may share VM space with a file-backed segment: the
//    file-backed owner is still authoritative (transparent zero-fill, #7064 rule).
{
  const pagezero = { name: '__PAGEZ', secname: '__s', vmaddr: 0x0, vmsize: 0x1000, fileoff: 0x0, filesize: 0x0, addr: 0x0, size: 0x1000, offset: 0x0 };
  const text = { name: '__TEXT', secname: '__text', vmaddr: 0x1000, vmsize: 0x200, fileoff: 0x100, filesize: 0x200, addr: 0x1000, size: 0x200, offset: 0x100 };
  const bytes = thinMachO64([pagezero, text]);
  const info = parseSlice(bytes.buffer, 0, bytes.length);
  assert.notEqual(info.segmentOwnershipConflict, true, 'zero-fill overlap is not byte ambiguity');
  const regions = regionsFrom(info, 0n, BigInt(bytes.length), BigInt(bytes.length));
  assert.ok(regions.some((r) => r.name === '__TEXT,__text'), 'file-backed owner still published');
}

// 6. A pure zero-fill segment overlapping file-backed bytes is ambiguous.
{
  const zero = { name: '__ZERO', secname: '__bss', vmaddr: 0x1080, vmsize: 0x80, fileoff: 0x0, filesize: 0x0, addr: 0x1080, size: 0x80, offset: 0x0, secflags: 0x1 };
  const text = { name: '__TEXT', secname: '__text', vmaddr: 0x1000, vmsize: 0x200, fileoff: 0x100, filesize: 0x200, addr: 0x1000, size: 0x200, offset: 0x100 };
  const bytes = thinMachO64([text, zero]);
  const info = parseSlice(bytes.buffer, 0, bytes.length);
  assert.equal(info.segmentOwnershipConflict, true, 'file-backed vs pure zero-fill overlap flagged');
  assert.equal(info.segments.every((s) => !s.validMapping && s.mappingConflict), true, 'both owners demoted');
  assert.equal(regionsFrom(info, 0n, BigInt(bytes.length), BigInt(bytes.length)).length, 0, 'ambiguous ownership publishes no region');
}

// 7. Identical file mappings for a shared VM range stay byte-unambiguous.

{
  const a1 = { ...A, name: '__A', secname: '__s' };
  const a2 = { ...A, name: '__B', secname: '__s' }; // same vmaddr/vmsize/fileoff/filesize
  const bytes = thinMachO64([a1, a2]);
  const info = parseSlice(bytes.buffer, 0, bytes.length);
  assert.notEqual(info.segmentOwnershipConflict, true, 'identical mapping is not ambiguous');
}

console.log('issue #8828 legacy Mach-O segment VM-overlap byte-ownership fail-closed: PASS');

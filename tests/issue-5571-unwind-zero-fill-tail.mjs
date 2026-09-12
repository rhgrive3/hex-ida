// Regression for #5571: parseCompactUnwind() validated unwind ranges against
// the executable segment's VM extent but not its file-backed extent. A
// __TEXT segment with vmsize > filesize zero-fills the tail; an unwind entry
// describing a range in that tail became a 0.95-confidence function seed for
// bytes that do not exist in the file. Ranges must now stay inside the
// segment's file-backed extent (fail-closed) while fully file-backed ranges
// keep working.
import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho-core.js';

function buildArm64({ unwindFunctionOffset, sentinel = 0x1000, vmsize = 0x2000, filesize = 0x1000 }) {
  const b = new Uint8Array(0x1000);
  const dv = new DataView(b.buffer);
  const W32 = (o, v) => dv.setUint32(o, v, true);
  const W64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
  const CSTR = (o, s, n = 16) => { b.set(Buffer.alloc(n), o); b.set(Buffer.from(s + '\0'), o); };
  W32(0, 0xfeedfacf); W32(4, 0x0100000c); W32(8, 0); W32(12, 2);
  W32(16, 2); W32(20, 232); W32(24, 0); W32(28, 0);
  // LC_SEGMENT_64 __TEXT (vmsize 0x2000, file-backed only 0x1000)
  const P = 32;
  W32(P + 0, 0x19); W32(P + 4, 152); CSTR(P + 8, '__TEXT');
  W64(P + 24, 0x100000000); W64(P + 32, vmsize); W64(P + 40, 0); W64(P + 48, filesize);
  W32(P + 56, 7); W32(P + 60, 5); W32(P + 64, 1); W32(P + 68, 0);
  CSTR(P + 72, '__unwind_info'); CSTR(P + 88, '__TEXT');
  W64(P + 104, 0x100000e00); W64(P + 112, 0x100); W32(P + 120, 0xe00);
  // LC_SEGMENT_64 __LINKEDIT
  const Q = 184;
  W32(Q + 0, 0x19); W32(Q + 4, 72); CSTR(Q + 8, '__LINKEDIT');
  W64(Q + 24, 0x100002000); W64(Q + 32, 0x1000); W64(Q + 40, 0x1000); W64(Q + 48, 0);
  W32(Q + 56, 1); W32(Q + 60, 1); W32(Q + 64, 0); W32(Q + 68, 0);
  // __unwind_info @0xe00: v1, no common/personality arrays, 2 first-level entries
  W32(0xe00, 1); W32(0xe04, 0); W32(0xe08, 0); W32(0xe0c, 0);
  W32(0xe10, 0); W32(0xe14, 0x1c); W32(0xe18, 2);
  W32(0xe1c, unwindFunctionOffset); W32(0xe20, 0x38); W32(0xe24, 0);
  W32(0xe28, sentinel); W32(0xe2c, 0); W32(0xe30, 0);
  // REGULAR second-level page @0xe38 with one primary entry
  W32(0xe38, 2); dv.setUint16(0xe3c, 8, true); dv.setUint16(0xe3e, 1, true);
  W32(0xe40, unwindFunctionOffset); W32(0xe44, 0x03000000);
  return b;
}

// function range inside the zero-fill tail must not mint a function seed
{
  const image = parseMachO(buildArm64({ unwindFunctionOffset: 0x1000, sentinel: 0x1010 }), {});
  const status = image.metadata.compactUnwind;
  assert.equal(status.complete, false, 'zero-fill-tail entry must fail closed');
  assert.equal(status.partialReason, 'entry-zero-fill-invalid');
  assert.equal(status.invalidEntries, 1);
  assert.equal(image.functions.length, 0, 'no 0.95-confidence seed for zero-filled bytes');
  assert.equal(image.unwindEntries.length, 0);
  assert.ok(image.warnings.some((w) => w.includes('zero-fill tail')), 'disclosure warning present');
}

// a fully file-backed range keeps recovering normally
{
  const image = parseMachO(buildArm64({ unwindFunctionOffset: 0x800 }), {});
  const status = image.metadata.compactUnwind;
  assert.equal(status.complete, true, 'file-backed entry stays complete');
  assert.equal(status.recovered, 1);
  assert.equal(image.unwindEntries.length, 1);
  assert.equal(String(image.unwindEntries[0].start), String(0x100000800n));
  assert.equal(image.functions.length, 1, 'file-backed range still seeds a function');
  assert.equal(image.functions[0].source, 'unwind');
  assert.equal(image.functions[0].confidence, 0.95);
}

// a range that merely touches the file-backed boundary end is still valid
{
  const image = parseMachO(buildArm64({ unwindFunctionOffset: 0xff0, sentinel: 0x1000 }), {});
  assert.equal(image.metadata.compactUnwind.complete, true);
  assert.equal(image.unwindEntries.length, 1);
}

console.log('issue #5571 compact unwind zero-fill tail fail-closed regression: PASS');

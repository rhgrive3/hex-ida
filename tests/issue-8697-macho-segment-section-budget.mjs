import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho-core.js';

const enc = new TextEncoder();
const S_ZEROFILL = 0x1; // section attributes LOW_MAG byte == 1

function u32(dv, o, v) { dv.setUint32(o, v, true); }
function u64(dv, o, v) { dv.setBigUint64(o, BigInt(v), true); }

// One zero-fill __TEXT segment carrying `nsects` sections. Zero-fill keeps the
// fixture tiny while still materializing a full section object graph.
function macho64(nsects) {
  const cmdsize = 72 + nsects * 80;
  const bytes = new Uint8Array(32 + cmdsize);
  const dv = new DataView(bytes.buffer);
  u32(dv, 0, 0xfeedfacf); dv.setInt32(4, 0x0100000c, true); dv.setInt32(8, 0, true);
  u32(dv, 12, 1);        // filetype MH_OBJECT
  u32(dv, 16, 1);        // ncmds
  u32(dv, 20, cmdsize);  // sizeofcmds
  u32(dv, 32, 0x19); u32(dv, 36, cmdsize);   // LC_SEGMENT_64
  bytes.set(enc.encode('__TEXT\0'), 40);
  u64(dv, 56, 0x1000); u64(dv, 64, 0x20000000); // address, size
  u64(dv, 72, 0); u64(dv, 80, 0);               // fileoff, filesize (zero-fill segment)
  dv.setInt32(88, 0, true); dv.setInt32(92, 0, true); // maxprot/initprot
  u32(dv, 96, nsects); u32(dv, 100, 0);         // nsects, flags
  for (let i = 0; i < nsects; i++) {
    const p = 104 + i * 80;
    bytes.set(enc.encode(`__s${i}\0`), p);
    bytes.set(enc.encode('__TEXT\0'), p + 16);
    u64(dv, p + 32, 0x1000 + i * 0x1000);       // addr
    u64(dv, p + 40, 0x100);                     // size
    u32(dv, p + 48, 0); u32(dv, p + 52, 0);     // offset, resid
    u32(dv, p + 64, S_ZEROFILL);                // flags -> zero-fill
  }
  return bytes;
}

// Normal image keeps every section and stays complete.
{
  const image = parseMachO(macho64(4));
  assert.equal(image.sections.length, 4, 'within-budget sections must all be materialized');
  assert.equal(image.metadata.machoMetadata.complete, true, 'a normal segment must not be marked partial');
}

// The shared object budget now bounds per-section materialization.
{
  // objects default (500k) is replaced with 3: load-command(1) + segment(1)
  // + exactly one section fits; the next section must stop and downgrade.
  const image = parseMachO(macho64(40), { metadataLimits: { objects: 3 } });
  assert.ok(image.sections.length <= 1, `section expansion must be bounded, got ${image.sections.length}`);
  assert.equal(image.metadata.machoMetadata.complete, false, 'budget-exhausted section expansion must mark metadata partial');
  assert.ok(
    image.metadata.machoMetadata.reasons.some((r) => r.includes('segment-section')),
    'a stable budget reason must name segment-section accounting',
  );
  assert.ok(image.metadata.machoMetadata.used.objects <= 3, 'used objects must not exceed the limit');
}

// Estimated-heap accounting bounds the section graph independently of count.
{
  const image = parseMachO(macho64(200), { metadataLimits: { estimatedHeapBytes: 1024 } });
  assert.ok(image.sections.length < 200, 'heap accounting must stop section materialization');
  assert.equal(image.metadata.machoMetadata.complete, false);
}

console.log('issue-8697 Mach-O LC_SEGMENT section expansion metadata budget: PASS');

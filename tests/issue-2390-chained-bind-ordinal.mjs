import assert from 'node:assert/strict';
import { parseChainedBindingSites } from '../js/binary/macho-dyld.js';

function u16(bytes, off, v) { new DataView(bytes.buffer).setUint16(off, v, true); }
function u32(bytes, off, v) { new DataView(bytes.buffer).setUint32(off, v, true); }
function u64(bytes, off, v) { new DataView(bytes.buffer).setBigUint64(off, v, true); }

function fixture(raw, imports, { importsComplete = true } = {}) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  u32(bytes, 4, 28);       // starts_offset
  u32(bytes, 28, 1);       // seg_count
  u32(bytes, 32, 8);       // seg_info_offset[0]
  u32(bytes, 36, 24);      // dyld_chained_starts_in_segment.size
  u16(bytes, 40, 0x1000);  // page_size
  u16(bytes, 42, 2);       // DYLD_CHAINED_PTR_64
  u64(bytes, 44, 0n);      // segment_offset from image base
  u32(bytes, 52, 0);       // max_valid_pointer
  u16(bytes, 56, 1);       // page_count
  u16(bytes, 58, 0);       // page_start[0]
  u64(bytes, 0x100, raw);
  const r = {
    length: bytes.length,
    bytes,
    u16: (o) => view.getUint16(o, true),
    u32: (o) => view.getUint32(o, true),
    u64: (o) => view.getBigUint64(o, true),
  };
  const segment = { address: 0x1000n, size: 0x1000n, fileOffset: 0x100n, fileSize: 0x200n };
  const image = {
    imageBase: 0x1000n,
    metadata: { chainedFixups: { complete: importsComplete, importsComplete } },
    warnings: [],
    segments: [segment],
    addressToOffset(address) {
      return address >= 0x1000n && address < 0x1200n ? 0x100n + (address - 0x1000n) : null;
    },
  };
  const status = parseChainedBindingSites(r, { offset: 0, size: 0x80 }, image, imports, [segment]);
  return { status, image };
}

{
  const imports = [{ name: '_ok', sites: [] }];
  const { status } = fixture((1n << 63n) | 0n, imports);
  assert.equal(status.complete, true);
  assert.equal(status.bindingSitesComplete, true);
  assert.equal(status.bindingSites, 1);
  assert.equal(imports[0].sites.length, 1);
}

for (const ordinal of [1, 5, 0xffffff]) {
  const imports = [{ name: '_only', sites: [] }];
  const { status, image } = fixture((1n << 63n) | BigInt(ordinal), imports);
  assert.equal(status.complete, false);
  assert.equal(status.bindingSitesComplete, false);
  assert.equal(status.bindingSites, 0);
  assert.ok(status.bindingSiteReasons.some((x) => x.includes(`invalid bind ordinal ${ordinal}`)));
  assert.ok(image.warnings.some((x) => x.includes(`invalid bind ordinal ${ordinal}`)));
}

{
  const imports = new Array(1); // parsed import hole
  const { status } = fixture(1n << 63n, imports);
  assert.equal(status.complete, false);
  assert.equal(status.bindingSitesComplete, false);
  assert.equal(status.bindingSites, 0);
}

{
  const imports = [{ name: '_ok', sites: [] }];
  const { status } = fixture((1n << 63n) | 0n, imports, { importsComplete: false });
  assert.equal(status.complete, false, 'partial import table must keep chained-fixups partial');
  assert.equal(status.bindingSitesComplete, false, 'binding-site completeness must inherit known import incompleteness');
  assert.equal(imports[0].sites.length, 1, 'positive site recovery may continue without claiming complete coverage');
  assert.ok(status.bindingSiteReasons.some((x) => x.includes('import table is incomplete')));
}

{
  const imports = [{ name: '_unused', sites: [] }];
  const { status } = fixture(0n, imports); // valid rebase, ordinal field is irrelevant
  assert.equal(status.complete, true);
  assert.equal(status.bindingSitesComplete, true);
  assert.equal(status.bindingSites, 0);
}

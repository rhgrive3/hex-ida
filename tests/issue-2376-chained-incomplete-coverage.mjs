import assert from 'node:assert/strict';

import { ByteView } from '../js/binary/reader.js';
import { parseChainedBindingSites, resolveMachOPointer } from '../js/binary/macho-dyld.js';

const imageBase = 0x100000000n;
const bytes = new Uint8Array(0x1200);
const dv = new DataView(bytes.buffer);
const startsOffset = 0x1c;
const startsBase = startsOffset;
const record = startsBase + 8;
const segment = {
  name: '__DATA',
  address: imageBase + 0x1000n,
  size: 0x1000n,
  fileOffset: 0x100n,
  fileSize: 0x1000n,
};

// One declared chained page whose only chain start is encoding-invalid for an
// 8-byte pointer: 0xffc + 8 crosses the 0x1000-byte page boundary. The loader
// therefore knows this page is chained-owned, but cannot prove any exact site.
dv.setUint32(4, startsOffset, true);
dv.setUint32(startsBase, 1, true);
dv.setUint32(startsBase + 4, 8, true);
dv.setUint32(record, 24, true);
dv.setUint16(record + 4, 0x1000, true);
dv.setUint16(record + 6, 6, true); // DYLD_CHAINED_PTR_64_OFFSET
// segment_offset is relative to image base.
dv.setBigUint64(record + 8, 0x1000n, true);
dv.setUint32(record + 16, 0, true);
dv.setUint16(record + 20, 1, true);
dv.setUint16(record + 22, 0x0ffc, true);

const image = {
  imageBase,
  bits: 64,
  segments: [segment],
  imports: [],
  metadata: { chainedFixups: { complete: true } },
  warnings: [],
  libraries: [],
  addressToOffset(address) {
    const a = BigInt(address);
    if (a < segment.address || a >= segment.address + segment.fileSize) return null;
    return segment.fileOffset + (a - segment.address);
  },
  sectionAt() { return null; },
  segmentAt(address) {
    const a = BigInt(address);
    return a >= imageBase && a < imageBase + 0x100000n ? { address: imageBase, size: 0x100000n } : null;
  },
};

parseChainedBindingSites(
  new ByteView(bytes),
  { offset: 0, size: 0x80 },
  image,
  [],
  [segment],
);

assert.equal(image.metadata.chainedFixups.bindingSitesComplete, false);

const mappedRaw = imageBase + 0x800n;
const metadataSlot = segment.address + 0x200n;
assert.ok(image.segmentAt(mappedRaw), 'counterexample raw value must look like an ordinary in-image VA');
assert.equal(
  resolveMachOPointer(image, mappedRaw, { address: metadataSlot }),
  null,
  'an incomplete chained-owned page must not fall through to ordinary raw-VA exactness',
);

// The fail-closed rule is scoped to the chained-owned page. An ordinary pointer
// stored outside that page remains eligible for the existing in-image proof.
assert.equal(
  resolveMachOPointer(image, mappedRaw, { address: imageBase + 0x5000n }),
  mappedRaw,
);

console.log('issue #2376 incomplete chained-page ownership regression: PASS');

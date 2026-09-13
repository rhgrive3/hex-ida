// #4120: DYLD_CHAINED_PTR_32 (pointer_format 3) rebase entries carry a 26-bit
// vmaddr target, and dyld_chained_starts_in_segment.max_valid_pointer
// classifies chain entries above it as co-opted non-pointer values (Apple
// fixup-chains.h: value = target - (64MB + max_valid_pointer)/2).
import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../../js/binary/reader.js';
import { parseChainedBindingSites, describeMachOPointerSite, resolveMachOPointer } from '../../../js/binary/macho-dyld.js';

const IMAGE_BASE = 0x1000n;
const SITE = 0x101000n;

function makeFixture({ pointerFormat = 3, words, maxValidPointer = 0 } = {}) {
  const bytes = new Uint8Array(0x1200);
  const dv = new DataView(bytes.buffer);
  const startsOffset = 0x1c;
  const startsBase = startsOffset;
  const record = startsBase + 8;
  dv.setUint32(4, startsOffset, true);
  dv.setUint32(startsBase, 1, true);
  dv.setUint32(startsBase + 4, 8, true);
  dv.setUint32(record, 24, true);
  dv.setUint16(record + 4, 0x1000, true);
  dv.setUint16(record + 6, pointerFormat, true);
  dv.setBigUint64(record + 8, 0x100000n, true);
  dv.setUint32(record + 16, maxValidPointer, true);
  dv.setUint16(record + 20, 1, true);
  dv.setUint16(record + 22, 0, true);

  const segment = { name: '__DATA', address: IMAGE_BASE + 0x100000n, size: 0x1000n, fileOffset: 0x100n, fileSize: 0x1000n };
  const width = pointerFormat === 3 ? 4 : 8;
  const written = [];
  for (const [pageOffset, raw] of words) {
    if (width === 4) dv.setUint32(Number(segment.fileOffset) + pageOffset, Number(raw), true);
    else dv.setBigUint64(Number(segment.fileOffset) + pageOffset, BigInt(raw), true);
    written.push(SITE + BigInt(pageOffset));
  }
  const image = {
    imageBase: IMAGE_BASE,
    segments: [segment],
    metadata: { chainedFixups: { complete: true } },
    warnings: [],
    addressToOffset(address) {
      const a = BigInt(address);
      if (a < segment.address || a >= segment.address + segment.size) return null;
      return segment.fileOffset + (a - segment.address);
    },
    segmentAt(address) {
      const a = BigInt(address);
      return a >= IMAGE_BASE && a < 0x104000n ? { address: IMAGE_BASE, size: 0x103000n } : null;
    },
    sectionAt() { return null; },
  };
  const imports = [{ name: '_foo', sites: [] }];
  const status = parseChainedBindingSites(new ByteView(bytes), { offset: 0, size: 0x80 }, image, imports, [segment]);
  return { image, status, imports, written };
}

test('#4120 format 3 rebase decodes its 26-bit vmaddr target and resolves', () => {
  const { image, status } = makeFixture({ words: [[0x0, 0x00102000n]], maxValidPointer: 0x00ffffff });
  assert.equal(resolveMachOPointer(image, 0x00102000n, { address: SITE }), 0x00102000n);
  const view = describeMachOPointerSite(image, 0x00102000n, SITE);
  assert.equal(view.decoded.target, 0x00102000n);
  assert.equal(view.decoded.bind, false);
  assert.equal(status.complete, true);
  assert.deepEqual(image.warnings, []);
});

test('#4120 format 3 rebase with next advances the chain while keeping the target', () => {
  const raw1 = (2n << 26n) | 0x00102000n;
  const raw2 = 0x00102004n;
  const { image, status } = makeFixture({ words: [[0x0, raw1], [0x8, raw2]], maxValidPointer: 0x00ffffff });
  assert.equal(resolveMachOPointer(image, raw1, { address: SITE }), 0x00102000n);
  assert.equal(resolveMachOPointer(image, raw2, { address: SITE + 8n }), 0x00102004n);
  assert.equal(status.complete, true);
  assert.deepEqual(image.warnings, []);
});

test('#4120 format 3 bind keeps its existing ordinal/addend decode', () => {
  const raw = (1n << 31n) | (3n << 20n) | 0n;
  const { image, imports, status } = makeFixture({ words: [[0x0, raw]] });
  assert.equal(imports[0].sites[0].kind, 'chained-bind');
  assert.equal(imports[0].sites[0].addend, 3n);
  const view = describeMachOPointerSite(image, raw, SITE);
  assert.equal(view.decoded.bind, true);
  assert.equal(view.decoded.ordinal, 0);
  assert.equal(view.decoded.addend, 3n);
  assert.equal(status.complete, true);
});

test('#4120 chain entry above max_valid_pointer is restored as a co-opted value, never a target', () => {
  // original value 0x00102000 (a mapped VA) + bias (64MB + 0x00ffffff)/2
  // = 0x02901fff stored in the 26-bit target field, above max_valid_pointer.
  const raw = 0x02901fffn;
  const { image, status } = makeFixture({ words: [[0x0, raw]], maxValidPointer: 0x00ffffff });
  assert.equal(resolveMachOPointer(image, raw, { address: SITE }), null,
    'a co-opted non-pointer must not be published as a pointer target even when its restored value is mapped');
  const view = describeMachOPointerSite(image, raw, SITE);
  assert.equal(view.decoded.bind, false);
  assert.equal(view.decoded.target, null);
  assert.equal(view.decoded.coOpted, true);
  assert.equal(view.decoded.coOptedValue, 0x00102000n);
  assert.equal(status.complete, true);
});

test('#4120 format 3 out-of-image target still requires mapped-image proof', () => {
  const raw = 0x03ffffffn;
  const { image } = makeFixture({ words: [[0x0, raw]], maxValidPointer: 0x03ffffff });
  const view = describeMachOPointerSite(image, raw, SITE);
  assert.equal(view.decoded.target, 0x03ffffffn);
  assert.equal(resolveMachOPointer(image, raw, { address: SITE }), null);
});

test('#4120 formats 6/9 rebase decode does not regress', () => {
  const { image: f6 } = makeFixture({ pointerFormat: 6, words: [[0x0, 0x880n]] });
  assert.equal(resolveMachOPointer(f6, 0x880n, { address: SITE }), IMAGE_BASE + 0x880n);
  const { image: f9 } = makeFixture({ pointerFormat: 9, words: [[0x0, 0x800n]] });
  assert.equal(resolveMachOPointer(f9, 0x800n, { address: SITE }), IMAGE_BASE + 0x800n);
});

import assert from 'node:assert/strict';
import {
  MemoryByteSource,
  detectBinary,
  openBinary,
  openBinarySource,
} from '../../../js/binary/index.js';

const BASE = 0x180000000n;
const SLIDE = 0x2000n;

function writeAscii(bytes, offset, value, width) {
  for (let i = 0; i < width; i++) bytes[offset + i] = i < value.length ? value.charCodeAt(i) : 0;
}
function u16(view, offset, value) { view.setUint16(offset, value, true); }
function u32(view, offset, value) { view.setUint32(offset, value, true); }
function u64(view, offset, value) { view.setBigUint64(offset, BigInt(value), true); }

function makeCache({ slideInfoVersion = 2, overlap = false } = {}) {
  const bytes = new Uint8Array(0x5000);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'dyld_v1  x86_64', 16);
  u32(view, 0x10, 0x200); // mappingOffset
  u32(view, 0x14, 2);     // mappingCount
  u32(view, 0x18, 0);     // legacy image array is intentionally absent
  u32(view, 0x1c, 0);
  u64(view, 0x20, BASE + 0x100n);
  for (let i = 0; i < 16; i++) bytes[0x58 + i] = i + 1;
  u32(view, 0xd8, 2);     // platform fixture identity
  u32(view, 0xdc, 0);
  u64(view, 0xe0, BASE);  // sharedRegionStart
  u64(view, 0xe8, 0x2000n);
  u64(view, 0xf0, 0x4000n); // maxSlide
  u32(view, 0x138, 0x300); // mappingWithSlideOffset
  u32(view, 0x13c, 1);     // mappingWithSlideCount

  // dyld_cache_mapping_info[2]
  const mappings = [
    { address: BASE, size: 0x1000n, fileOffset: 0x1000n, maxProt: 5, initProt: 5 },
    { address: BASE + (overlap ? 0x800n : 0x1000n), size: 0x1000n, fileOffset: 0x2000n, maxProt: 3, initProt: 3 },
  ];
  for (let i = 0; i < mappings.length; i++) {
    const p = 0x200 + i * 32;
    const m = mappings[i];
    u64(view, p, m.address);
    u64(view, p + 8, m.size);
    u64(view, p + 16, m.fileOffset);
    u32(view, p + 24, m.maxProt);
    u32(view, p + 28, m.initProt);
  }

  // dyld_cache_mapping_and_slide_info for the writable mapping.
  u64(view, 0x300, mappings[1].address);
  u64(view, 0x308, mappings[1].size);
  u64(view, 0x310, mappings[1].fileOffset);
  u64(view, 0x318, 0x400n); // slideInfoFileOffset
  u64(view, 0x320, 0x40n);  // slideInfoFileSize
  u64(view, 0x328, 0n);     // flags
  u32(view, 0x330, 3);
  u32(view, 0x334, 3);

  // dyld_cache_slide_info2 with one page and one terminal rebase.
  u32(view, 0x400, slideInfoVersion);
  u32(view, 0x404, 0x1000);
  u32(view, 0x408, 40); // page_starts_offset
  u32(view, 0x40c, 1);  // page_starts_count
  u32(view, 0x410, 42); // page_extras_offset
  u32(view, 0x414, 0);  // page_extras_count
  u64(view, 0x418, 0xc000000000000000n); // delta mask
  u64(view, 0x420, BASE); // value_add
  u16(view, 0x428, 0); // first rebase is at page offset zero
  u64(view, 0x2000, 0x80n); // target = BASE + 0x80, next=0
  return bytes;
}

const bytes = makeCache();
assert.deepEqual(detectBinary(bytes.subarray(0, 16), {
  probeLength: 16n,
  totalSize: BigInt(bytes.length),
}), { format: 'dyld-shared-cache', arch: 'x86_64', version: 1 });

const image = openBinary(bytes, { slide: SLIDE });
assert.equal(image.format, 'dyld-shared-cache');
assert.equal(image.arch, 'x86_64');
assert.equal(image.imageBase, BASE + SLIDE);
assert.equal(image.addressToOffset(BASE + SLIDE), 0x1000n);
assert.equal(image.addressToOffset(BASE + 0x1000n + SLIDE), 0x2000n);
assert.equal(image.metadata.dyldSharedCache.slide, SLIDE);
assert.equal(image.metadata.dyldSharedCache.sharedRegionStart, BASE);
assert.equal(image.metadata.dyldSharedCache.runtimeSharedRegionStart, BASE + SLIDE);
assert.equal(image.metadata.dyldSharedCache.mappingWithSlide[0].slideInfo.version, 2);
assert.equal(image.metadata.dyldSharedCache.mappingWithSlide[0].slideInfo.complete, true);
assert.equal(image.metadata.dyldSharedCache.mappingWithSlide[0].slideInfo.rebaseCount, 1);
assert.deepEqual(image.metadata.dyldSharedCache.mappingWithSlide[0].slideInfo.rebases[0], {
  storageAddress: BASE + 0x1000n,
  runtimeStorageAddress: BASE + 0x1000n + SLIDE,
  rawValue: 0x80n,
  targetAddress: BASE + 0x80n,
  runtimeTargetAddress: BASE + 0x80n + SLIDE,
  authenticated: false,
});

const sourceImage = await openBinarySource(new MemoryByteSource(bytes, { maxReadLength: 8 }), { slide: SLIDE });
assert.equal(sourceImage.format, 'dyld-shared-cache');
assert.equal(sourceImage.source?.size, BigInt(bytes.length));
assert.equal(sourceImage.addressToOffset(BASE + 0x1000n + SLIDE), 0x2000n);
assert.equal(sourceImage.metadata.dyldSharedCache.mappingWithSlide[0].slideInfo.rebaseCount, 1);
assert.equal(sourceImage.metadata.dyldSharedCache.mappingWithSlide[0].slideInfo.rebases[0].runtimeTargetAddress, BASE + 0x80n + SLIDE);

assert.throws(() => openBinary(bytes, { slide: 0x5000n }), /exceeds declared maxSlide/);
assert.throws(() => openBinary(makeCache({ overlap: true })), /overlapping dyld shared cache virtual mappings/);
assert.throws(() => openBinary(makeCache({ slideInfoVersion: 99 }), { slide: SLIDE }), /unsupported dyld shared cache slide info version 99/);

const fake = bytes.slice();
writeAscii(fake, 0, 'dyld_v1  mystery', 16);
assert.deepEqual(detectBinary(fake.subarray(0, 16), { probeLength: 16n, totalSize: BigInt(fake.length) }), { format: 'unknown' });
assert.throws(() => openBinary(fake), /対応していない実行ファイル形式/);

console.log('issue-7036 dyld shared-cache public input: ok');

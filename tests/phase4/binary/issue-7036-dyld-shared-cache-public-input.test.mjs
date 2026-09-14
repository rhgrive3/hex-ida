import assert from 'node:assert/strict';
import {
  MemoryByteSource,
  detectBinary,
  openBinary,
  openBinarySource,
} from '../../../js/binary/index.js';

import { BASE, SLIDE, makeCache } from '../../scpa/fixtures/x02-dyld-shared-cache.mjs';

function writeAscii(bytes, offset, value, width) {
  for (let i = 0; i < width; i++) bytes[offset + i] = i < value.length ? value.charCodeAt(i) : 0;
}

function makeLegacyCacheWithSlideInfo() {
  const bytes = new Uint8Array(0x3000);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'dyld_v1  x86_64', 16);
  view.setUint32(0x10, 0x70, true);
  view.setUint32(0x14, 1, true);
  view.setBigUint64(0x20, BASE, true);
  view.setBigUint64(0x38, 0x300n, true); // legacy slideInfoOffset
  view.setBigUint64(0x40, 0x40n, true);  // legacy slideInfoSize
  view.setBigUint64(0x70, BASE, true);
  view.setBigUint64(0x78, 0x1000n, true);
  view.setBigUint64(0x80, 0x1000n, true);
  view.setUint32(0x88, 3, true);
  view.setUint32(0x8c, 3, true);
  view.setUint32(0x300, 99, true);
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

const legacyUnsupported = makeLegacyCacheWithSlideInfo();
assert.throws(() => openBinary(legacyUnsupported), /legacy dyld shared cache slide info is unsupported/);
await assert.rejects(() => openBinarySource(new MemoryByteSource(legacyUnsupported, { maxReadLength: 8 })), /legacy dyld shared cache slide info is unsupported/);

const fake = bytes.slice();
writeAscii(fake, 0, 'dyld_v1  mystery', 16);
assert.deepEqual(detectBinary(fake.subarray(0, 16), { probeLength: 16n, totalSize: BigInt(fake.length) }), { format: 'unknown' });
assert.throws(() => openBinary(fake), /対応していない実行ファイル形式/);

console.log('issue-7036 dyld shared-cache public input: ok');

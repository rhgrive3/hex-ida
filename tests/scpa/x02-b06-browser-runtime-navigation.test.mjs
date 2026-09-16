import assert from 'node:assert/strict';
import test from 'node:test';

import { openBinarySource } from '../../js/binary/index.js';
import {
  mapDyldRuntimeAddress,
  normalizeDyldRuntimeAddress,
  normalizeDyldRuntimeSlide,
} from '../../js/binary/dyld-runtime.js';
import { BASE, SLIDE, makeCache } from './fixtures/x02-dyld-shared-cache.mjs';

test('X02-B-06: browser product mapping uses the production slide-aware dyld loader', async () => {
  const bytes = makeCache({ architecture:'arm64' });
  const image = await openBinarySource(bytes, { slide:SLIDE });
  assert.equal(image.format, 'dyld-shared-cache');
  assert.equal(image.imageBase, BASE + SLIDE);

  const cache = image.metadata.dyldSharedCache;
  assert.equal(cache.slide, SLIDE);
  assert.equal(cache.sharedRegionStart, BASE);
  assert.equal(cache.runtimeSharedRegionStart, BASE + SLIDE);
  assert.equal(cache.mappingWithSlide[0].slideInfo.version, 2);
  assert.equal(cache.mappingWithSlide[0].slideInfo.rebaseCount, 1);

  const runtimeTarget = BASE + SLIDE + 0x80n;
  const target = mapDyldRuntimeAddress(image, runtimeTarget, SLIDE);
  assert.equal(target.mapped, true);
  assert.equal(target.unslidAddress, BASE + 0x80n);
  assert.equal(target.fileOffset, 0x1080n);
  assert.equal(target.rebase?.role, 'target');
  assert.equal(target.rebase?.runtimeTargetAddress, runtimeTarget);

  const runtimeStorage = BASE + SLIDE + 0x1000n;
  const storage = mapDyldRuntimeAddress(image, runtimeStorage, SLIDE);
  assert.equal(storage.mapped, true);
  assert.equal(storage.unslidAddress, BASE + 0x1000n);
  assert.equal(storage.fileOffset, 0x2000n);
  assert.equal(storage.rebase?.role, 'storage');
  assert.equal(storage.rebase?.runtimeStorageAddress, runtimeStorage);
});

test('X02-B-06: browser runtime input remains exact and invalid slides fail closed', async () => {
  assert.equal(normalizeDyldRuntimeSlide('0x180d8000'), 0x180d8000n);
  assert.equal(normalizeDyldRuntimeAddress('6442451072'), 6442451072n);
  assert.throws(() => normalizeDyldRuntimeSlide('-1'), /hexadecimal.*decimal|exact integer/i);
  assert.throws(() => normalizeDyldRuntimeAddress('not-an-address'), /hexadecimal.*decimal/i);

  const bytes = makeCache({ architecture:'arm64' });
  await assert.rejects(
    openBinarySource(bytes, { slide:0x6000n }),
    /exceeds declared maxSlide/i,
  );
});

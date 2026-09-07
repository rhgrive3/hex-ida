// Regression for #5886: segment/section permissions are canonical R/W/X
// authority — only real booleans may become true. Truthiness promoted
// 'false'/[]/{} to execute/write authority.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BinaryImage } from '../js/binary/model.js';

function imageWith(perms) {
  const image = new BinaryImage(new Uint8Array(16), { format: 'test', arch: 'arm64' });
  image.addSegment({
    name: 'probe',
    address: 0n,
    size: 16n,
    fileOffset: 0n,
    fileSize: 16n,
    perms,
  });
  const region = image.regions?.find((item) => item.name === 'probe') ?? image.segments?.[0];
  return region?.perms ?? region?.permissions;
}

test('#5886 schema-invalid permission values never become true', () => {
  const perms = imageWith({ read: 'false', write: [], execute: {} });
  assert.deepEqual(perms, { read: false, write: false, execute: false });
});

test('#5886 real booleans survive normalization', () => {
  assert.deepEqual(imageWith({ read: true, execute: true }), { read: true, write: false, execute: true });
  assert.deepEqual(imageWith({ read: true, write: true, execute: true }), { read: true, write: true, execute: true });
  assert.deepEqual(imageWith(undefined), { read: false, write: false, execute: false });
  assert.deepEqual(imageWith('garbage'), { read: false, write: false, execute: false });
});

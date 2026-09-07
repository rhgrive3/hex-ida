// Issue #5886 regression: segment/section permissions are a typed R/W/X
// authority — truthiness used to promote 'false'/[]/{} into granted access.
// Issue #5891 regression: mergeFunctionSeeds must canonicalize number
// size/end/address extents to BigInt instead of throwing a raw
// "Cannot mix BigInt and other types" TypeError.
import assert from 'node:assert/strict';
import { BinaryImage, mergeFunctionSeeds } from '../js/binary/model.js';

// #5886 — schema-invalid permission values must not become granted access.
{
  const image = new BinaryImage(new Uint8Array(16), { format: 'test', arch: 'arm64' });
  image.addSegment({
    name: 'bad-perms', address: 0n, size: 16n, fileOffset: 0n, fileSize: 16n,
    perms: { read: 'false', write: [], execute: {} },
  });
  assert.deepEqual(image.segments[0].perms, { read: false, write: false, execute: false });
}

// #5886 — genuine booleans keep their meaning.
{
  const image = new BinaryImage(new Uint8Array(16), { format: 'test', arch: 'arm64' });
  image.addSegment({
    name: 'ok-perms', address: 0n, size: 16n, fileOffset: 0n, fileSize: 16n,
    perms: { read: true, write: false, execute: true },
  });
  assert.deepEqual(image.segments[0].perms, { read: true, write: false, execute: true });
}

// #5891 — a safe-integer number extent merges cleanly.
{
  const out = mergeFunctionSeeds([{ address: 0x1000n, size: 4, source: 'symbol', confidence: 1 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].end, 4100n, `size:4 must canonicalize to a BigInt end extent`);
}

// #5891 — number address + number end also merge cleanly.
{
  const out = mergeFunctionSeeds([{ address: 0x2000, end: 0x2010, source: 'symbol', confidence: 1 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].size, 16n);
}

// #5891 — a structured extent value is dropped fail-closed (no coercion).
{
  const out = mergeFunctionSeeds([{ address: 0x3000n, size: ['4'], source: 'symbol', confidence: 1 }]);
  assert.equal(out.length, 0, 'structured extent values must not coerce into an extent');
}

// #5891 — pure BigInt seeds are unchanged.
{
  const out = mergeFunctionSeeds([{ address: 0x4000n, size: 0x10n, end: 0x4010n, source: 'symbol', confidence: 1 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].end, 0x4010n);
}

console.log('issues #5886/#5891 binary model typed contracts regressions: PASS');

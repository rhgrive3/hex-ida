import assert from 'node:assert/strict';
import { repairMachOZeroEntrypoint } from '../../../js/binary/macho.js';
import { BinaryImage } from '../../../js/binary/model.js';

// Issue #8758: `repairMachOZeroEntrypoint()` is the compatibility path that
// promotes an explicit VA-0 entrypoint skipped by `macho-core.js` (its
// `entrypoint !== 0n` guard). Before this fix it validated only the executable
// permission and 4-byte alignment of the segment at VA 0, so an executable
// zero-fill (`__TEXT`/`__PAGEZERO` style, fileoff+filesize == 0) segment minted
// a confidence-0.9 entrypoint function seed even though `image.addressToOffset(0n)`
// is null and there are no instruction bytes. This mirrors the file-backed
// instruction-span authority the #5555 routines/entrypoint paths already require.

function imageWithExecutableZeroSegment({ fileSize }) {
  const bytes = new Uint8Array(0x400);
  const image = new BinaryImage(bytes, {
    format: 'macho', arch: 'arm64', entrypoint: 0n,
    metadata: { entrypointSource: 'LC_UNIXTHREAD' },
  });
  // arm64 instruction unit is 4 bytes; the segment is executable + aligned at VA 0.
  image.addSegment({ name: '__TEXT', address: 0n, size: 0x1000n, fileOffset: 0n, fileSize, perms: { read: true, execute: true } });
  return image;
}

const seedsOf = (image, source) => image.functions.filter((f) => f.source === source);

// --- the reported bug: executable but zero-fill (no file bytes at VA 0) ------
{
  const image = repairMachOZeroEntrypoint(imageWithExecutableZeroSegment({ fileSize: 0n }));
  assert.equal(image.metadata.entrypointValid, false, 'a zero-fill VA-0 entrypoint must not become a valid entrypoint');
  assert.equal(image.addressToOffset(0n), null, 'fixture: VA 0 has no file bytes');
  assert.deepEqual(seedsOf(image, 'entrypoint').map((f) => f.address.toString()), [],
    'a zero-fill VA 0 must not mint an entrypoint function seed');
  assert.ok(image.warnings.some((w) => w.includes('Ignored LC_UNIXTHREAD entrypoint 0x0') && w.includes('file-backed')),
    'the rejection must be attributed to the missing file-backed instruction span');
}

// --- partial file-backed span shorter than one instruction unit -------------
{
  const image = repairMachOZeroEntrypoint(imageWithExecutableZeroSegment({ fileSize: 2n }));
  assert.equal(image.metadata.entrypointValid, false, 'a <4-byte file-backed head still cannot be an arm64 instruction start');
  assert.equal(seedsOf(image, 'entrypoint').length, 0, 'partial instruction span must not mint an entrypoint seed');
}

// --- #2104 compatibility: a genuinely file-backed VA 0 still promotes --------
{
  const image = repairMachOZeroEntrypoint(imageWithExecutableZeroSegment({ fileSize: 0x400n }));
  assert.equal(image.metadata.entrypointValid, true, 'a file-backed, executable, aligned VA 0 stays a valid entrypoint (#2104)');
  const seeds = seedsOf(image, 'entrypoint');
  assert.equal(seeds.length, 1, 'file-backed VA 0 still mints exactly one entrypoint seed');
  assert.equal(seeds[0].address, 0n);
}

console.log('issue #8758 mach-o zero-entrypoint file-backed instruction-span regression: PASS');

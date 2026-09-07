import assert from 'node:assert/strict';
import { BinaryImage, sectionHasMappedAddress } from '../../../js/binary/model.js';
import { sectionHasMappedAddress as auditSectionHasMappedAddress } from '../../../js/binary/audit.js';

assert.strictEqual(
  auditSectionHasMappedAddress,
  sectionHasMappedAddress,
  'audit and BinaryImage must share one mapped-section predicate',
);

function fillRange(bytes, start, length, seed) {
  for (let i = 0; i < length; i++) bytes[start + i] = (seed + i) & 0xff;
}

function addMappings(image, { allocSection = false } = {}) {
  const segment = image.addSegment({
    name: 'PT_LOAD',
    address: 0x1000n,
    size: 0x100n,
    fileOffset: 0x200n,
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: true },
    source: 'program-header',
  });
  const section = image.addSection({
    name: allocSection ? '.mapped' : '.debug_shadow',
    address: 0x1010n,
    size: 0x10n,
    fileOffset: 0x500n,
    fileSize: 0x10n,
    perms: { read: allocSection, write: false, execute: false },
    flags: allocSection ? 0x2n : 0n,
    source: 'section-header',
  });
  return { segment, section };
}

// Non-ALLOC ELF section metadata must remain visible without owning virtual addresses.
{
  const bytes = new Uint8Array(0x800);
  fillRange(bytes, 0x200, 0x100, 0x20);
  fillRange(bytes, 0x500, 0x10, 0xe0);

  const image = new BinaryImage(bytes, { format: 'elf' });
  const { segment, section } = addMappings(image);

  assert.equal(sectionHasMappedAddress(section), false);
  assert.strictEqual(image.sectionAt(0x1010n), section, 'unmapped section metadata must be retained');
  assert.equal(image.addressToOffset(0x1010n), 0x210n, 'PT_LOAD must own the overlapped VA');
  assert.equal(image.offsetToAddress(0x210n), 0x1010n, 'PT_LOAD round-trip must survive the overlap');
  assert.equal(image.offsetToAddress(0x500n), null, 'non-ALLOC section file bytes must not create a VA mapping');

  const resolved = image.resolveVirtualMapping(0x1010n);
  assert.ok(resolved);
  assert.strictEqual(resolved.mapping, segment);
  assert.equal(resolved.offset, 0x210n);

  const got = image.readVirtual(0x1008n, 0x20n);
  assert.ok(got);
  assert.deepEqual(
    [...got],
    [...bytes.subarray(0x208, 0x228)],
    'non-ALLOC section must not split or redirect a read through PT_LOAD',
  );
}

// SHF_ALLOC control: a mapped section remains the narrower canonical mapping.
{
  const bytes = new Uint8Array(0x800);
  fillRange(bytes, 0x200, 0x100, 0x20);
  fillRange(bytes, 0x500, 0x10, 0xe0);

  const image = new BinaryImage(bytes, { format: 'elf' });
  const { section } = addMappings(image, { allocSection: true });

  assert.equal(sectionHasMappedAddress(section), true);
  assert.equal(image.addressToOffset(0x1010n), 0x500n);
  assert.equal(image.offsetToAddress(0x500n), 0x1010n);
  assert.deepEqual(
    [...image.readVirtual(0x1010n, 4n)],
    [...bytes.subarray(0x500, 0x504)],
  );
}

// Source-backed reads must choose the same owner as resident reads.
{
  const bytes = new Uint8Array(0x800);
  fillRange(bytes, 0x200, 0x100, 0x30);
  fillRange(bytes, 0x500, 0x10, 0xf0);
  const source = {
    size: BigInt(bytes.length),
    async readExactly(offset, length) {
      const start = Number(offset);
      const len = Number(length);
      return bytes.subarray(start, start + len);
    },
  };
  const image = new BinaryImage(null, { format: 'elf', source, fileSize: source.size });
  addMappings(image);

  assert.equal(image.addressToOffset(0x1010n), 0x210n);
  const got = await image.readVirtualAsync(0x1010n, 4n);
  assert.deepEqual([...got], [...bytes.subarray(0x210, 0x214)]);
}

assert.equal(sectionHasMappedAddress({ source: 'unmapped-section' }), false);
assert.equal(sectionHasMappedAddress({ source: 'section-header', flags: 0x2n }), true);
assert.equal(sectionHasMappedAddress({ source: 'section-header', flags: 0n }), false);

console.log('issue #3737 ELF non-ALLOC virtual mapping tests: PASS');

import assert from 'node:assert/strict';
import test from 'node:test';

import { BinaryImage } from '../../js/binary/model.js';

// #8880: buildVirtualMappingRuns() rebuilt the interval-owner index by rescanning the
// whole live mapping set at every boundary, so an attacker-controlled nested mapping
// topology made the FIRST virtual-address lookup Θ(N^2) outside the parser's work and
// wall-clock accounting. The owner rule itself must not change: the smallest live
// mapping wins, and the earliest source order breaks a size tie.

// Brute-force oracle over the normalized mappings, independent of the sweep structure.
function bruteForceOwner(image, address) {
  let best = null;
  let order = 0;
  for (const mapping of [...image.sections, ...image.segments]) {
    if (mapping.size > 0n && address >= mapping.address && address < mapping.address + mapping.size) {
      if (!best || mapping.size < best.size || (mapping.size === best.size && order < best.order)) {
        best = { name: mapping.name, size: mapping.size, order };
      }
    }
    order++;
  }
  return best;
}

let seed = 0x5eed1e;
function random(limit) {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) % limit;
}

test('#8880 run index keeps the smallest-live-mapping owner for nested, disjoint and coincident topologies', () => {
  for (let trial = 0; trial < 120; trial++) {
    const count = 1 + random(12);
    const image = new BinaryImage(new Uint8Array(1), { format: 'test', arch: 'x86_64', bits: 64 });
    for (let i = 0; i < count; i++) {
      const start = BigInt(random(40));
      const size = BigInt(1 + random(30));
      const mapping = { name: `m${i}`, address: start, size, fileOffset: start, fileSize: size, perms: { read: true } };
      // Alternate kinds so the source-order tie-break crosses sections and segments.
      if (i % 2 === 0) image.addSection(mapping); else image.addSegment(mapping);
    }
    for (let address = 0n; address < 80n; address++) {
      const expected = bruteForceOwner(image, address);
      const actual = image._virtualMappingAt(address);
      assert.equal(
        actual ? `${actual.source}:${actual.name}` : null,
        expected ? `test:${expected.name}` : null,
        `trial ${trial} address ${address}`,
      );
    }
  }
});

test('#8880 exact size ties resolve to the earliest source order across sections and segments', () => {
  const sectionFirst = new BinaryImage(new Uint8Array(1), { format: 'test' });
  sectionFirst.addSection({ name: 'section-tie', address: 0x1000n, size: 0x100n, fileOffset: 0n, fileSize: 0x100n, perms: { read: true } });
  sectionFirst.addSegment({ name: 'segment-tie', address: 0x1000n, size: 0x100n, fileOffset: 0n, fileSize: 0x100n, perms: { read: true } });
  assert.equal(sectionFirst._virtualMappingAt(0x1010n).name, 'section-tie');

  const segmentFirst = new BinaryImage(new Uint8Array(1), { format: 'test' });
  segmentFirst.addSegment({ name: 'segment-first', address: 0x1000n, size: 0x100n, fileOffset: 0n, fileSize: 0x100n, perms: { read: true } });
  segmentFirst.addSection({ name: 'section-later', address: 0x1000n, size: 0x100n, fileOffset: 0n, fileSize: 0x100n, perms: { read: true } });
  // The canonical index enumerates sections before segments, so source order is the
  // section list first and then the segment list; equal sizes keep that precedence.
  assert.equal(segmentFirst._virtualMappingAt(0x1010n).name, 'section-later');
  assert.equal(segmentFirst._virtualMappingAt(0x1010n).source, 'test');

  const sameKindTie = new BinaryImage(new Uint8Array(1), { format: 'test' });
  sameKindTie.addSection({ name: 'earlier', address: 0x1000n, size: 0x100n, fileOffset: 0n, fileSize: 0x100n, perms: { read: true } });
  sameKindTie.addSection({ name: 'later', address: 0x1000n, size: 0x100n, fileOffset: 0n, fileSize: 0x100n, perms: { read: true } });
  assert.equal(sameKindTie._virtualMappingAt(0x1010n).name, 'earlier');

  const narrowing = new BinaryImage(new Uint8Array(1), { format: 'test' });
  narrowing.addSection({ name: 'wide', address: 0x1000n, size: 0x800n, fileOffset: 0n, fileSize: 0x800n, perms: { read: true } });
  narrowing.addSection({ name: 'narrow', address: 0x1200n, size: 0x40n, fileOffset: 0x1200n, fileSize: 0x40n, perms: { read: true } });
  assert.equal(narrowing._virtualMappingAt(0x1210n).name, 'narrow');
  assert.equal(narrowing._virtualMappingAt(0x1100n).name, 'wide');
  assert.equal(narrowing._virtualMappingAt(0x1400n).name, 'wide');
  assert.equal(narrowing._virtualMappingAt(0x2000n), null);
});

test('#8880 index construction on a pathological nested mapping is bounded, not quadratic', () => {
  const count = 30000;
  const base = 0x100000000n;
  const image = new BinaryImage(new Uint8Array(1), { format: 'test', arch: 'arm64', bits: 64 });
  for (let i = 0; i < count; i++) {
    image.addSection({
      name: `.nested${i}`,
      address: base + BigInt(i),
      size: BigInt(4 * count - 2 * i),
      fileOffset: 1000n + BigInt(i),
      fileSize: BigInt(4 * count - 2 * i),
      perms: { read: true, execute: true },
    });
  }
  const probe = base + BigInt(2 * count - 1);
  const started = process.hrtime.bigint();
  const owner = image._virtualMappingAt(probe);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  // The same 30k nested topology spent ~75 s in this lookup before the owner minimum was
  // maintained incrementally; the bounded sweep stays far below this ceiling even on a
  // loaded runner, so a regression cannot silently reintroduce the quadratic index.
  assert.ok(elapsedMs < 12000, `first virtual mapping took ${elapsedMs.toFixed(0)} ms`);
  // Every mapping contains the probe address, so the owner is the narrowest one: the last.
  assert.equal(owner.name, `.nested${count - 1}`);
  assert.deepEqual(bruteForceOwner(image, probe), {
    name: `.nested${count - 1}`,
    size: BigInt(4 * count - 2 * (count - 1)),
    order: count - 1,
  });
  assert.equal(image.addressToOffset(probe), 1000n + BigInt(count - 1) + (probe - (base + BigInt(count - 1))));
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { BinaryImage, functionSeed } from '../../js/binary/model.js';

// #8754: `BinaryImage.finalize()` inferred the extent of an unsized function seed by
// scanning the whole executable-region list for every adjacent function-start pair, so
// `F` seeds over `R` regions cost up to `2 * F * R` interval tests (the reported shape,
// 20k one-byte executable sections under 20k `LC_FUNCTION_STARTS` entries, measured
// 5,763 ms — after the Mach-O metadata wall-clock budget had already been snapshotted).
// The monotonic sweep replaced that scan, but the selection rule must not move: the
// smallest containing region wins and the earliest source order breaks an exact size tie,
// because `sameCanonicalRegion` / `withinRegionEnd` decide whether an extent is published
// as inferred at all. A lookup that silently reverts to a linear scan, or that starts
// preferring a wider region, both have to fail this gate.

const EXEC = { read: true, execute: true };
const NON_EXEC = { read: true };

// Brute-force oracle over the region set, independent of the sweep structure. Region
// identity (not just coordinates) is what `mergeFunctionSeeds()` compares.
function executableRegions(sections, segments) {
  return [...sections, ...segments]
    .filter((r) => r && r.address != null && r.size != null && BigInt(r.size) > 0n && r.perms?.execute)
    .sort((a, b) => (BigInt(a.size) < BigInt(b.size) ? -1 : BigInt(a.size) > BigInt(b.size) ? 1 : 0));
}

function bruteForceRegion(regions, address) {
  for (const region of regions) {
    if (address >= BigInt(region.address) && address < BigInt(region.address) + BigInt(region.size)) return region;
  }
  return null;
}

// Replays the documented extent rule with the linear pre-fix lookup, so every assertion
// below is about equivalence and cost, never about the current implementation's choice.
function oracleExtents(seeds, sections, segments) {
  const regions = executableRegions(sections, segments);
  const ordered = [...seeds]
    .filter((s) => s && s.address != null)
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return ordered.map((seed, index) => {
    let size = seed.size == null ? null : BigInt(seed.size);
    let end = seed.end == null ? null : BigInt(seed.end);
    if (end == null && size != null) end = seed.address + size;
    if (size == null && end != null && end > seed.address) size = end - seed.address;
    const next = ordered[index + 1];
    if (size == null && next && next.address > seed.address) {
      const proven = seed.source === 'function_starts' && next.source === 'function_starts';
      const currentRegion = bruteForceRegion(regions, seed.address);
      const nextRegion = bruteForceRegion(regions, next.address);
      const sameCanonicalRegion = regions.length === 0 || (currentRegion != null && currentRegion === nextRegion);
      const withinRegionEnd = !currentRegion || next.address <= BigInt(currentRegion.address) + BigInt(currentRegion.size);
      if (proven && sameCanonicalRegion && withinRegionEnd && next.address - seed.address <= 0x1000000n) {
        size = next.address - seed.address;
        end = next.address;
      } else {
        size = null;
        end = null;
      }
    }
    return { address: seed.address, size, end, inferred: seed.size == null && seed.end == null && size != null };
  });
}

function imageWith({ sections = [], segments = [], seeds = [] }) {
  const image = new BinaryImage(new Uint8Array(1), { format: 'test', arch: 'x86_64', bits: 64 });
  for (const region of segments) {
    image.addSegment({ name: region.name, address: region.address, size: region.size, fileOffset: 0n, fileSize: region.size, perms: region.perms });
  }
  for (const region of sections) {
    image.addSection({ name: region.name, address: region.address, size: region.size, fileOffset: 0n, fileSize: region.size, perms: region.perms });
  }
  for (const seed of seeds) {
    image.functions.push(functionSeed(seed.address, {
      source: seed.source,
      confidence: 1,
      size: seed.size,
      end: seed.end,
      exactFunctionStart: seed.source === 'function_starts',
    }));
  }
  // Segments are inserted before sections on purpose: only the canonical enumeration
  // order (sections then segments, each address-sorted by finalize()) may decide a tie.
  image.finalize();
  return image;
}

function assertMatchesOracle(image, seeds) {
  const expected = oracleExtents(seeds, image.sections, image.segments);
  assert.equal(image.functions.length, expected.length, 'seed cardinality must survive finalization');
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i], got = image.functions[i];
    assert.equal(got.address, want.address, `function ${i} address order`);
    assert.equal(got.size, want.size, `function ${i} size at ${want.address}`);
    assert.equal(got.end, want.end, `function ${i} end at ${want.address}`);
    assert.equal(Boolean(got.extentInferred), want.inferred, `function ${i} inference authority at ${want.address}`);
    if (want.inferred) assert.equal(got.extentSource, 'next-function-start', `function ${i} extent source`);
  }
}

test('#8754 the narrowest containing region decides, even when a wider region spans the pair', () => {
  const seeds = [
    { address: 0x1000n, source: 'function_starts' },
    { address: 0x1008n, source: 'function_starts' },
    { address: 0x1020n, source: 'function_starts' },
    { address: 0x1ff0n, source: 'function_starts' },
  ];
  const image = imageWith({
    segments: [{ name: 'wide-text', address: 0x1000n, size: 0x2000n, perms: EXEC }],
    sections: [{ name: 'narrow', address: 0x1000n, size: 0x10n, perms: EXEC }],
    seeds,
  });
  assertMatchesOracle(image, seeds);
  // 0x1000/0x1008 share the 0x10-byte section, so that pair is bounded by it. 0x1008 and
  // 0x1020 fall in DIFFERENT canonical regions (narrow, then the covering segment), so no
  // extent may be published for 0x1008 even though a wider-first lookup would happily
  // produce 0x18; 0x1020/0x1ff0 are both segment-only and infer again.
  assert.deepEqual(
    image.functions.map((f) => [f.address, f.size, Boolean(f.extentInferred)]),
    [[0x1000n, 8n, true], [0x1008n, null, false], [0x1020n, 0xfd0n, true], [0x1ff0n, null, false]],
  );
});

test('#8754 an exact size tie keeps the earliest enumeration order', () => {
  const seeds = [
    { address: 0x100cn, source: 'function_starts' },
    { address: 0x1014n, source: 'function_starts' },
  ];
  const image = imageWith({
    sections: [
      { name: 'tie-later-start', address: 0x1008n, size: 0x10n, perms: EXEC },
      { name: 'tie-earlier-start', address: 0x1000n, size: 0x10n, perms: EXEC },
    ],
    seeds,
  });
  assertMatchesOracle(image, seeds);
  // Both regions contain 0x100c and both are 0x10 bytes, so only enumeration order can
  // pick. The earlier-start region ends at 0x1010, below the next seed, so the pair spans
  // two canonical regions and nothing may be inferred; preferring the later-start region
  // would silently publish 8n.
  assert.equal(image.functions[0].size, null);
  assert.equal(image.functions[0].extentInferred, undefined);
});

test('#8754 zero-size and non-executable regions never become a canonical region', () => {
  const seeds = [
    { address: 0x1000n, source: 'function_starts' },
    { address: 0x1004n, source: 'function_starts' },
  ];
  const emptyRegion = imageWith({
    sections: [
      { name: 'zero-fill', address: 0x1000n, size: 0n, perms: EXEC },
      { name: 'data', address: 0x1000n, size: 0x800n, perms: NON_EXEC },
    ],
    seeds,
  });
  assertMatchesOracle(emptyRegion, seeds);
  // With no executable region at all the documented escape applies: the pair is still
  // bounded by the next function start.
  assert.equal(emptyRegion.functions[0].size, 4n);
  assert.equal(emptyRegion.functions[0].extentInferred, true);

  const shadowed = imageWith({
    sections: [
      { name: 'zero-fill', address: 0x1000n, size: 0n, perms: EXEC },
      { name: 'text', address: 0x1000n, size: 0x8n, perms: EXEC },
    ],
    seeds,
  });
  assertMatchesOracle(shadowed, seeds);
});

test('#8754 region end is exclusive and the one-megabyte extent cap still applies', () => {
  const boundary = [
    { address: 0x1000n, source: 'function_starts' },
    { address: 0x1100n, source: 'function_starts' },
    { address: 0x1200n, source: 'function_starts' },
  ];
  const boundaryImage = imageWith({
    sections: [{ name: 'exact', address: 0x1000n, size: 0x100n, perms: EXEC }],
    seeds: boundary,
  });
  assertMatchesOracle(boundaryImage, boundary);
  // 0x1100 is one past the region end, so it has no canonical region: the pair
  // 0x1000/0x1100 must not borrow an extent, and neither may 0x1100/0x1200.
  assert.deepEqual(
    boundaryImage.functions.map((f) => [f.address, f.size]),
    [[0x1000n, null], [0x1100n, null], [0x1200n, null]],
  );

  const capped = [
    { address: 0n, source: 'function_starts' },
    { address: 0x1000000n, source: 'function_starts' },
    { address: 0x1000001n, source: 'function_starts' },
  ];
  const cappedImage = imageWith({
    segments: [{ name: 'huge', address: 0n, size: 0x2000000n, perms: EXEC }],
    seeds: capped,
  });
  assertMatchesOracle(cappedImage, capped);
  assert.deepEqual(
    cappedImage.functions.map((f) => [f.address, f.size]),
    [[0n, 0x1000000n], [0x1000000n, 1n], [0x1000001n, null]],
  );
});

test('#8754 declared extents and unproven sources never take the inferred path', () => {
  const mixed = [
    { address: 0x100n, source: 'heuristic' },
    { address: 0x110n, source: 'function_starts' },
    { address: 0x120n, source: 'function_starts' },
  ];
  const mixedImage = imageWith({
    segments: [{ name: 'text', address: 0x100n, size: 0x100n, perms: EXEC }],
    seeds: mixed,
  });
  assertMatchesOracle(mixedImage, mixed);
  assert.equal(mixedImage.functions[0].size, null, 'a heuristic seed may not gain a complete-looking extent');
  assert.equal(mixedImage.functions[1].size, 0x10n);

  const declared = [
    { address: 0x100n, source: 'function_starts', size: 0x4n },
    { address: 0x110n, source: 'function_starts' },
    { address: 0x120n, source: 'function_starts' },
  ];
  const declaredImage = imageWith({
    segments: [{ name: 'text', address: 0x100n, size: 0x100n, perms: EXEC }],
    seeds: declared,
  });
  assertMatchesOracle(declaredImage, declared);
  assert.deepEqual(
    declaredImage.functions.map((f) => [f.address, f.size, f.end]),
    [[0x100n, 0x4n, 0x104n], [0x110n, 0x10n, 0x120n], [0x120n, null, null]],
  );
});

test('#8754 the extent rule survives randomized nested and disjoint region topologies', () => {
  let seed = 0x8754b10;
  const random = (limit) => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % limit;
  };
  const sources = ['function_starts', 'function_starts', 'function_starts', 'symbol', 'heuristic'];
  for (let trial = 0; trial < 120; trial++) {
    const sections = [], segments = [];
    const seenByKind = new Set();
    const regionCount = random(6);
    for (let i = 0; i < regionCount; i++) {
      const address = BigInt(random(48));
      const size = BigInt(1 + random(24));
      const asSection = random(2) === 0;
      // A duplicated span within one kind would make the enumeration-order tie-break a
      // question of fixture noise rather than of the lookup; cross-kind duplicates stay,
      // because there the section must win.
      const kind = asSection ? 'section' : 'segment';
      if (seenByKind.has(`${kind}:${address}:${size}`)) continue;
      seenByKind.add(`${kind}:${address}:${size}`);
      (asSection ? sections : segments).push({ address, size, perms: random(5) === 0 ? NON_EXEC : EXEC });
    }
    const seeds = [], used = new Set();
    const seedCount = 2 + random(6);
    for (let i = 0; i < seedCount; i++) {
      const address = BigInt(random(96));
      if (used.has(address)) continue;
      used.add(address);
      seeds.push({ address, source: sources[random(sources.length)] });
    }
    if (seeds.length < 2) continue;
    const image = imageWith({ sections, segments, seeds });
    assertMatchesOracle(image, seeds);
  }
});

test('#8754 finalizing 20k seeds against 20k executable regions stays bounded', () => {
  const count = 20000;
  const image = new BinaryImage(new Uint8Array(1), { format: 'test', arch: 'x86_64', bits: 64 });
  for (let i = 0; i < count; i++) {
    image.addSection({ name: `.s${i}`, address: BigInt(i * 2), size: 1n, fileOffset: 0n, fileSize: 1n, perms: EXEC });
    image.functions.push(functionSeed(BigInt(i * 2), { source: 'function_starts', confidence: 1, exactFunctionStart: true }));
  }
  image.addSegment({ name: 'text', address: 0n, size: BigInt(count * 2 + 1), fileOffset: 0n, fileSize: 1n, perms: EXEC });
  const started = process.hrtime.bigint();
  image.finalize();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  // The reported shape cost 5,763 ms here and the monotonic sweep finishes in a couple of
  // hundred milliseconds on the audit environment, so this ceiling sits far above the
  // current cost and still well below the quadratic one. Restoring `regions.find(...)`
  // fails it.
  assert.ok(elapsedMs < 3000, `finalize of ${count} seeds over ${count + 1} regions took ${elapsedMs.toFixed(0)} ms`);
  // Every seed owns a one-byte region that the next seed has already left, so the
  // narrowest-region rule must deny the inference for the whole run: a lookup returning
  // the covering segment instead would flip all of these to inferred.
  assert.equal(image.functions.length, count);
  assert.equal(image.functions.filter((f) => f.extentInferred).length, 0);
  assert.equal(image.functions.every((f) => f.size === null), true);
});

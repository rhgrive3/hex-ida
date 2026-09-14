import assert from 'node:assert/strict';
import test from 'node:test';

import { createPointsToSet, createPointsToTarget, exactRange, pointsToDigest } from '../../../js/analysis/pointsto/lattice.js';

// #5715: createPointsToSet() sorted canonical targets with localeCompare(),
// whose collation is ICU-locale dependent. Two environments with different
// default locales could order the same semantic target set differently, so
// pointsToDigest() — the fixed-point identity — was environment-dependent.

const target = (rootEntityId) => createPointsToTarget({
  addressSpace:'memory',
  rootKind:'rooted',
  rootEntityId,
  offsetRange:exactRange(0n),
});

// 'ä' (U+00E4) vs 'z': en-US collation ranks ä < z, sv-SE ranks ä > z, so a
// locale-sensitive comparator cannot be deterministic across hosts. The
// canonical order must instead follow the locale-independent UTF-16
// code-unit order, in which 'z' (U+007A) < 'ä' (U+00E4).
test('points-to set canonical order is locale-independent UTF-16 code-unit order (#5715)', () => {
  const set = createPointsToSet({ targets:[target('ä'), target('z')] });
  assert.deepEqual(set.targets.map((t) => t.rootEntityId), ['z', 'ä'],
    'canonical order must be UTF-16 code-unit order, not ICU collation');
});

test('pointsToDigest is identical for the same set built in either insertion order (#5715)', () => {
  const forward = createPointsToSet({ targets:[target('ä'), target('z')] });
  const backward = createPointsToSet({ targets:[target('z'), target('ä')] });
  assert.equal(pointsToDigest(backward), pointsToDigest(forward));
});

test('locale changes cannot flip the canonical order or the digest (#5715)', () => {
  // Simulate collation sensitivity: ICU ranks these differently per locale,
  // while UTF-16 order is fixed. Sorting under both ICU extremes must not
  // leak into the canonical set.
  const icuVariants = [
    (a, b) => new Intl.Collator('en-US').compare(a, b),
    (a, b) => new Intl.Collator('sv-SE').compare(a, b),
  ];
  const digests = new Set();
  for (const compare of icuVariants) {
    // Pre-sort with the locale's collation and assert the canonical set
    // re-canonicalizes to the same digest regardless.
    const preSorted = ['ä', 'z'].sort(compare).map(target);
    digests.add(pointsToDigest(createPointsToSet({ targets:preSorted })));
  }
  assert.equal(digests.size, 1, 'every host collation must produce one canonical digest');
});

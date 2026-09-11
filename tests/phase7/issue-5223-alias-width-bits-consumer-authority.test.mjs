import test from 'node:test';
import assert from 'node:assert/strict';

import { a1RegionAlias } from '../../js/analysis/alias/a1-region-alias.js';
import { aliasMemoryRegions } from '../../js/analysis/alias/legacy-safety-floor.js';

// #5223: the A1/legacy alias consumer boundary must hold width authority to
// the canonical MemoryRegionRef domain. `Number(region.widthBits)` is a
// conversion API (Number(['8']) === 8, Number(true) === 1), so a lookalike
// region with a structured width could launder strong `no`/`must` relations
// out of malformed input. Only a primitive positive safe-integer width may
// prove interval separation or identity; malformed widths fail closed to the
// weak relation.

const origin = { instructionIds: ['i0'] };

function stackRegion(id, offset, widthBits) {
  return { id, kind: 'stack-fixed', functionId: 'f', offset, widthBits, origin };
}

const MALFORMED_WIDTHS = [['8'], '8', true, { bits: 8 }, 8.5, 0, -8];

test('#5223 malformed widths never mint a strong disjoint-stack-interval NoAlias', () => {
  for (const width of MALFORMED_WIDTHS) {
    const result = a1RegionAlias(stackRegion('a', '0', width), stackRegion('b', '1', width), { snapshotId: 's' });
    assert.equal(result?.relation, 'unknown',
      `width ${JSON.stringify(width)} must fail closed, got ${result?.relation}`);
    assert.ok(!result?.reasonCodes?.includes('disjoint-stack-interval'),
      `width ${JSON.stringify(width)} must not carry the interval proof`);
  }
});

test('#5223 malformed widths never mint a strong MustAlias at the same offset', () => {
  for (const width of MALFORMED_WIDTHS) {
    const result = a1RegionAlias(stackRegion('a', '0', width), stackRegion('b', '0', width), { snapshotId: 's' });
    assert.notEqual(result?.relation, 'must',
      `width ${JSON.stringify(width)} must not produce a must relation`);
  }
});

test('#5223 the legacy safety floor fails closed on malformed widths', () => {
  for (const width of MALFORMED_WIDTHS) {
    // aliasMemoryRegions() returns the relation string itself.
    const relation = aliasMemoryRegions(stackRegion('a', '0', width), stackRegion('b', '1', width), { snapshotId: 's' });
    assert.notEqual(relation, 'no',
      `legacy floor width ${JSON.stringify(width)} must not prove separation`);
    assert.notEqual(relation, 'must',
      `legacy floor width ${JSON.stringify(width)} must not prove identity`);
  }
});

test('#5223 canonical primitive widths keep the existing precision', () => {
  const separated = a1RegionAlias(stackRegion('a', '0', 8), stackRegion('b', '1', 8), { snapshotId: 's' });
  assert.equal(separated?.relation, 'no');
  assert.ok(separated?.reasonCodes?.includes('disjoint-stack-interval'));

  const same = a1RegionAlias(stackRegion('a', '0', 8), stackRegion('b', '0', 8), { snapshotId: 's' });
  assert.equal(same?.relation, 'must');

  const legacySeparated = aliasMemoryRegions(stackRegion('a', '0', 8), stackRegion('b', '1', 8), { snapshotId: 's' });
  assert.equal(legacySeparated, 'no');
});

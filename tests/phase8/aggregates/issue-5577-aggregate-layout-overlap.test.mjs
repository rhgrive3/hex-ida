/**
 * #5577 — aggregate layout must weigh every access width observed at an offset.
 *
 * `recoverAggregateLayouts()` used only the first observed access size per
 * offset (`xs[0].size`), so a later wider access at the same offset vanished
 * from the overlap predicate and a genuinely overlapping access set could be
 * published as "multiple non-overlapping fixed-offset fields". Layout
 * inference is documented as conservative; overlap must never become
 * non-overlap by first-access order.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverAggregateLayouts } from '../../../js/decompiler/types/layout.js';

const base = { id: 1 };

function layoutFor(instructions) {
  const [layout] = recoverAggregateLayouts(
    { instructions: instructions.map(([id, row, op, disp, size, key]) => ({
      id, row, op, loc: { kind: 'field', base, disp, size, key },
    })) },
    { values: new Map(), locations: new Map() },
  );
  assert.ok(layout, 'one base must produce one layout');
  return layout;
}

test('#5577: a wide access hiding behind a narrow first access is not non-overlap', () => {
  // offset 0 first size=1, then size=8 (covers bytes 0..7); offset 4 size=4.
  const layout = layoutFor([
    [1, 1, 'load', 0n, 1, 'f0'],
    [2, 2, 'load', 0n, 8, 'f0-wide'],
    [3, 3, 'load', 4n, 4, 'f4'],
  ]);
  assert.equal(layout.kind, 'object', 'overlapping accesses must not mint struct evidence');
  assert.equal(layout.confidence, 0.45);
  assert.ok(!layout.evidence.includes('multiple non-overlapping fixed-offset fields'),
    'the non-overlap claim must not appear for an overlapping access set');
  const f0 = layout.fields.find((f) => f.offset === 0n);
  assert.equal(f0.size, 8, 'field size must consider the widest observed access');
  assert.equal(f0.ambiguousWidths, true, 'mixed widths at one offset are ambiguous');
});

test('#5577: order independence — the same access set yields the same verdict', () => {
  const a = layoutFor([
    [1, 1, 'load', 0n, 1, 'f0'],
    [2, 2, 'load', 0n, 8, 'f0-wide'],
    [3, 3, 'load', 4n, 4, 'f4'],
  ]);
  const b = layoutFor([
    [3, 3, 'load', 4n, 4, 'f4'],
    [2, 2, 'load', 0n, 8, 'f0-wide'],
    [1, 1, 'load', 0n, 1, 'f0'],
  ]);
  assert.equal(a.kind, b.kind);
  assert.equal(a.fields.find((f) => f.offset === 0n).size, b.fields.find((f) => f.offset === 0n).size);
});

test('#5577: uniform width at one offset keeps the legacy inference', () => {
  const layout = layoutFor([
    [1, 1, 'load', 0n, 4, 'f0'],
    [2, 2, 'store', 4n, 4, 'f4'],
  ]);
  assert.equal(layout.kind, 'struct-or-object');
  assert.equal(layout.confidence, 0.68);
  assert.ok(layout.evidence.includes('multiple non-overlapping fixed-offset fields'));
  assert.equal(layout.fields.find((f) => f.offset === 0n).size, 4);
  assert.equal('ambiguousWidths' in layout.fields[0], false, 'unambiguous fields carry no ambiguity marker');
});

test('#5577: disjoint wide accesses remain non-overlapping', () => {
  const layout = layoutFor([
    [1, 1, 'load', 0n, 8, 'f0'],
    [2, 2, 'load', 8n, 4, 'f8'],
  ]);
  assert.equal(layout.kind, 'struct-or-object');
  assert.ok(layout.evidence.includes('multiple non-overlapping fixed-offset fields'));
});

test('#5577: store/load mixing at one offset still counts every width', () => {
  const layout = layoutFor([
    [1, 1, 'store', 0n, 2, 'f0'],
    [2, 2, 'load', 0n, 8, 'f0-wide'],
    [3, 3, 'load', 8n, 2, 'f8'],
  ]);
  assert.equal(layout.fields.find((f) => f.offset === 0n).size, 8, 'the store width and the load width both count');
  assert.equal(layout.fields.find((f) => f.offset === 0n).ambiguousWidths, true);
  assert.equal(layout.kind, 'struct-or-object', '0+8 <= 8: disjoint extents stay non-overlapping');
});

test('#5577: malformed (zero/negative) widths never mint exact layout evidence', () => {
  const layout = layoutFor([
    [1, 1, 'load', 0n, 0, 'f0-bad'],
    [2, 2, 'load', 0n, 8, 'f0'],
    [3, 3, 'load', 8n, 4, 'f8'],
  ]);
  assert.equal(layout.fields.find((f) => f.offset === 0n).size, 8, 'zero width is ignored, not trusted');
  assert.equal(layout.kind, 'struct-or-object');
});

test('#5577: a fixed-offset group with no proven width has an unknown extent, not an empty one', () => {
  // Only a malformed (zero) width at offset 0: its extent is unknown, so the
  // non-overlap proof must be withheld even though "zero width" would never
  // overlap anything.
  const layout = layoutFor([
    [1, 1, 'load', 0n, 0, 'f0-bad'],
    [2, 2, 'load', 4n, 4, 'f4'],
  ]);
  assert.equal(layout.kind, 'object', 'an unknown extent cannot support the non-overlap verdict');
  assert.equal(layout.confidence, 0.45);
  assert.ok(!layout.evidence.includes('multiple non-overlapping fixed-offset fields'),
    'no non-overlap evidence may be minted while any extent is unproven');
  assert.equal(layout.fields.find((f) => f.offset === 0n).size, 0, 'the unproven width is still reported, as unproven');
});

test('#5577: a negative-width-only group likewise withholds the non-overlap verdict', () => {
  const layout = layoutFor([
    [1, 1, 'load', 0n, -8, 'f0-bad'],
    [2, 2, 'load', 4n, 4, 'f4'],
  ]);
  assert.equal(layout.kind, 'object');
  assert.ok(!layout.evidence.includes('multiple non-overlapping fixed-offset fields'));
});

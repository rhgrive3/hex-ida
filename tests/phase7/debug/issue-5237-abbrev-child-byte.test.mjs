import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

// The abbreviation child determination encodes exactly DW_CHILDREN_no (0x00)
// or DW_CHILDREN_yes (0x01) (DWARF v5 Table 7.4). A boolean read collapses
// every other byte to DW_CHILDREN_no and lets malformed tables produce
// complete results (#5237).

const header = (body) => {
  const debug_info = Uint8Array.from([0, 0, 0, 0, 0x04, 0x00, 0, 0, 0, 0, 8, ...body]);
  new DataView(debug_info.buffer).setUint32(0, debug_info.length - 4, true);
  return debug_info;
};

const info = header([0x01]);

function probe(debug_abbrev) {
  return parseDebugInfo({ debug_info: info, debug_abbrev });
}

test('#5237: an out-of-spec child determination byte fails the unit closed', () => {
  // code=1, DW_TAG_compile_unit, children=0x02 (out of spec)
  const out = probe(Uint8Array.from([0x01, 0x11, 0x02, 0x00, 0x00, 0x00]));
  assert.equal(out.complete, false, 'a boolean read must not launder an out-of-spec byte');
  assert.ok(out.diagnostics.some((d) => d.includes('invalid child determination byte')));
  assert.equal([...out.dies.values()][0].tag, 0x11, 'the DIE facts stay available');
});

test('#5237: 0xff is equally rejected', () => {
  const out = probe(Uint8Array.from([0x01, 0x11, 0xff, 0x00, 0x00, 0x00]));
  assert.equal(out.complete, false);
  assert.ok(out.diagnostics.some((d) => d.includes('invalid child determination byte')));
});

test('#5237: both legal child determinations stay complete', () => {
  const noChildren = probe(Uint8Array.from([0x01, 0x11, 0x00, 0x00, 0x00, 0x00]));
  assert.equal(noChildren.complete, true);
  assert.deepEqual(noChildren.diagnostics, []);

  const withChildren = probe(Uint8Array.from([
    0x01, 0x11, 0x01, 0x00, 0x00,
    0x02, 0x2e, 0x00, 0x00, 0x00,
    0x00,
  ]));
  const out = parseDebugInfo({
    debug_info: header([0x01, 0x02, 0x00]),
    debug_abbrev: withChildren.debug_abbrev ?? Uint8Array.from([
      0x01, 0x11, 0x01, 0x00, 0x00,
      0x02, 0x2e, 0x00, 0x00, 0x00,
      0x00,
    ]),
  });
  assert.equal(out.complete, true);
  assert.deepEqual(out.diagnostics, []);
  assert.equal(out.dies.size, 2);
});

test('#5237: the violation is cached with the abbreviation table', () => {
  // Two units share one abbrev offset; both must observe the invalid byte.
  const twoUnits = Uint8Array.from([
    ...header([0x01]),
    ...header([0x01]),
  ]);
  const out = parseDebugInfo({ debug_info: twoUnits, debug_abbrev: Uint8Array.from([0x01, 0x11, 0x02, 0x00, 0x00, 0x00]) });
  assert.equal(out.complete, false);
  const flagged = out.diagnostics.filter((d) => d.includes('invalid child determination byte')).length;
  assert.equal(flagged, 2, 'each unit consuming the malformed table fails closed');
});

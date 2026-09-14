import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

// DWARF4 .debug_info compilation units are structurally constrained
// (DWARF4 §2.3, §7.5): the header is followed by exactly one
// DW_TAG_compile_unit / DW_TAG_partial_unit DIE, a DW_CHILDREN_yes DIE opens a
// child/sibling chain that must be closed by a null entry, and the walk must
// consume the tree the abbreviation table declared. A unit that violates any
// of these constraints is a structure the format cannot express (#5251,
// #5244): its facts may stay available, but the result must never claim
// completeness.

const uleb = (value) => {
  const out = [];
  do { let b = value & 0x7f; value >>>= 7; if (value) b |= 0x80; out.push(b); } while (value);
  return out;
};

// header: unit_length(4) + version(2) + abbrev_offset(4) + address_size(1)
const header = (body) => {
  const debug_info = Uint8Array.from([0, 0, 0, 0, 0x04, 0x00, 0, 0, 0, 0, 8, ...body]);
  new DataView(debug_info.buffer).setUint32(0, debug_info.length - 4, true);
  return debug_info;
};

function probe(debug_abbrev, debug_info) {
  return parseDebugInfo({ debug_info, debug_abbrev });
}

test('#5251: a DWARF4 unit rooted at a non-compilation DIE fails closed', () => {
  // code=1, DW_TAG_base_type, DW_CHILDREN_no
  const abbrev = Uint8Array.from([0x01, 0x24, 0x00, 0x00, 0x00, 0x00]);
  const out = probe(abbrev, header([0x01]));
  assert.equal(out.complete, false, 'a base_type root is not a compilation unit');
  assert.ok(out.diagnostics.some((d) => d.includes('does not start with a compilation or partial unit DIE')));
  assert.equal([...out.dies.values()][0].tag, 0x24, 'the DIE facts stay available');
});

test('#5251: a DWARF4 unit with multiple top-level DIEs fails closed', () => {
  // code=1: DW_TAG_compile_unit, no children; code=2: DW_TAG_subprogram, no children
  const abbrev = Uint8Array.from([
    0x01, 0x11, 0x00, 0x00, 0x00,
    0x02, 0x2e, 0x00, 0x00, 0x00,
    0x00,
  ]);
  const out = probe(abbrev, header([0x01, 0x02]));
  assert.equal(out.complete, false, 'a compilation unit has exactly one top-level DIE');
  assert.ok(out.diagnostics.some((d) => d.includes('multiple top-level DIEs')));
  assert.equal(out.dies.size, 2, 'both DIEs keep their facts');
});

test('#5251: a well-formed DWARF4 compile_unit root stays complete', () => {
  const abbrev = Uint8Array.from([0x01, 0x11, 0x00, 0x00, 0x00, 0x00]);
  const out = probe(abbrev, header([0x01]));
  assert.equal(out.complete, true);
  assert.deepEqual(out.diagnostics, []);
});

test('#5244: a DW_CHILDREN_yes root whose sibling chain lacks its terminating null fails closed', () => {
  // code=1, DW_TAG_compile_unit, DW_CHILDREN_yes; unit ends without the null entry
  const abbrev = Uint8Array.from([0x01, 0x11, 0x01, 0x00, 0x00, 0x00]);
  const out = probe(abbrev, header([0x01]));
  assert.equal(out.complete, false, 'an unterminated DIE tree is not complete evidence');
  assert.ok(out.diagnostics.some((d) => d.includes('unterminated DIE tree')));
  assert.equal(out.dies.size, 1, 'the root DIE facts stay available');
});

test('#5244: a properly terminated child chain stays complete', () => {
  // code=1: compile_unit with children; code=2: subprogram, no children
  const abbrev = Uint8Array.from([
    0x01, 0x11, 0x01, 0x00, 0x00,
    0x02, 0x2e, 0x00, 0x00, 0x00,
    0x00,
  ]);
  const out = probe(abbrev, header([0x01, 0x02, 0x00]));
  assert.equal(out.complete, true);
  assert.deepEqual(out.diagnostics, []);
});

test('#5244: an unmatched null DIE entry fails closed instead of being a no-op', () => {
  // code=1: compile_unit, no children — then a null entry nobody declared
  const abbrev = Uint8Array.from([0x01, 0x11, 0x00, 0x00, 0x00, 0x00]);
  const out = probe(abbrev, header([0x01, 0x00]));
  assert.equal(out.complete, false, 'a null entry with no open sibling chain is structure nobody declared');
  assert.ok(out.diagnostics.some((d) => d.includes('unmatched null DIE entry')));
});

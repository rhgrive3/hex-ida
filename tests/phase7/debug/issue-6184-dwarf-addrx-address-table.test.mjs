import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDebugInfo, DwarfDebugInfoProvider } from '../../../js/analysis/debug/dwarf.js';

// DW_FORM_addrx* holds a zero-based index into the unit's .debug_addr entry
// array (DWARF5 §7.26), relative to DW_AT_addr_base. A raw index must never
// be published as a PC: unresolved indices fail the DIE/result closed
// (#6184).

function uleb(value) {
  const out = [];
  do { let b = value & 0x7f; value >>>= 7; if (value) b |= 0x80; out.push(b); } while (value);
  return out;
}
const str = (s) => [...new TextEncoder().encode(s), 0];
const addr = (v) => { const out = []; for (let i = 0; i < 8; i++) out.push(Number((v >> BigInt(i * 8)) & 0xffn)); return out; };

const abbrev = Uint8Array.from([
  // 1: subprogram: name/string, low_pc/addrx1
  ...uleb(1), 0x2e, 0x00,
    ...uleb(0x03), ...uleb(0x08),   // DW_AT_name, DW_FORM_string
    ...uleb(0x11), ...uleb(0x29),   // DW_AT_low_pc, DW_FORM_addrx1
    0x00, 0x00,
  // 2: compile unit: name/string, addr_base/sec_offset
  ...uleb(2), 0x11, 0x01,
    ...uleb(0x03), ...uleb(0x08),   // DW_AT_name, DW_FORM_string
    ...uleb(0x73), ...uleb(0x17),   // DW_AT_addr_base, DW_FORM_sec_offset
    0x00, 0x00,
  0x00,
]);

function buildDebugInfo({ addrxIndex, addrBase }) {
  // DIE order: CU first (declares addr_base), then the subprogram.
  const cu = [...uleb(2), ...str('cu.c'), ...addr(BigInt(addrBase))];
  const sub = [...uleb(1), ...str('fn'), addrxIndex];
  const body = [...cu, ...sub];
  // DWARF5 compile-unit header: length(4) version(2) unit_type(1)
  // address_size(1) abbrev_offset(4).
  const debug_info = Uint8Array.from([0, 0, 0, 0, 0x05, 0x00, 0x01, 0x08, 0, 0, 0, 0, ...body]);
  new DataView(debug_info.buffer).setUint32(0, debug_info.length - 4, true);
  return debug_info;
}

// .debug_addr: unit_length(4) version(2) address_size(1) segment_size(1)
// then 8-byte entries. addr_base = 8 (first entry).
const debug_addr = Uint8Array.from([
  0x14, 0, 0, 0,        // unit_length 20
  0x05, 0x00,           // version 5
  0x08,                 // address_size
  0x00,                 // segment_selector_size
  ...addr(0x12345678n), // entry 0
  ...addr(0x4000n),     // entry 1
]);

function sectionsFor(debug_info, { addrBase, withAddr = true, table = debug_addr } = {}) {
  const sections = { debug_info, debug_abbrev: abbrev };
  if (withAddr) sections.debug_addr = table;
  return sections;
}

test('#6184: addrx indices resolve through .debug_addr to the real address', () => {
  const out = parseDebugInfo(sectionsFor(buildDebugInfo({ addrxIndex: 1, addrBase: 8 })));
  assert.equal(out.complete, true);
  const sub = [...out.dies.values()].find((d) => d.tag === 0x2e);
  assert.equal(sub?.attributes.get(0x11)?.value, 0x4000n, 'the entry array address wins over the raw index');
});

test('#6184: a missing .debug_addr leaves the DIE incomplete and never mints an address', () => {
  const out = parseDebugInfo(sectionsFor(buildDebugInfo({ addrxIndex: 0, addrBase: 8 }), { withAddr: false }));
  assert.equal(out.complete, false);
  assert.ok(out.diagnostics.some((d) => d.includes('addrx')), JSON.stringify(out.diagnostics));
  const sub = [...out.dies.values()].find((d) => d.tag === 0x2e);
  assert.equal(sub?.complete, false);
  assert.equal(sub?.attributes.get(0x11)?.value, null, 'the raw index must not become an address');
});

test('#6184: an out-of-range index fails closed without publishing the index', () => {
  const out = parseDebugInfo(sectionsFor(buildDebugInfo({ addrxIndex: 9, addrBase: 8 })));
  assert.equal(out.complete, false);
  const sub = [...out.dies.values()].find((d) => d.tag === 0x2e);
  assert.equal(sub?.attributes.get(0x11)?.value, null);
  assert.equal(sub?.complete, false);
});

test('#6184: a unit without DW_AT_addr_base cannot resolve addrx indices', () => {
  const out = parseDebugInfo(sectionsFor(buildDebugInfo({ addrxIndex: 0, addrBase: 0 })));
  assert.equal(out.complete, false);
  const sub = [...out.dies.values()].find((d) => d.tag === 0x2e);
  assert.equal(sub?.attributes.get(0x11)?.value, null);
});

test('#6184: the provider does not publish addresses from unresolved addrx DIEs', () => {
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe({
    snapshotId: 'snap-6184',
    identity: {},
    debugSections: sectionsFor(buildDebugInfo({ addrxIndex: 0, addrBase: 8 }), { withAddr: false }),
  });
  const symbols = provider.symbols(result).records;
  for (const record of symbols) {
    assert.equal(record.address, null, 'an unresolved addrx index never becomes a PC');
  }
});

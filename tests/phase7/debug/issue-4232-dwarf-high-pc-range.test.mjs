import assert from 'node:assert/strict';
import test from 'node:test';

import { DwarfDebugInfoProvider } from '../../../js/analysis/debug/dwarf.js';

function uleb(value) {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

function cstr(value) {
  return [...new TextEncoder().encode(value), 0];
}

function addr64(value) {
  const out = [];
  for (let i = 0; i < 8; i += 1) out.push(Number((BigInt(value) >> BigInt(i * 8)) & 0xffn));
  return out;
}

const debug_abbrev = Uint8Array.from([
  // code 1: DW_TAG_compile_unit, children=yes, no attributes.
  ...uleb(1), 0x11, 0x01, 0x00, 0x00,
  // code 2: DW_TAG_subprogram, name/string, low_pc/addr, high_pc/addr.
  ...uleb(2), 0x2e, 0x00,
  0x03, 0x08,
  0x11, 0x01,
  0x12, 0x01,
  0x00, 0x00,
  0x00,
]);

function imageWithRanges(ranges) {
  const body = [
    0x04, 0x00,       // DWARF4
    0, 0, 0, 0,       // abbrev offset
    0x08,             // address size
    ...uleb(1),       // compile_unit root
  ];
  for (const { name, low, high } of ranges) {
    body.push(...uleb(2), ...cstr(name), ...addr64(low), ...addr64(high));
  }
  body.push(0x00);     // close compile_unit child chain
  const debug_info = Uint8Array.from([0, 0, 0, 0, ...body]);
  new DataView(debug_info.buffer).setUint32(0, body.length, true);
  return {
    snapshotId: 'snap-4232',
    identity: {},
    debugSections: { '.debug_info': debug_info, '.debug_abbrev': debug_abbrev },
  };
}

function probe(ranges) {
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe(imageWithRanges(ranges));
  return { provider, result };
}

test('#4232: absolute high_pc below low_pc fails closed instead of throwing during symbols()', () => {
  const { provider, result } = probe([{ name: 'bad', low: 0x2000n, high: 0x1000n }]);
  assert.equal(result.status.completeness, 'partial');
  assert.ok(result.diagnostics.some((entry) => entry.includes('DW_AT_high_pc')));

  const page = provider.symbols(result, {});
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].name, 'bad');
  assert.equal(page.records[0].address, '0x2000');
  assert.equal(page.records[0].sizeBytes, null);
  assert.equal(page.records[0].descriptor.complete, false);
});

test('#4232: zero and increasing absolute ranges keep their exact extents', () => {
  const { provider, result } = probe([
    { name: 'zero', low: 0x1000n, high: 0x1000n },
    { name: 'good', low: 0x2000n, high: 0x2020n },
  ]);
  assert.equal(result.status.completeness, 'complete');
  const byName = new Map(provider.symbols(result, {}).records.map((record) => [record.name, record]));
  assert.equal(byName.get('zero').sizeBytes, 0);
  assert.equal(byName.get('good').sizeBytes, 0x20);
  assert.equal(byName.get('zero').descriptor.complete, true);
  assert.equal(byName.get('good').descriptor.complete, true);
});

test('#4232: one malformed range does not prevent later valid symbols from being paged', () => {
  const { provider, result } = probe([
    { name: 'bad', low: 0x3000n, high: 0x2000n },
    { name: 'later', low: 0x4000n, high: 0x4010n },
  ]);
  const first = provider.symbols(result, { pageSize: 1 });
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].sizeBytes, null);
  assert.equal(first.records[0].descriptor.complete, false);
  assert.notEqual(first.nextCursor, null);

  const second = provider.symbols(result, { cursor: first.nextCursor, pageSize: 1 });
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].name, 'later');
  assert.equal(second.records[0].sizeBytes, 0x10);
  assert.equal(second.records[0].descriptor.complete, true);
});

test('#4232: an absolute range larger than the exact size domain also stays non-throwing', () => {
  const { provider, result } = probe([{ name: 'huge', low: 0n, high: 0x20000000000000n }]);
  assert.equal(result.status.completeness, 'partial');
  assert.ok(result.diagnostics.some((entry) => entry.includes('exact size bounds')));
  const [record] = provider.symbols(result, {}).records;
  assert.equal(record.sizeBytes, null);
  assert.equal(record.descriptor.complete, false);
});

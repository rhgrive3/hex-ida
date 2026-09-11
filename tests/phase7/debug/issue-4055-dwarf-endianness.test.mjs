import assert from 'node:assert/strict';
import test from 'node:test';

import { DwarfDebugInfoProvider, parseDebugInfo, readBuildId, readDebugLink } from '../../../js/analysis/debug/dwarf.js';

const DW_AT_LANGUAGE = 0x13;
const DW_AT_NAME = 0x03;

function fixed(value, width, endian) {
  const bytes = new Uint8Array(width);
  const view = new DataView(bytes.buffer);
  const little = endian === 'little';
  if (width === 2) view.setUint16(0, Number(value), little);
  else if (width === 4) view.setUint32(0, Number(value), little);
  else if (width === 8) view.setBigUint64(0, BigInt(value), little);
  else throw new Error(`unsupported width ${width}`);
  return [...bytes];
}

function dwarf32(endian, { value = 0x1234 } = {}) {
  // abbrev 1: DW_TAG_compile_unit, no children, DW_AT_language / DW_FORM_data2.
  const debug_abbrev = Uint8Array.from([1, 0x11, 0, DW_AT_LANGUAGE, 0x05, 0, 0, 0]);
  const body = [
    ...fixed(4, 2, endian),
    ...fixed(0, 4, endian),
    8,
    1,
    ...fixed(value, 2, endian),
  ];
  return { debug_info: Uint8Array.from([...fixed(body.length, 4, endian), ...body]), debug_abbrev };
}

function dwarf64(endian, { value = 0x0102030405060708n } = {}) {
  // abbrev 1: DW_TAG_compile_unit, no children, DW_AT_language / DW_FORM_data8.
  const debug_abbrev = Uint8Array.from([1, 0x11, 0, DW_AT_LANGUAGE, 0x07, 0, 0, 0]);
  const body = [
    ...fixed(4, 2, endian),
    ...fixed(0, 8, endian),
    8,
    1,
    ...fixed(value, 8, endian),
  ];
  const debug_info = Uint8Array.from([
    ...fixed(0xffffffff, 4, endian),
    ...fixed(body.length, 8, endian),
    ...body,
  ]);
  return { debug_info, debug_abbrev };
}

function dwarf5Strx(endian) {
  // abbrev 1: compile_unit, no children, str_offsets_base/sec_offset + name/strx1.
  const debug_abbrev = Uint8Array.from([
    1, 0x11, 0,
    0x72, 0x17,
    DW_AT_NAME, 0x25,
    0, 0,
    0,
  ]);
  const body = [
    ...fixed(5, 2, endian),
    1, // DW_UT_compile
    8,
    ...fixed(0, 4, endian),
    1,
    ...fixed(0, 4, endian), // DW_AT_str_offsets_base
    0, // strx1 index 0
  ];
  return {
    debug_info: Uint8Array.from([...fixed(body.length, 4, endian), ...body]),
    debug_abbrev,
    debug_str_offsets: Uint8Array.from(fixed(0, 4, endian)),
    debug_str: new TextEncoder().encode('be-name\0'),
  };
}

function dwarf5Addrx(endian, address = 0x0102030405060708n) {
  // compile_unit with DW_AT_addr_base/sec_offset and DW_AT_low_pc/addrx1.
  const debug_abbrev = Uint8Array.from([
    1, 0x11, 0,
    0x73, 0x17,
    0x11, 0x29,
    0, 0,
    0,
  ]);
  const body = [
    ...fixed(5, 2, endian),
    1,
    8,
    ...fixed(0, 4, endian),
    1,
    ...fixed(8, 4, endian),
    0,
  ];
  const debug_addr = Uint8Array.from([
    ...fixed(12, 4, endian), // version/address-size header (4) + one 8-byte address
    ...fixed(5, 2, endian),
    8,
    0,
    ...fixed(address, 8, endian),
  ]);
  return {
    debug_info: Uint8Array.from([...fixed(body.length, 4, endian), ...body]),
    debug_abbrev,
    debug_addr,
  };
}

function buildIdNote(endian, descriptor = [0xde, 0xad, 0xbe, 0xef]) {
  return Uint8Array.from([
    ...fixed(4, 4, endian),
    ...fixed(descriptor.length, 4, endian),
    ...fixed(3, 4, endian),
    0x47, 0x4e, 0x55, 0,
    ...descriptor,
    ...new Array((4 - (descriptor.length & 3)) & 3).fill(0),
  ]);
}


function debugLink(endian, crc32 = 0x01020304) {
  const name = [...new TextEncoder().encode('fixture.debug'), 0];
  while ((name.length & 3) !== 0) name.push(0);
  return Uint8Array.from([...name, ...fixed(crc32, 4, endian)]);
}

function onlyDie(parsed) {
  assert.equal(parsed.dies.size, 1);
  return [...parsed.dies.values()][0];
}

test('#4055: DWARF32 fixed-width reads obey little and big object byte order', () => {
  for (const endian of ['little', 'big']) {
    const parsed = parseDebugInfo(dwarf32(endian), undefined, { endian });
    assert.equal(parsed.complete, true, `${endian}: ${parsed.diagnostics.join('; ')}`);
    assert.equal(parsed.units[0].version, 4);
    assert.equal(parsed.units[0].addressSize, 8);
    assert.equal(onlyDie(parsed).attributes.get(DW_AT_LANGUAGE).value, 0x1234n);
  }
});

test('#4055: DWARF64 big-endian unit length, abbrev offset and data8 remain synchronized', () => {
  const value = 0x0102030405060708n;
  const parsed = parseDebugInfo(dwarf64('big', { value }), undefined, { endian: 'big' });
  assert.equal(parsed.complete, true, parsed.diagnostics.join('; '));
  assert.equal(parsed.units[0].offsetSize, 8);
  assert.equal(onlyDie(parsed).attributes.get(DW_AT_LANGUAGE).value, value);
});

test('#4055: big-endian .debug_str_offsets resolves the same semantic string', () => {
  const parsed = parseDebugInfo(dwarf5Strx('big'), undefined, { endian: 'big' });
  assert.equal(parsed.complete, true, parsed.diagnostics.join('; '));
  assert.equal(onlyDie(parsed).attributes.get(DW_AT_NAME).value, 'be-name');
});

test('#4055: big-endian .debug_addr contribution headers and addrx entries use object byte order', () => {
  const address = 0x0102030405060708n;
  const parsed = parseDebugInfo(dwarf5Addrx('big', address), undefined, { endian: 'big' });
  assert.equal(parsed.complete, true, parsed.diagnostics.join('; '));
  assert.equal(onlyDie(parsed).attributes.get(0x11).value, address);
});

test('#4055: GNU build-id note headers obey ELF byte order', () => {
  const expected = 'deadbeef';
  assert.equal(readBuildId(buildIdNote('little'), { endian: 'little' }), expected);
  assert.equal(readBuildId(buildIdNote('big'), { endian: 'big' }), expected);
  assert.equal(readBuildId(buildIdNote('big'), { endian: 'little' }), null);
});

test('#4055: .gnu_debuglink CRC follows object byte order without changing filename parsing', () => {
  const expected = { name: 'fixture.debug', crc32: 0x01020304 };
  assert.deepEqual(readDebugLink(debugLink('little'), { endian: 'little' }), expected);
  assert.deepEqual(readDebugLink(debugLink('big'), { endian: 'big' }), expected);
  assert.notDeepEqual(readDebugLink(debugLink('big'), { endian: 'little' }), expected);
});

test('#4055: provider binds big-endian debug evidence to matching build identity', () => {
  const provider = new DwarfDebugInfoProvider();
  const debugSections = { ...dwarf32('big'), '.note.gnu.build-id': buildIdNote('big') };
  const matched = provider.probe({ endian: 'big', identity: { buildId: 'deadbeef' }, debugSections, snapshotId: 'be' });
  assert.equal(matched.identity.verdict, 'matched-authoritative');
  assert.equal(matched.identity.observed, 'deadbeef');
  assert.equal(matched.counts.dies, 1);
  assert.equal(matched.parsed.complete, true);

  const mismatched = provider.probe({ endian: 'big', identity: { buildId: '00000000' }, debugSections, snapshotId: 'be' });
  assert.equal(mismatched.identity.verdict, 'identity-mismatch');
});

test('#4055: explicit unknown or invalid byte order fails closed without parsing fixed-width evidence', () => {
  const provider = new DwarfDebugInfoProvider();
  const debugSections = { ...dwarf32('little'), '.note.gnu.build-id': buildIdNote('little') };
  for (const endian of ['unknown', 'middle']) {
    const image = { endian, identity: { buildId: 'deadbeef' }, debugSections, snapshotId: 'unknown' };
    const result = provider.probe(image);
    assert.equal(result.identity.verdict, 'identity-unavailable');
    assert.equal(result.identity.method, 'byte-order-unavailable');
    assert.equal(result.counts.dies, 0);
    assert.equal(result.parsed.complete, false);
    assert.ok(result.diagnostics.includes('debug image byte order unavailable'));
  }
});

test('#4055: truncated big-endian CU remains incomplete and fabricates no DIE', () => {
  const sections = dwarf32('big');
  sections.debug_info = sections.debug_info.subarray(0, 8);
  const parsed = parseDebugInfo(sections, undefined, { endian: 'big' });
  assert.equal(parsed.complete, false);
  assert.equal(parsed.dies.size, 0);
});

import assert from 'node:assert/strict';
import { parseDex, probeDex } from '../../../js/managed/dex/parser.js';
import { parseDex as parseDexCore } from '../../../js/managed/dex/parser-core.js';
import { validateDexMap } from '../../../js/managed/dex/map-validation.js';

console.log('[phase11] running dex parser tests...');

const MAP_OFF = 0x178;
const MAP_ITEMS = [
  [0x0000, 1, 0x000], [0x0001, 3, 0x070], [0x0002, 2, 0x080],
  [0x0003, 1, 0x090], [0x0005, 1, 0x0a0], [0x0006, 1, 0x0b0],
  [0x2002, 3, 0x100], [0x2000, 1, 0x120], [0x2001, 1, 0x140],
  [0x1000, 1, MAP_OFF],
];

function writeMap(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(MAP_OFF, MAP_ITEMS.length, true);
  MAP_ITEMS.forEach(([type, size, offset], index) => {
    const pos = MAP_OFF + 4 + index * 12;
    view.setUint16(pos, type, true);
    view.setUint16(pos + 2, 0, true);
    view.setUint32(pos + 4, size, true);
    view.setUint32(pos + 8, offset, true);
  });
}

export function buildMinimalDex() {
  const buf = new Uint8Array(0x200);
  const view = new DataView(buf.buffer);
  buf.set([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00], 0);
  view.setUint32(32, 0x200, true);
  view.setUint32(36, 0x70, true);
  view.setUint32(40, 0x12345678, true);
  view.setUint32(52, MAP_OFF, true);
  view.setUint32(104, 0x100, true);
  view.setUint32(108, 0x100, true);
  view.setUint32(56, 3, true); view.setUint32(60, 0x70, true);
  view.setUint32(64, 2, true); view.setUint32(68, 0x80, true);
  view.setUint32(72, 1, true); view.setUint32(76, 0x90, true);
  view.setUint32(88, 1, true); view.setUint32(92, 0xa0, true);
  view.setUint32(96, 1, true); view.setUint32(100, 0xb0, true);
  view.setUint32(0x70, 0x100, true); view.setUint32(0x74, 0x104, true); view.setUint32(0x78, 0x110, true);
  view.setUint32(0x80, 0, true); view.setUint32(0x84, 1, true);
  view.setUint32(0x90, 0, true); view.setUint32(0x94, 0, true); view.setUint32(0x98, 0, true);
  view.setUint16(0xa0, 1, true); view.setUint16(0xa2, 0, true); view.setUint32(0xa4, 2, true);
  view.setUint32(0xb0, 1, true); view.setUint32(0xb4, 1, true); view.setUint32(0xb8, 0xffffffff, true);
  view.setUint32(0xbc, 0, true); view.setUint32(0xc0, 0xffffffff, true); view.setUint32(0xc4, 0, true); view.setUint32(0xc8, 0x120, true);
  buf.set([1, 0x56, 0], 0x100);
  buf.set([6, 0x4c, 0x54, 0x65, 0x73, 0x74, 0x3b, 0], 0x104);
  buf.set([3, 0x66, 0x6f, 0x6f, 0], 0x110);
  buf.set([0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0xc0, 0x02], 0x120);
  view.setUint16(0x140, 2, true); view.setUint16(0x142, 1, true); view.setUint16(0x144, 0, true); view.setUint16(0x146, 0, true);
  view.setUint32(0x148, 0, true); view.setUint32(0x14c, 2, true);
  buf.set([0x12, 0x10, 0x0e, 0x00], 0x150);
  writeMap(buf);
  return buf;
}

function expectTypeError(bytes, code, parser = parseDex) {
  assert.throws(() => parser(bytes), (error) => error instanceof TypeError && error.message === code);
}

const dexBytes = buildMinimalDex();
const probe = probeDex(dexBytes);
assert.equal(probe.supported, true);
assert.equal(probe.formatVersion, 'dex-035');
const parsed = parseDex(dexBytes);
assert.equal(parsed.strings.length, 3);
assert.equal(parsed.strings[1], 'LTest;');
assert.equal(parsed.strings[2], 'foo');
assert.equal(parsed.classes.length, 1);
assert.equal(parsed.classes[0].classType, 'LTest;');
assert.equal(parsed.classes[0].directMethods.length, 1);
assert.equal(parsed.classes[0].directMethods[0].codeOff, 0x140);

{
  const bytes = buildMinimalDex(); new DataView(bytes.buffer).setUint32(52, 0, true);
  expectTypeError(bytes, 'dex-invalid-map-offset');
  expectTypeError(bytes, 'dex-invalid-map-offset', parseDexCore);
}
{
  const bytes = buildMinimalDex(); new DataView(bytes.buffer).setUint32(52, bytes.length, true);
  expectTypeError(bytes, 'dex-invalid-map-offset');
}
{
  const bytes = buildMinimalDex(); const view = new DataView(bytes.buffer);
  view.setUint32(52, 0x1fc, true); view.setUint32(0x1fc, 1, true);
  expectTypeError(bytes, 'dex-truncated-map-list');
}
{
  const bytes = buildMinimalDex(); const view = new DataView(bytes.buffer);
  // mapOff remains inside data, but the complete map_list extends past dataEnd.
  view.setUint32(104, 0x90, true); // data=[0x100,0x190), map=[0x178,0x1f4)
  expectTypeError(bytes, 'dex-map-item-outside-data');
}
{
  const bytes = buildMinimalDex(); const view = new DataView(bytes.buffer); const last = MAP_OFF + 4 + 9 * 12;
  view.setUint16(last, 0x2001, true);
  expectTypeError(bytes, 'dex-duplicate-map-item-type');
}
{
  const bytes = buildMinimalDex(); const view = new DataView(bytes.buffer); const last = MAP_OFF + 4 + 9 * 12;
  view.setUint32(last + 8, 0x130, true);
  expectTypeError(bytes, 'dex-map-items-out-of-order');
}
{
  const bytes = buildMinimalDex(); const view = new DataView(bytes.buffer); const typeIds = MAP_OFF + 4 + 2 * 12;
  view.setUint32(typeIds + 8, 0x78, true);
  expectTypeError(bytes, 'dex-overlapping-map-items');
}
{
  const bytes = buildMinimalDex(); const view = new DataView(bytes.buffer); const methodIds = MAP_OFF + 4 + 4 * 12;
  view.setUint32(methodIds + 4, 2, true);
  expectTypeError(bytes, 'dex-map-header-mismatch');
}
{
  const bytes = buildMinimalDex(); const view = new DataView(bytes.buffer); const stringData = MAP_OFF + 4 + 6 * 12;
  view.setUint16(stringData, 0x7777, true);
  expectTypeError(bytes, 'dex-unsupported-map-item-type');
}
{
  const bytes = buildMinimalDex(); const view = new DataView(bytes.buffer); const stringData = MAP_OFF + 4 + 6 * 12;
  // hiddenapi_class_data_item is not structurally validated here, so fail closed as unsupported.
  view.setUint16(stringData, 0xf000, true);
  expectTypeError(bytes, 'dex-unsupported-map-item-type');
}
for (const type of [0x1002, 0x1003]) {
  const bytes = buildMinimalDex(); const view = new DataView(bytes.buffer); const item = MAP_OFF + 4 + 6 * 12;
  view.setUint16(item, type, true);
  view.setUint32(item + 8, 0x101, true);
  expectTypeError(bytes, 'dex-invalid-map-item-alignment');
}
{
  const bytes = new Uint8Array(0x70);
  expectTypeError(bytes, 'dex-unsupported-binary');
}
{
  const bytes = buildMinimalDex(); const view = new DataView(bytes.buffer);
  bytes.set([0x30, 0x34, 0x31], 4);
  view.setUint32(52, 0, true);
  expectTypeError(bytes, 'dex-unsupported-binary');
}
{
  const bytes = buildMinimalDex(); const view = new DataView(bytes.buffer);
  view.setUint32(40, 0x78563412, true);
  view.setUint32(52, 0, true);
  expectTypeError(bytes, 'dex-reverse-endian-unsupported');
}

function buildVariableMapDex(type, payload) {
  const bytes = new Uint8Array(0x180);
  const view = new DataView(bytes.buffer);
  bytes.set([0x64,0x65,0x78,0x0a,0x30,0x33,0x35,0x00], 0);
  view.setUint32(32, bytes.length, true);
  view.setUint32(36, 0x70, true);
  view.setUint32(40, 0x12345678, true);
  view.setUint32(52, 0x100, true);
  view.setUint32(104, bytes.length - 0x70, true);
  view.setUint32(108, 0x70, true);
  bytes.set(payload, 0x70);
  view.setUint32(0x100, 3, true);
  for (const [i, itemType, size, offset] of [[0,0x0000,1,0],[1,type,1,0x70],[2,0x1000,1,0x100]]) {
    const pos = 0x104 + i * 12;
    view.setUint16(pos, itemType, true); view.setUint16(pos + 2, 0, true);
    view.setUint32(pos + 4, size, true); view.setUint32(pos + 8, offset, true);
  }
  return bytes;
}

for (const [type, payload] of [
  [0x1001, [0,0,0,0]],
  [0x1002, [0,0,0,0]],
  [0x1003, [0,0,0,0]],
  [0x2000, [0,0,0,0]],
  [0x2001, new Array(16).fill(0)],
  [0x2002, [0,0]],
  [0x2003, [0,0,0]],
  [0x2004, [0,0,0]],
  [0x2005, [0]],
  [0x2006, new Array(16).fill(0)],
]) {
  const bytes = buildVariableMapDex(type, payload);
  assert.equal(validateDexMap(bytes), true, `variable map type 0x${type.toString(16)}`);
  assert.doesNotThrow(() => parseDex(bytes), `public parse variable map type 0x${type.toString(16)}`);
}

{
  const bytes = buildVariableMapDex(0x1001, [0,0,0,0]);
  const view = new DataView(bytes.buffer);
  view.setUint32(0x70, 0x1000, true); // type_list element count escapes into the next map section
  assert.throws(() => validateDexMap(bytes), /dex-invalid-map-item-range/);
  expectTypeError(bytes, 'dex-invalid-map-item-range');
}

console.log('  ok dex parser tests passed');

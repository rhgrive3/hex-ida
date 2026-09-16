import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildMinimalDex } from './dex-parser.test.mjs';

console.log('[phase11] running DEX class_data field-index regression #3729...');

function buildFieldDex(fieldCount, classData) {
  const bytes = buildMinimalDex();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  view.setUint32(80, fieldCount, true);
  view.setUint32(84, 0xd0, true);
  // field_ids must stay in canonical (class, name, type) order. When
  // fieldCount > 1 a 4th string "bar" is added below and the string table is
  // re-sorted canonically ("bar"=2, "foo"=3), so name tuples strictly
  // increase across the two fields.
  for (let i = 0; i < fieldCount; i++) {
    const off = 0xd0 + i * 8;
    view.setUint16(off, 0, true);     // classIdx = 0 -> LTest; (field owner)
    view.setUint16(off + 2, 1, true); // typeIdx = 1 -> V
    // Canonical (class, name, type) tuple order needs ascending nameIdx:
    // field 0 -> "bar" (2), field 1 -> "foo" (3) once the 4th string exists.
    view.setUint32(off + 4, i === 0 ? 2 : 3, true);
  }
  if (fieldCount > 1) {
    // Append a 4th string "bar" and re-sort the table into canonical UTF-16
    // content order: "LTest;" < "V" < "bar" (0x62…) < "foo" (0x66…).
    // "foo" occupies 0x10b..0x10f (5 bytes), so "bar" data starts at 0x110.
    view.setUint32(56, 4, true);       // strings_size = 4
    view.setUint32(0x78, 0x110, true); // string_id[2] -> "bar" (canonical slot 2)
    view.setUint32(0x7c, 0x10b, true); // string_id[3] -> "foo" (canonical slot 3)
    bytes.set([3, 0x62, 0x61, 0x72, 0], 0x110); // "bar" (MUTF-8)
  }

  bytes.fill(0, 0x120, 0x140);
  bytes.set(classData, 0x120);

  const mapOff = view.getUint32(52, true);
  const mapItems = [
    [0x0000, 1, 0x000], [0x0001, fieldCount > 1 ? 4 : 3, 0x070], [0x0002, 2, 0x080],
    [0x0003, 1, 0x090], [0x0005, 1, 0x0a0], [0x0006, 1, 0x0b0],
    [0x0004, fieldCount, 0x0d0], [0x2002, 3, 0x100], [0x2000, 1, 0x120],
    [0x2001, 1, 0x140], [0x1000, 1, mapOff],
  ];
  view.setUint32(mapOff, mapItems.length, true);
  for (let i = 0; i < mapItems.length; i++) {
    const [type, size, offset] = mapItems[i];
    const pos = mapOff + 4 + i * 12;
    view.setUint16(pos, type, true);
    view.setUint16(pos + 2, 0, true);
    view.setUint32(pos + 4, size, true);
    view.setUint32(pos + 8, offset, true);
  }
  return bytes;
}

function rejects(fieldCount, classData) {
  assert.throws(
    () => parseDex(buildFieldDex(fieldCount, classData)),
    /dex-invalid-class-data-field-index/,
  );
}

rejects(1, [0x01, 0x00, 0x00, 0x00, 0x02, 0x01]);
rejects(1, [0x00, 0x01, 0x00, 0x00, 0x02, 0x01]);
assert.doesNotThrow(() =>
  parseDex(buildFieldDex(2, [0x02, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01])),
);
rejects(2, [0x02, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01]);
assert.doesNotThrow(() =>
  parseDex(buildFieldDex(2, [0x01, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01])),
);

console.log('  ok DEX class_data field-index regression #3729 passed');

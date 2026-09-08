import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildMinimalDex } from './dex-parser.test.mjs';

// #7436 — AOSP dex-format: class_def_item.class_idx must resolve to a
// non-array class type ('L...;'). Primitives and arrays are valid type_ids
// but can never be a class_def's defining type.

function withDescriptor(stringIndex, descriptor) {
  const bytes = buildMinimalDex();
  const encoded = [...Buffer.from(descriptor, 'utf8')];
  const dataOffset = bytes[0x70 + stringIndex * 4] | (bytes[0x71 + stringIndex * 4] << 8)
    | (bytes[0x72 + stringIndex * 4] << 16) | (bytes[0x73 + stringIndex * 4] << 24);
  bytes[dataOffset] = encoded.length;
  bytes.set(encoded, dataOffset + 1);
  bytes[dataOffset + 1 + encoded.length] = 0;
  return bytes;
}

// Control: buildMinimalDex defines class_idx=1 over string[1]; the class
// descriptor keeps parsing.
const control = parseDex(buildMinimalDex());
assert.equal(control.classes[0].classType, 'LTest;');

// A primitive definer ('I') is JVM-DEX-invalid and must fail closed.
assert.throws(() => parseDex(withDescriptor(1, 'I')), /dex-invalid-class-def-type/);
// Void and array descriptors are equally invalid definers.
assert.throws(() => parseDex(withDescriptor(1, 'V')), /dex-invalid-class-def-type/);
assert.throws(() => parseDex(withDescriptor(1, '[I')), /dex-invalid-class-def-type/);

// The same role-specific invariant covers non-NO_INDEX superclass_idx:
// append a fourth string (a primitive descriptor) plus a third type_id and
// point superclass_idx at it, leaving the definer a valid class type.
function withSuperclassDescriptor(descriptor) {
  const bytes = buildMinimalDex();
  const view = new DataView(bytes.buffer);
  // string_data item 3 lives at 0x116 (inside the string_data map section,
  // which ends at 0x120): uleb length + descriptor + NUL.
  const encoded = [...Buffer.from(descriptor, 'utf8')];
  bytes[0x116] = encoded.length;
  bytes.set(encoded, 0x117);
  bytes[0x117 + encoded.length] = 0;
  // string_ids: append entry 3 -> 0x116 (header size 3 -> 4).
  view.setUint32(0x7c, 0x116, true);
  view.setUint32(56, 4, true);
  // type_ids: append entry 2 -> string 3 (header size 2 -> 3).
  view.setUint32(0x88, 3, true);
  view.setUint32(64, 3, true);
  // map: string_id_items size 3 -> 4, type_id_items size 2 -> 3.
  const mapItem = (index) => 0x178 + 4 + index * 12;
  view.setUint32(mapItem(1) + 4, 4, true);
  view.setUint32(mapItem(2) + 4, 3, true);
  // class_def superclass_idx = 2 (the appended primitive/array type).
  view.setUint32(0xb8, 2, true);
  return bytes;
}
assert.throws(() => parseDex(withSuperclassDescriptor('I')), /dex-invalid-class-def-type/);
assert.throws(() => parseDex(withSuperclassDescriptor('[I')), /dex-invalid-class-def-type/);
// A class-type superclass keeps parsing (control): point superclass_idx at 1.
{
  const bytes = buildMinimalDex();
  const view = new DataView(bytes.buffer);
  view.setUint32(0xb8, 1, true);
  const parsed = parseDex(bytes);
  assert.equal(parsed.classes[0].superType, 'LTest;');
}

console.log('dex class_def defining type #7436: PASS');

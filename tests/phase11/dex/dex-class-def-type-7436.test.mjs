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

console.log('dex class_def defining type #7436: PASS');

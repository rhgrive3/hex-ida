import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';

console.log('[phase11] running DEX class_def offset regression #3751...');

function buildClassDefDex({ withReferences = false } = {}) {
  const fileSize = 0xe0;
  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);

  bytes.set([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00], 0); // dex\n035\0
  view.setUint32(32, fileSize, true);
  view.setUint32(36, 0x70, true);
  view.setUint32(40, 0x12345678, true);

  view.setUint32(56, 1, true); // string_ids_size
  view.setUint32(60, 0x70, true); // string_ids_off
  view.setUint32(64, 1, true); // type_ids_size
  view.setUint32(68, 0x74, true); // type_ids_off
  view.setUint32(96, 1, true); // class_defs_size
  view.setUint32(100, 0x78, true); // class_defs_off

  view.setUint32(0x70, 0xb0, true); // string_data_off
  view.setUint32(0x74, 0, true); // type 0 -> string 0

  view.setUint32(0x78, 0, true); // class_idx
  view.setUint32(0x7c, 1, true); // access_flags
  view.setUint32(0x80, 0xffffffff, true); // superclass_idx
  view.setUint32(0x84, withReferences ? 0x98 : 0, true); // interfaces_off
  view.setUint32(0x88, 0xffffffff, true); // source_file_idx
  view.setUint32(0x8c, withReferences ? 0x9c : 0, true); // annotations_off
  view.setUint32(0x90, 0, true); // class_data_off
  view.setUint32(0x94, withReferences ? 0xac : 0, true); // static_values_off

  view.setUint32(0x98, 0, true); // empty type_list
  // 0x9c..0xab is an empty annotations_directory_item (all zeroes).
  bytes[0xac] = 0; // encoded_array size = 0
  bytes.set([6, 0x4c, 0x54, 0x65, 0x73, 0x74, 0x3b, 0], 0xb0); // "LTest;"
  return bytes;
}

function mutated(fieldOffset, value) {
  const bytes = buildClassDefDex();
  new DataView(bytes.buffer).setUint32(0x78 + fieldOffset, value, true);
  return bytes;
}

assert.doesNotThrow(() => parseDex(buildClassDefDex()));
assert.doesNotThrow(() => parseDex(buildClassDefDex({ withReferences: true })));

assert.throws(
  () => parseDex(mutated(12, 0xe4)),
  /dex-invalid-interfaces-offset/,
);
assert.throws(
  () => parseDex(mutated(20, 0xe8)),
  /dex-invalid-annotations-offset/,
);
assert.throws(
  () => parseDex(mutated(28, 0xec)),
  /dex-invalid-static-values-offset/,
);

assert.throws(
  () => parseDex(mutated(12, 0x99)),
  /dex-invalid-interfaces-offset/,
);
assert.throws(
  () => parseDex(mutated(20, 0x9e)),
  /dex-invalid-annotations-offset/,
);

console.log('  ok DEX class_def offset regression #3751 passed');

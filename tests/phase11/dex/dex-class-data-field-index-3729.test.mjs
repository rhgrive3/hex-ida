import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildMinimalDex } from './dex-parser.test.mjs';

console.log('[phase11] running DEX class_data field-index regression #3729...');

function buildFieldDex(fieldCount, classData) {
  const bytes = buildMinimalDex();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  view.setUint32(80, fieldCount, true); // field_ids_size
  view.setUint32(84, 0xd0, true); // field_ids_off (immediately after class_defs)
  for (let i = 0; i < fieldCount; i++) {
    const off = 0xd0 + i * 8;
    view.setUint16(off, 1, true); // class_idx -> LTest;
    view.setUint16(off + 2, 1, true); // type_idx -> LTest;
    view.setUint32(off + 4, 2, true); // name_idx -> foo
  }

  bytes.fill(0, 0x120, 0x140);
  bytes.set(classData, 0x120);
  return bytes;
}

function rejects(fieldCount, classData) {
  assert.throws(
    () => parseDex(buildFieldDex(fieldCount, classData)),
    /dex-invalid-class-data-field-index/,
  );
}

// field_ids_size=1, but the first static field refers to field_ids[2].
rejects(1, [0x01, 0x00, 0x00, 0x00, 0x02, 0x01]);

// Instance fields have the same fail-closed index contract.
rejects(1, [0x00, 0x01, 0x00, 0x00, 0x02, 0x01]);

// Deltas accumulate within one encoded_field list.
assert.doesNotThrow(() =>
  parseDex(buildFieldDex(2, [0x02, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01])),
);
rejects(2, [0x02, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x01]);

// static_fields and instance_fields are independent delta sequences and must reset to index 0.
assert.doesNotThrow(() =>
  parseDex(buildFieldDex(2, [0x01, 0x01, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01])),
);

console.log('  ok DEX class_data field-index regression #3729 passed');

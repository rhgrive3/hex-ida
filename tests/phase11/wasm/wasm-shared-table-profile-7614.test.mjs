import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser-core.js';

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function moduleWithSection(id, payload) {
  assert.ok(payload.length < 0x80, 'fixture payload must fit one-byte uleb128');
  return Uint8Array.from([...HEADER, id, payload.length, ...payload]);
}

function limits(flags, min = 1, max = null) {
  const bytes = [flags, min];
  if (max != null) bytes.push(max);
  return bytes;
}

function definedTable(flags, min = 1, max = null) {
  return moduleWithSection(4, [1, 0x70, ...limits(flags, min, max)]);
}

function importedTable(flags, min = 1, max = null) {
  return moduleWithSection(2, [
    1,          // import count
    1, 0x6d,    // module name "m"
    1, 0x78,    // field name "x"
    1,          // table import
    0x70,       // funcref
    ...limits(flags, min, max),
  ]);
}

console.log('[phase11] running Wasm shared-table profile regression #7614...');

assert.deepEqual(parseWasm(definedTable(0x00)).tables[0], {
  elemType: 0x70,
  min: 1,
  max: null,
  shared: false,
  flags: 0,
});
assert.deepEqual(parseWasm(definedTable(0x01, 1, 2)).tables[0], {
  elemType: 0x70,
  min: 1,
  max: 2,
  shared: false,
  flags: 1,
});

for (const [flags, max] of [[0x02, null], [0x03, 1]]) {
  assert.throws(
    () => parseWasm(definedTable(flags, 1, max)),
    /wasm-invalid-table-limits-shared-unsupported/,
    `defined shared table flags=0x${flags.toString(16)} must fail closed`,
  );
  assert.throws(
    () => parseWasm(importedTable(flags, 1, max)),
    /wasm-invalid-table-limits-shared-unsupported/,
    `imported shared table flags=0x${flags.toString(16)} must fail closed`,
  );
}

// Shared memory remains a separate supported path (#3829); table policy must not
// accidentally reject its flags=0x03 encoding.
assert.deepEqual(
  parseWasm(moduleWithSection(5, [1, 0x03, 1, 2])).memories[0],
  { min: 1, max: 2, shared: true, flags: 3 },
);

// The original counterexample must be rejected before call_indirect can become
// normal Core-3.0 exact semantics.
const sharedCallIndirect = Uint8Array.from([
  ...HEADER,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x04, 0x05, 0x01, 0x70, 0x03, 0x01, 0x01,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x41, 0x00, 0x11, 0x00, 0x00, 0x0b,
]);
assert.throws(
  () => parseWasm(sharedCallIndirect),
  /wasm-invalid-table-limits-shared-unsupported/,
);

console.log('  ok Wasm shared-table profile regression #7614 passed');

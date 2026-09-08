import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser-core.js';

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function moduleWithSection(id, payload) {
  assert.ok(payload.length < 0x80, 'fixture payload must fit one-byte uleb128');
  return Uint8Array.from([...HEADER, id, payload.length, ...payload]);
}

function definedMemory(flags, min = 1, max = null) {
  const limits = [flags, min];
  if (max != null) limits.push(max);
  return moduleWithSection(5, [1, ...limits]);
}

function importedMemory(flags, min = 1, max = null) {
  const limits = [flags, min];
  if (max != null) limits.push(max);
  return moduleWithSection(2, [
    1,          // import count
    1, 0x6d,    // module name "m"
    1, 0x78,    // field name "x"
    2,          // memory import
    ...limits,
  ]);
}

assert.throws(
  () => parseWasm(definedMemory(0x02)),
  /wasm-invalid-memory-limits-shared-requires-maximum/,
  'defined shared memory without maximum must fail closed',
);
assert.throws(
  () => parseWasm(importedMemory(0x02)),
  /wasm-invalid-memory-limits-shared-requires-maximum/,
  'imported shared memory without maximum must fail closed',
);

const unsharedNoMax = parseWasm(definedMemory(0x00));
assert.deepEqual(unsharedNoMax.memories[0], { min: 1, max: null, shared: false, flags: 0 });

const unsharedWithMax = parseWasm(definedMemory(0x01, 1, 2));
assert.deepEqual(unsharedWithMax.memories[0], { min: 1, max: 2, shared: false, flags: 1 });

const sharedWithMax = parseWasm(definedMemory(0x03, 1, 2));
assert.deepEqual(sharedWithMax.memories[0], { min: 1, max: 2, shared: true, flags: 3 });

const importedSharedWithMax = parseWasm(importedMemory(0x03, 1, 2));
assert.deepEqual(importedSharedWithMax.imports[0].desc, {
  kind: 2,
  min: 1,
  max: 2,
  shared: true,
  flags: 3,
});

assert.throws(
  () => parseWasm(definedMemory(0x01, 2, 1)),
  /wasm-invalid-memory-limits-max-less-than-min/,
  'existing maximum >= minimum invariant must remain enforced',
);
assert.throws(
  () => parseWasm(definedMemory(0x03, 2, 1)),
  /wasm-invalid-memory-limits-max-less-than-min/,
  'shared memory must preserve the existing maximum >= minimum invariant',
);

console.log('[phase11] issue #3829 shared-memory limits regression passed');

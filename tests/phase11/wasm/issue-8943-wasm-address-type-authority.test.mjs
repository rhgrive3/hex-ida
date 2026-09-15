import assert from 'node:assert/strict';
import { parseWasm, decodeUleb128_64 } from '../../../js/managed/wasm/parser-core.js';

// #8943: the #4944 memory64 work made `addressType` conditional on i64 limits,
// silently dropping the canonical 'i32' width authority for every memory32 and
// table32 descriptor and letting `readMemoryLimits` key the page-limit check off
// property absence. The descriptor contract requires an explicit width on both
// branches, and consumers must read `addressType`, never absence.

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function moduleWithSection(id, payload) {
  assert.ok(payload.length < 0x80, 'fixture payload must fit one-byte uleb128');
  return Uint8Array.from([...HEADER, id, payload.length, ...payload]);
}

function definedMemory(flags, min = [1], max = null) {
  const limits = [flags, ...min];
  if (max != null) limits.push(...max);
  return moduleWithSection(5, [1, ...limits]);
}

function importedMemory(flags, min = [1], max = null) {
  const limits = [flags, ...min];
  if (max != null) limits.push(...max);
  return moduleWithSection(2, [
    1, 1, 0x6d, 1, 0x78, 2, ...limits,
  ]);
}

function table(elemType, flags, min = [1], max = null) {
  const limits = [flags, ...min];
  if (max != null) limits.push(...max);
  return moduleWithSection(4, [1, elemType, ...limits]);
}

// 1. every encodable memory32 flags variant keeps explicit addressType:'i32'.
for (const flags of [0x00, 0x01, 0x03]) {
  const hasMax = (flags & 1) !== 0;
  const parsed = parseWasm(definedMemory(flags, [1], hasMax ? [2] : null));
  assert.equal(parsed.memories[0].addressType, 'i32', `memory32 flags=0x${flags.toString(16)} must keep i32 width authority`);
  assert.equal(parsed.memories[0].shared, (flags & 2) !== 0);
  assert.equal(parsed.memories[0].flags, flags);
}

// 2. imported memory32 keeps the same shape.
const imported = parseWasm(importedMemory(0x03, [1], [2]));
assert.equal(imported.imports[0].desc.addressType, 'i32', 'imported memory32 must keep i32 width authority');
assert.equal(imported.imports[0].desc.shared, true);

// 3. table32 descriptors keep addressType:'i32'.
for (const elemType of [0x70, 0x6f]) {
  const parsed = parseWasm(table(elemType, 0x01, [1], [4]));
  assert.equal(parsed.tables[0].addressType, 'i32', 'table32 must keep i32 width authority');
  assert.equal(parsed.tables[0].elemType, elemType);
}
const importedTable = parseWasm(moduleWithSection(2, [1, 1, 0x6d, 1, 0x78, 1, 0x70, 0x00, 0x02]));
assert.equal(importedTable.imports[0].desc.addressType, 'i32', 'imported table32 must keep i32 width authority');

// 4. memory64 limits stay explicit i64 with u64 arithmetic.
const mem64 = parseWasm(definedMemory(0x04, [0x81, 0x80, 0x04])); // min = 65537 pages
assert.equal(mem64.memories[0].addressType, 'i64', 'memory64 must keep i64 width authority');
assert.equal(mem64.memories[0].min, 65537n, 'memory64 min must be a u64');
const mem64Max = parseWasm(definedMemory(0x05, [0x01], [0x02]));
assert.equal(mem64Max.memories[0].addressType, 'i64');
assert.equal(mem64Max.memories[0].max, 2n);
// memory64 min above the memory32 page ceiling must NOT trip the page-limit gate.
assert.ok(mem64.memories[0].min > 65536n, 'fixture must exceed the memory32 page ceiling');

// 5. the shared limits grammar gives table types the same address-type-aware
// decode, the #7614 shared-table policy stays enforced, i64+shared stays
// fail-closed, and the memory32 page-limit/shared-max gates survive without
// keying off descriptor property absence.
const table64 = parseWasm(table(0x70, 0x04, [0x01]));
assert.deepEqual(table64.tables[0], { elemType: 0x70, min: 1n, max: null, shared: false, addressType: 'i64', flags: 4 });
assert.throws(() => parseWasm(table(0x70, 0x06, [0x01, 0x02])), /wasm-invalid-table-limits-flags/);
assert.throws(() => parseWasm(table(0x70, 0x03, [0x01, 0x02])), /wasm-invalid-table-limits-shared-unsupported/);
assert.throws(() => parseWasm(definedMemory(0x06, [0x01, 0x02])), /wasm-invalid-memory-limits-flags/, 'memory64 shared must stay fail-closed');
assert.throws(
  () => parseWasm(definedMemory(0x00, [0x81, 0x80, 0x04])),
  /wasm-invalid-memory-limits-page-limit/,
  'memory32 min above the page ceiling must still fail closed',
);
assert.throws(
  () => parseWasm(definedMemory(0x01, [0x01], [0x81, 0x80, 0x04])),
  /wasm-invalid-memory-limits-page-limit/,
  'memory32 max above the page ceiling must still fail closed',
);
assert.throws(
  () => parseWasm(definedMemory(0x02)),
  /wasm-invalid-memory-limits-shared-requires-maximum/,
);

// 6. the u64 LEB decoder keeps its dedicated malformed code (a #4944
// acceptance criterion the #8711 validation consolidation had regressed).
assert.throws(() => decodeUleb128_64(Uint8Array.from(new Array(11).fill(0x80)), 0), /wasm-malformed-uleb128-64/);
assert.throws(
  () => parseWasm(definedMemory(0x04, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f])),
  /wasm-malformed-uleb128-64/,
  'memory64 min overflow must fail with the u64 malformed code',
);

console.log('[phase11] issue #8943 wasm memory/table address-type authority regression passed');

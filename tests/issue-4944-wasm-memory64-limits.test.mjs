import assert from 'node:assert/strict';
import { parseWasm } from '../js/managed/wasm/parser-core.js';

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function section(id, payload) {
  assert.ok(payload.length < 0x80, 'fixture payload must fit one-byte uleb128');
  return Uint8Array.from([...HEADER, id, payload.length, ...payload]);
}

function definedMemory(limits) {
  return section(5, [1, ...limits]);
}

function importedMemory(limits) {
  return section(2, [1, 1, 0x6d, 1, 0x78, 2, ...limits]);
}

// 1. memory64 (i64 address type, no maximum) must be accepted per Core 3.0 grammar.
const mem64NoMax = parseWasm(definedMemory([0x04, 0x00]));
assert.equal(mem64NoMax.memories[0].addressType, 'i64');
assert.equal(mem64NoMax.memories[0].min, 0n);
assert.equal(mem64NoMax.memories[0].max, null);
assert.equal(mem64NoMax.memories[0].shared, false);

// 2. memory64 with maximum must decode both limits as u64.
const mem64Max = parseWasm(definedMemory([0x05, 0x00, 0x01]));
assert.equal(mem64Max.memories[0].addressType, 'i64');
assert.equal(mem64Max.memories[0].min, 0n);
assert.equal(mem64Max.memories[0].max, 1n);

// 3. imported memory64 must be accepted too.
const imported64 = parseWasm(importedMemory([0x04, 0x00]));
assert.equal(imported64.imports[0].desc.addressType, 'i64');
assert.equal(imported64.imports[0].desc.min, 0n);

// 4. memory32 descriptors must stay byte-for-byte unchanged (no addressType key).
assert.deepEqual(parseWasm(definedMemory([0x00, 0x01])).memories[0], { min: 1, max: null, shared: false, flags: 0 });
assert.deepEqual(parseWasm(definedMemory([0x01, 0x01, 0x02])).memories[0], { min: 1, max: 2, shared: false, flags: 1 });
assert.deepEqual(parseWasm(definedMemory([0x03, 0x01, 0x02])).memories[0], { min: 1, max: 2, shared: true, flags: 3 });

// 5. malformed / overflowing u64 LEB and reserved flag bits must fail closed.
assert.throws(() => parseWasm(definedMemory([0x04, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02])), TypeError, 'overflowing u64 LEB must be rejected');
assert.throws(() => parseWasm(definedMemory([0x04, 0x80, 0x80, 0x80])), TypeError, 'truncated u64 LEB must be rejected');
assert.throws(() => parseWasm(definedMemory([0x08, 0x00])), /wasm-invalid-memory-limits-flags/, 'reserved limits flag bit must be rejected');
assert.throws(() => parseWasm(definedMemory([0x05, 0x01, 0x00])), /wasm-invalid-memory-limits-max-less-than-min/, 'memory64 maximum >= minimum invariant');

// 6. decoded descriptor distinguishes i32 from i64 address width.
const i32 = parseWasm(definedMemory([0x00, 0x01])).memories[0];
const i64 = parseWasm(definedMemory([0x04, 0x00])).memories[0];
assert.equal(i32.addressType, undefined);
assert.equal(i32.flags & 0x04, 0);
assert.equal(i64.addressType, 'i64');
assert.notEqual(i64.flags & 0x04, 0);

console.log('[issue] #4944 wasm Core 3.0 memory64 limits regression passed');

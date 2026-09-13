import assert from 'node:assert/strict';
import { parseWasm as parseWasmCore, probeWasm } from '../js/managed/wasm/parser-core.js';
import { parseWasm } from '../js/managed/wasm/parser.js';
import { resolveWasmMemory } from '../js/managed/wasm/memory-validation.js';

console.log('[phase11] running issue #4944 memory64 limits regression...');

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function moduleWithSection(id, payload) {
  assert.ok(payload.length < 0x80, 'fixture payload must fit one-byte uleb128');
  return Uint8Array.from([...HEADER, id, payload.length, ...payload]);
}

function definedMemory(limits) {
  return moduleWithSection(5, [1, ...limits]);
}

function importedMemory(limits) {
  return moduleWithSection(2, [1, 1, 0x6d, 1, 0x78, 2, ...limits]);
}

const counterexample = definedMemory([0x04, 0x00]);
const probe = probeWasm(counterexample);
assert.equal(probe.supported, true);
assert.equal(probe.vmSpecEdition, 'core-3.0');

for (const parse of [parseWasmCore, parseWasm]) {
  assert.deepEqual(parse(counterexample).memories[0], {
    min: 0n, max: null, shared: false, addressType: 'i64', flags: 4,
  }, 'memory64 flags=0x04 min=0 must decode as i64 limits');

  assert.deepEqual(parse(definedMemory([0x05, 0x00, 0x01])).memories[0], {
    min: 0n, max: 1n, shared: false, addressType: 'i64', flags: 5,
  }, 'memory64 flags=0x05 min=0 max=1 must decode as i64 limits');

  assert.deepEqual(parse(importedMemory([0x04, 0x02])).imports[0].desc, {
    kind: 2, min: 2n, max: null, shared: false, addressType: 'i64', flags: 4,
  }, 'imported memory64 must decode through the same limits grammar');

  assert.deepEqual(parse(definedMemory([0x00, 0x01])).memories[0], {
    min: 1, max: null, shared: false, addressType: 'i32', flags: 0,
  }, 'existing memory32 decoding must not regress');

  assert.deepEqual(parse(definedMemory([0x01, 0x01, 0x02])).memories[0], {
    min: 1, max: 2, shared: false, addressType: 'i32', flags: 1,
  }, 'memory32 min/max must stay u32-valued with an i32 address type');

  assert.deepEqual(parse(definedMemory([0x03, 0x01, 0x02])).memories[0], {
    min: 1, max: 2, shared: true, addressType: 'i32', flags: 3,
  }, 'shared memory32 (#3829) must keep its exact descriptor shape');
}

assert.deepEqual(
  parseWasmCore(definedMemory([0x04, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f])).memories[0],
  { min: 0xffffffffffn, max: null, shared: false, addressType: 'i64', flags: 4 },
  'memory64 minimums beyond the u32 range must decode via the u64 LEB grammar',
);

assert.throws(
  () => parseWasmCore(definedMemory([0x05, 0x02, 0x01])),
  /wasm-invalid-memory-limits-max-less-than-min/,
  'memory64 must keep the maximum >= minimum invariant',
);
assert.throws(
  () => parseWasmCore(definedMemory([0x02, 0x01])),
  /wasm-invalid-memory-limits-shared-requires-maximum/,
  'shared memory32 without a maximum must still fail closed',
);
assert.throws(
  () => parseWasmCore(definedMemory([0x01, 0x02, 0x01])),
  /wasm-invalid-memory-limits-max-less-than-min/,
  'memory32 must keep the existing maximum >= minimum invariant',
);

assert.throws(
  () => parseWasmCore(definedMemory([0x04, ...Array(10).fill(0x80), 0x00])),
  /wasm-malformed-uleb128-64/,
  'an overflowing 11-byte u64 LEB minimum must be rejected',
);
assert.throws(
  () => parseWasmCore(definedMemory([0x04, ...Array(9).fill(0x80), 0x02])),
  /wasm-malformed-uleb128-64/,
  'a 10-byte u64 LEB encoding wider than 64 bits must be rejected',
);
assert.throws(
  () => parseWasmCore(definedMemory([0x05, 0x00])),
  /wasm-malformed-uleb128-64/,
  'a memory64 maximum missing its bytes must be rejected',
);

for (const flags of [0x06, 0x07, 0x08, 0x80]) {
  assert.throws(
    () => parseWasmCore(definedMemory([flags, 0x01, 0x02])),
    /wasm-invalid-memory-limits-flags/,
    `memory limits flags 0x${flags.toString(16)} must stay fail-closed`,
  );
  assert.throws(
    () => parseWasmCore(importedMemory([flags, 0x01, 0x02])),
    /wasm-invalid-memory-limits-flags/,
    `imported memory limits flags 0x${flags.toString(16)} must stay fail-closed`,
  );
}

assert.deepEqual(
  parseWasmCore(moduleWithSection(4, [1, 0x70, 0x04, 0x01])).tables[0],
  { elemType: 0x70, min: 1n, max: null, shared: false, addressType: 'i64', flags: 4 },
  'the shared limits grammar must give table types the same address-type-aware decode',
);
assert.throws(
  () => parseWasmCore(moduleWithSection(4, [1, 0x70, 0x03, 0x01, 0x02])),
  /wasm-invalid-table-limits-shared-unsupported/,
  'the #7614 shared-table policy must remain enforced',
);

const mem64 = { memories: [parseWasmCore(definedMemory([0x04, 0x00])).memories[0]] };
assert.throws(
  () => resolveWasmMemory(mem64, 0),
  /wasm-unsupported-memory-address-type/,
  'a decoded memory64 descriptor must stay fail-closed in the memory32-only lifter layer',
);
const mem32 = { memories: [parseWasmCore(definedMemory([0x00, 0x01])).memories[0]] };
assert.equal(resolveWasmMemory(mem32, 0).addressType, 0x7f);

console.log('  ok issue #4944 memory64 limits regression passed');

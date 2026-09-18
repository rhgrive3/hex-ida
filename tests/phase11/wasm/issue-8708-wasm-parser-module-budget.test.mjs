import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

console.log('[phase11] running issue #8708 Wasm parser module-wide resource budget tests...');

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function uleb(value) {
  const out = [];
  let n = value >>> 0;
  do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n);
  return out;
}
function section(id, payload) { return [id, ...uleb(payload.length), ...payload]; }
function assemble(parts) { return Uint8Array.from([...MAGIC, ...parts.flat()]); }

// Type-section counterexample from the issue: N unused `[] -> []` function types.
function typeVectorModule(n) {
  const payload = [...uleb(n)];
  for (let i = 0; i < n; i++) payload.push(0x60, 0x00, 0x00);
  return assemble([section(1, payload)]);
}

// Nested-empty-blocks counterexample from the issue comments: one () -> ()
// function containing n nested blocks and nothing else.
function nestedBlocksModule(n) {
  const body = [0x00];
  for (let i = 0; i < n; i++) body.push(0x02, 0x40);
  for (let i = 0; i < n; i++) body.push(0x0b);
  body.push(0x0b);
  return assemble([
    section(1, [0x01, 0x60, 0x00, 0x00]),
    section(3, [...uleb(1), 0x00]),
    section(10, [...uleb(1), ...uleb(body.length), ...body]),
  ]);
}

function exportVectorModule(n) {
  const payload = [...uleb(n)];
  for (let i = 0; i < n; i++) {
    const name = `x${i}`;
    payload.push(name.length, ...Array.from(name, (c) => c.charCodeAt(0)), 0x00, 0x00);
  }
  return assemble([
    section(1, [0x01, 0x60, 0x00, 0x00]),
    section(3, [...uleb(1), 0x00]),
    section(7, payload),
  ]);
}

function importVectorModule(n) {
  const payload = [...uleb(n)];
  for (let i = 0; i < n; i++) payload.push(0x01, 0x61, 0x01, 0x62, 0x00, 0x00);
  return assemble([section(1, [0x01, 0x60, 0x00, 0x00]), section(2, payload)]);
}

function customNameModule(length) {
  return assemble([section(0, [...uleb(length), ...new Array(length).fill(0x61)])]);
}

// Ordinary module touching every budgeted vector class stays exact.
function ordinaryModule() {
  const body = [
    ...uleb(1), ...uleb(2), 0x7f,     // one group of two i32 locals
    0x41, 0x07, 0x21, 0x02, 0x0b,     // i32.const 7; local.set 2; end
  ];
  return assemble([
    section(1, [0x02, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x00, 0x00]),
    section(2, [0x01, ...uleb(1), 0x61, ...uleb(1), 0x62, 0x00, 0x00]),
    section(3, [...uleb(1), 0x00]),
    section(4, [0x01, 0x70, 0x00, 0x01]),
    section(5, [0x01, 0x00, 0x01]),
    section(6, [0x01, 0x7f, 0x01, 0x41, 0x01, 0x0b]),
    section(7, [0x01, ...uleb(1), 0x66, 0x00, 0x00]),
    section(9, [0x01, 0x00, 0x41, 0x00, 0x0b, ...uleb(1), 0x00]),
    section(10, [...uleb(1), ...uleb(body.length), ...body]),
    section(11, [0x01, 0x00, 0x41, 0x00, 0x0b, ...uleb(2), 0xde, 0xad]),
    section(0, [...uleb(4), ...Array.from('note', (c) => c.charCodeAt(0)), 0x01]),
  ]);
}

const parsed = parseWasm(ordinaryModule());
assert.equal(parsed.types.length, 2);
assert.deepEqual([...parsed.types[0].params], [0x7f]);
assert.deepEqual([...parsed.types[0].results], [0x7f]);
assert.equal(parsed.imports.length, 1);
assert.equal(parsed.exports[0].name, 'f');
assert.equal(parsed.globals.length, 1);
assert.equal(parsed.elements[0].functionIndices.length, 1);
assert.equal(parsed.dataSegments[0].data.length, 2);
assert.equal(parsed.customSections[0].name, 'note');
assert.ok(Object.isFrozen(parsed.types[0]), 'admitted module must stay deeply frozen');

// Structural depth below the limit must stay exact.
assert.doesNotThrow(
  () => parseWasm(nestedBlocksModule(1000)),
  'ordinary nested control flow well below the limit must stay exact',
);
assert.equal(parseWasm(nestedBlocksModule(1000)).codeBodies.length, 1);

// Large Type vectors stop with an explicit resource-limit outcome, not OOM.
assert.throws(() => parseWasm(typeVectorModule(600000)), /wasm-resource-limit-heap/,
  'the 600k empty-type fixture must be rejected by the default module budget');

// Budgets are injectable so admission can be proven with tiny fixtures too.
assert.throws(() => parseWasm(typeVectorModule(5000), { resourceBudget: { maxObjects: 100 } }),
  /wasm-resource-limit-objects/, 'object budget must reject before full materialization');
assert.throws(() => parseWasm(typeVectorModule(5000), { resourceBudget: { maxEstimatedHeapBytes: 4096 } }),
  /wasm-resource-limit-heap/, 'heap budget must reject a Type vector');
assert.throws(() => parseWasm(typeVectorModule(5000), { resourceBudget: { maxRecords: 16 } }),
  /wasm-resource-limit-records/, 'record budget must reject a Type vector');
assert.throws(() => parseWasm(typeVectorModule(5000), { resourceBudget: { maxOperations: 8 } }),
  /wasm-resource-limit-operations/, 'work budget must reject a Type vector');

// The shared budget is parser-wide, not Type-section-only.
assert.throws(() => parseWasm(exportVectorModule(5000), { resourceBudget: { maxRecords: 64 } }),
  /wasm-resource-limit-records/, 'export vectors must charge the same module budget');
assert.throws(() => parseWasm(importVectorModule(5000), { resourceBudget: { maxRecords: 64 } }),
  /wasm-resource-limit-records/, 'import name materialization must charge the same module budget');

// Name decoding must be admitted before TextDecoder materializes the string.
// A low heap budget therefore rejects a valid large name without first
// allocating the decoded UTF-16 representation.
{
  const originalDecode = TextDecoder.prototype.decode;
  let decodeCalls = 0;
  TextDecoder.prototype.decode = function (...args) {
    decodeCalls += 1;
    return originalDecode.apply(this, args);
  };
  try {
    assert.throws(
      () => parseWasm(customNameModule(1024 * 1024), { resourceBudget: { maxEstimatedHeapBytes: 1024 } }),
      /wasm-resource-limit-heap/,
      'a low name budget must reject before decoding a large Custom-section name',
    );
  } finally {
    TextDecoder.prototype.decode = originalDecode;
  }
  assert.equal(decodeCalls, 0, 'a rejected name must not reach TextDecoder.decode');
}

// Temporary structural validation state is admitted through the same boundary.
assert.throws(() => parseWasm(nestedBlocksModule(100000)), /wasm-resource-limit-depth/,
  'deeply nested valid blocks must stop at the default control-depth budget');
assert.throws(() => parseWasm(nestedBlocksModule(64), { resourceBudget: { maxControlDepth: 8 } }),
  /wasm-resource-limit-depth/, 'injected depth budget must reject earlier nesting');

// Cancellation and wall-clock checkpoints are observed.
{
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => parseWasm(typeVectorModule(50000), { signal: controller.signal }),
    /wasm-resource-limit-cancelled/, 'aborted signal must stop the parse boundedly');
}
assert.throws(() => parseWasm(typeVectorModule(200000), { resourceBudget: { deadlineMs: 0 } }),
  /wasm-resource-limit-deadline/, 'wall-clock budget must stop long vectors boundedly');

// Ordinary modules still parse exactly with defaults after all of the above.
assert.doesNotThrow(() => parseWasm(ordinaryModule()));
assert.doesNotThrow(() => parseWasm(typeVectorModule(50)), 'small Type vectors must stay exact');

console.log('[phase11] issue #8708 Wasm parser module-wide resource budget tests passed');

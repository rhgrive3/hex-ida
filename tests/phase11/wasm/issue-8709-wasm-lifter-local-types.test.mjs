import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser.js';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { liftWasmFunction as liftWasmFunctionCore } from '../../../js/managed/wasm/lifter-core.js';
import { WasmFrontend } from '../../../js/managed/wasm/frontend.js';

console.log('[phase11] running issue #8709 Wasm lifter local-type resolution tests...');

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const I32 = 0x7f, I64 = 0x7e, F32 = 0x7d, F64 = 0x7c;

function uleb(value) {
  const out = [];
  let n = value >>> 0;
  do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n);
  return out;
}
function section(id, payload) { return [id, ...uleb(payload.length), ...payload]; }

// (i32, i64) -> () with local groups [3 x i32] [2 x f64] => indices:
// 0=i32 param, 1=i64 param, 2..4=i32 locals, 5..6=f64 locals.
function typedLocalsModule(accesses) {
  const body = [
    ...uleb(2), ...uleb(3), I32, ...uleb(2), F64,
    ...accesses,
    0x0b,
  ];
  return Uint8Array.from([
    ...MAGIC,
    ...section(1, [0x01, 0x60, 0x02, I32, I64, 0x00]),
    ...section(3, [...uleb(1), 0x00]),
    ...section(10, [...uleb(1), ...uleb(body.length), ...body]),
  ]);
}

function getDrop(index) { return [0x20, ...uleb(index), 0x1a]; }
function setFrom(source, index) { return [0x20, ...uleb(source), 0x21, ...uleb(index)]; }
function teeFrom(source, index) { return [0x20, ...uleb(source), 0x22, ...uleb(index), 0x1a]; }

const exactModule = parseWasm(typedLocalsModule([
  ...getDrop(0), ...getDrop(1), ...getDrop(2), ...getDrop(3), ...getDrop(4), ...getDrop(5), ...getDrop(6),
  ...setFrom(5, 6), ...teeFrom(4, 0),
]));
const exactLift = liftWasmFunction(0, exactModule);
const reads = exactLift.bundles.filter((b) => b.mnemonic === 'local.get').map((b) => b.locationReads[0]);
const writes = exactLift.bundles.filter((b) => b.mnemonic === 'local.set' || b.mnemonic === 'local.tee').map((b) => b.locationWrites[0]);
assert.deepEqual(reads.map((r) => r.type), [I32, I64, I32, I32, I32, F64, F64, F64, I32], 'params and every local group boundary must resolve exactly');
assert.deepEqual(reads.map((r) => r.bits), [32, 64, 32, 32, 32, 64, 64, 64, 32]);
assert.deepEqual(reads.map((r) => r.index), [0, 1, 2, 3, 4, 5, 6, 5, 4]);
assert.deepEqual(writes.map((w) => [w.index, w.type]), [[6, F64], [0, I32]], 'local.set/local.tee must resolve the same indices');

for (const opcode of [0x20, 0x21, 0x22]) {
  const bad = opcode === 0x20 ? getDrop(7) : opcode === 0x21 ? setFrom(0, 7) : teeFrom(0, 7);
  assert.throws(
    () => liftWasmFunctionCore(0, parseWasm(typedLocalsModule(bad))),
    /wasm-invalid-local-index/,
    `opcode 0x${opcode.toString(16)} out-of-range local index must still fail closed`,
  );
}

// Instrumented proof that local type storage is no longer materialized per
// local access: count how often the canonical locals vector is iterated during
// a 16-access lift versus a 48-access lift. The count must not scale with the
// number of local instructions.
function countLocalsIterations(module, accesses) {
  const target = module.codeBodies[0].locals;
  const original = Array.prototype[Symbol.iterator];
  let count = 0;
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    configurable: true,
    writable: true,
    value: function () { if (this === target) count++; return original.call(this); },
  });
  try {
    liftWasmFunction(0, module, { budget: { maxOperations: 100000, maxValues: 200000 } });
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, { configurable: true, writable: true, value: original });
  }
  return count;
}
{
  const many = typedLocalsModule(Array.from({ length: 16 }, (_, i) => getDrop(i % 7)).flat());
  const more = typedLocalsModule(Array.from({ length: 48 }, (_, i) => getDrop(i % 7)).flat());
  const manyModule = parseWasm(many);
  const moreModule = parseWasm(more);
  const few = countLocalsIterations(manyModule, 16);
  const lots = countLocalsIterations(moreModule, 48);
  assert.ok(few === lots, `locals vector must not be iterated per local instruction (16 accesses: ${few}, 48 accesses: ${lots})`);
}

// The issue's production-path fixture: 1,000,000 compactly-declared locals with
// 300 local.get/drop pairs (~930 bytes). This used to spend ~10s copying the
// million-entry vector once per access.
function bigLocalsModule(ops) {
  const body = [
    ...uleb(1), ...uleb(1000000), I32,
    ...Array.from({ length: ops }, () => getDrop(0)).flat(),
    0x0b,
  ];
  return Uint8Array.from([
    ...MAGIC,
    ...section(1, [0x01, 0x60, 0x02, I32, I64, 0x00]),
    ...section(3, [...uleb(1), 0x00]),
    ...section(10, [...uleb(1), ...uleb(body.length), ...body]),
  ]);
}
{
  const bytes = bigLocalsModule(300);
  assert.ok(bytes.length < 1024, `fixture must stay under 1 KiB, got ${bytes.length}`);
  const module = parseWasm(bytes);
  assert.equal(module.codeBodies[0].locals.length, 1000000, 'the #3998 canonical ceiling stays admitted');
  const startedAt = Date.now();
  const lifted = liftWasmFunction(0, module);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 5000, `300 local.get/drop pairs over 1,000,000 locals must lift boundedly, took ${elapsedMs}ms`);
  const localGets = lifted.bundles.filter((b) => b.mnemonic === 'local.get');
  assert.equal(localGets.length, 300);
  assert.equal(localGets[0].locationReads[0].type, I32);
}

// Public frontend decode path must be covered too.
{
  const image = parseWasm(typedLocalsModule([...getDrop(6), ...setFrom(4, 4)]));
  const frontend = new WasmFrontend();
  const method = { funcIndex: 0, id: 'method-0' };
  const decoded = await frontend.decodeMethod(method, { image });
  const last = decoded.bundles[decoded.bundles.length - 2];
  assert.equal(last.mnemonic, 'local.set');
  assert.equal(last.locationWrites[0].type, I32);
  assert.equal(last.locationWrites[0].index, 4);
}

console.log('[phase11] issue #8709 Wasm lifter local-type resolution tests passed');

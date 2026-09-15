import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser.js';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { liftWasmFunction as liftWasmFunctionCore } from '../../../js/managed/wasm/lifter-core.js';
import { WasmFrontend } from '../../../js/managed/wasm/frontend.js';

console.log('[phase11] running issue #8768 Wasm module import/export index regression...');

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const I32 = 0x7f, I64 = 0x7e;
const WIDE_BUDGET = { budget: { maxOperations: 4000000, maxValues: 4000000 } };

function uleb(value) {
  const out = [];
  let n = value >>> 0;
  do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n);
  return out;
}
function section(id, payload) { return [id, ...uleb(payload.length), ...payload]; }
function nameBytes(name) { return [name.length, ...Array.from(name, (c) => c.charCodeAt(0))]; }
function funcImport(field, typeIndex) { return [0x01, 0x6d, ...nameBytes(field), 0x00, ...uleb(typeIndex)]; }

// type 0 = () -> (), type 1 = (i32) -> ().
const TWO_TYPES = section(1, [0x02, 0x60, 0x00, 0x00, 0x60, 0x01, I32, 0x00]);

function assemble({ imports = [], functions = [], codeBodies = [], globals = [], tables = [], exports = [] }) {
  const bytes = [...MAGIC, ...TWO_TYPES];
  if (imports.length) bytes.push(...section(2, [...uleb(imports.length), ...imports.flat()]));
  if (functions.length) bytes.push(...section(3, [...uleb(functions.length), ...functions]));
  if (tables.length) bytes.push(...section(4, [...uleb(tables.length), ...tables.flat()]));
  if (globals.length) bytes.push(...section(6, [...uleb(globals.length), ...globals.flat()]));
  if (exports.length) bytes.push(...section(7, [...uleb(exports.length), ...exports.flat()]));
  if (codeBodies.length) {
    const payload = uleb(codeBodies.length);
    for (const body of codeBodies) payload.push(...uleb(body.length), ...body);
    bytes.push(...section(10, payload));
  }
  return Uint8Array.from(bytes);
}

// One internal function (index nImports) making `nCalls` direct calls to import 0.
function callModule(nCalls, nImports) {
  const imports = [];
  for (let i = 0; i < nImports; i++) imports.push(funcImport(`f${i}`, 0));
  const body = [...Array.from({ length: nCalls }, () => [0x10, ...uleb(0)]).flat(), 0x0b];
  return assemble({ imports, functions: [0], codeBodies: [[0x00, ...body]] });
}

// Imported i64 mutable global + defined i32 immutable global, alternating access.
function globalAccessModule(nAccesses) {
  const body = [
    ...Array.from({ length: nAccesses }, (_, i) => [0x23, ...uleb(i % 2), 0x1a]).flat(),
    0x0b,
  ];
  return assemble({
    imports: [[0x01, 0x6d, ...nameBytes('g'), 0x03, I64, 0x01]],
    globals: [[I32, 0x00, 0x41, 0x07, 0x0b]],
    functions: [0],
    codeBodies: [[0x00, ...body]],
  });
}

// `nFunctions` imported functions, each exported exactly once.
function exportedFunctionsModule(nFunctions) {
  const imports = [];
  const exports = [];
  for (let i = 0; i < nFunctions; i++) {
    imports.push(funcImport(`f${i}`, 0));
    exports.push([...nameBytes(`e${i}`), 0x00, ...uleb(i)]);
  }
  return assemble({ imports, exports });
}

async function countCallsOf(methodName, target, run) {
  let count = 0;
  const original = Array.prototype[methodName];
  Object.defineProperty(Array.prototype, methodName, {
    configurable: true, writable: true,
    value: function (...args) { if (this === target) count += 1; return original.apply(this, args); },
  });
  try {
    await run();
  } finally {
    Object.defineProperty(Array.prototype, methodName, { configurable: true, writable: true, value: original });
  }
  return count;
}

// 1) Exact callee resolution across the import/internal boundary.
{
  const imports = [funcImport('f0', 0), funcImport('f1', 0)];
  const functions = [0, 1];
  const bodies = [
    [0x00, 0x41, 0x00, 0x10, 0x03, 0x10, 0x00, 0x0b],
    [0x00, 0x41, 0x00, 0x0b],
  ];
  const lifted = liftWasmFunction(2, parseWasm(assemble({ imports, functions, codeBodies: bodies })), WIDE_BUDGET);
  const calls = lifted.bundles.filter((b) => b.mnemonic === 'call');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].callEffects[0].signature, { params: [I32], results: [] }, 'internal callee keeps type 1');
  assert.deepEqual(calls[1].callEffects[0].signature, { params: [], results: [] }, 'imported callee keeps type 0');
}

// 2) Exact global namespace resolution across the import/defined boundary.
{
  const lifted = liftWasmFunction(0, parseWasm(globalAccessModule(2)), WIDE_BUDGET);
  const gets = lifted.bundles.filter((b) => b.mnemonic === 'global.get');
  assert.equal(gets.length, 2);
  assert.deepEqual(gets.map((b) => b.locationReads[0].bits), [64, 32], 'imported then defined global resolves exactly');
  assert.deepEqual(gets.map((b) => b.locationReads[0].index), [0, 1]);
}

// 3) Fail-closed boundaries unchanged after indexing.
{
  const badCallee = assemble({ imports: [funcImport('f0', 0)], functions: [0], codeBodies: [[0x00, 0x10, 0x2a, 0x0b]] });
  assert.throws(() => liftWasmFunction(1, parseWasm(badCallee), WIDE_BUDGET), /wasm-invalid-callee-type-index/);
  const badGlobal = assemble({ functions: [0], globals: [[I32, 0x00, 0x41, 0x00, 0x0b]], codeBodies: [[0x00, 0x23, 0x09, 0x1a, 0x0b]] });
  assert.throws(() => liftWasmFunctionCore(0, parseWasm(badGlobal), WIDE_BUDGET), /wasm-invalid-global-index/);
  const immutableWrite = assemble({ functions: [0], globals: [[I32, 0x00, 0x41, 0x00, 0x0b]], codeBodies: [[0x00, 0x41, 0x01, 0x24, 0x00, 0x0b]] });
  assert.throws(() => liftWasmFunctionCore(0, parseWasm(immutableWrite), WIDE_BUDGET), /wasm-write-immutable-global/);
  const tableImport = [[0x01, 0x6d, ...nameBytes('t'), 0x01, 0x70, 0x00, 0x01]];
  const definedTable = [[0x70, 0x00, 0x01]];
  const okIndirect = assemble({
    imports: tableImport, tables: definedTable, functions: [0],
    codeBodies: [[0x00, 0x41, 0x00, 0x11, 0x00, 0x01, 0x0b]],
  });
  assert.doesNotThrow(() => liftWasmFunction(0, parseWasm(okIndirect), WIDE_BUDGET), 'defined table resolves past the imported prefix');
  const badTable = assemble({
    imports: tableImport, tables: definedTable, functions: [0],
    codeBodies: [[0x00, 0x41, 0x00, 0x11, 0x00, 0x02, 0x0b]],
  });
  assert.throws(() => liftWasmFunction(0, parseWasm(badTable), WIDE_BUDGET), /wasm-invalid-call-indirect-table-index/);
}

// 4) Instrumented proof: no import-array rescan per call/global instruction.
{
  const few = parseWasm(callModule(16, 8));
  const many = parseWasm(callModule(64, 8));
  const fewScans = await countCallsOf('filter', few.imports, () => { liftWasmFunction(8, few, WIDE_BUDGET); });
  const manyScans = await countCallsOf('filter', many.imports, () => { liftWasmFunction(8, many, WIDE_BUDGET); });
  assert.ok(fewScans === manyScans, `direct-call lifting must not scale with call count (16 calls: ${fewScans}, 64 calls: ${manyScans})`);
  assert.equal(fewScans, 0);

  const fewGlobals = parseWasm(globalAccessModule(16));
  const manyGlobals = parseWasm(globalAccessModule(64));
  const fewGlobalScans = await countCallsOf('filter', fewGlobals.imports, () => { liftWasmFunction(0, fewGlobals, WIDE_BUDGET); });
  const manyGlobalScans = await countCallsOf('filter', manyGlobals.imports, () => { liftWasmFunction(0, manyGlobals, WIDE_BUDGET); });
  assert.ok(fewGlobalScans === manyGlobalScans, `global access lifting must not scale with access count (16: ${fewGlobalScans}, 64: ${manyGlobalScans})`);
  assert.equal(fewGlobalScans, 0);
}

// 5) Instrumented proof: enumerateMethods must not scan the export vector per function.
{
  const few = parseWasm(exportedFunctionsModule(32));
  const many = parseWasm(exportedFunctionsModule(64));
  const frontend = new WasmFrontend();
  async function drain(image) {
    let seen = 0;
    for await (const method of frontend.enumerateMethods(image)) {
      seen += 1;
      if (method.funcIndex === 3) assert.equal(method.exportName, 'e3', 'export identity preserved');
    }
    return seen;
  }
  assert.equal(await drain(few), 32);
  assert.equal(await drain(many), 64);
  const fewScans = await countCallsOf('find', few.exports, () => drain(few));
  const manyScans = await countCallsOf('find', many.exports, () => drain(many));
  assert.ok(fewScans === manyScans, `export vector must not be scanned per function (32 funcs: ${fewScans}, 64 funcs: ${manyScans})`);
  assert.equal(fewScans, 0);
}

// 6) Bounded linear envelope on the issue's counterexample shape:
//    12,000 function imports + 12,000 direct calls decoded through the public path.
{
  const image = parseWasm(callModule(12000, 12000));
  const frontend = new WasmFrontend();
  const startedAt = Date.now();
  const decoded = await frontend.decodeMethod({ funcIndex: 12000 }, { image });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(decoded.bundles.filter((b) => b.mnemonic === 'call').length, 12000);
  assert.ok(elapsedMs < 5000, `12,000 direct calls over 12,000 imports must decode boundedly, took ${elapsedMs}ms`);
}

console.log('[phase11] issue #8768 Wasm module import/export index regression passed');

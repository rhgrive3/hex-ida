import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

console.log('[phase11] running wasm const-expression validation #3756...');

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const section = (id, payload) => [id, payload.length, ...payload];
const wasm = (...sections) => Uint8Array.from([...HEADER, ...sections.flat()]);
const f64Zero = [0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0x0b];
const i32Zero = [0x41, 0x00, 0x0b];
const importedGlobal = (mutable = false) => section(2, [
  0x01,             // import count
  0x01, 0x6d,       // module "m"
  0x01, 0x67,       // field "g"
  0x03,             // global import
  0x7f, mutable ? 0x01 : 0x00,
]);
const globalSection = (valType, expr) => section(6, [0x01, valType, 0x00, ...expr]);

assert.throws(
  () => parseWasm(wasm(globalSection(0x7f, [0x23, 0x00, 0x0b]))),
  /wasm-invalid-const-expr-global-index/,
  'global.get must not reference a missing imported global',
);

assert.doesNotThrow(() => parseWasm(wasm(
  importedGlobal(false),
  globalSection(0x7f, [0x23, 0x00, 0x0b]),
)));

assert.throws(
  () => parseWasm(wasm(
    importedGlobal(true),
    globalSection(0x7f, [0x23, 0x00, 0x0b]),
  )),
  /wasm-invalid-const-expr-global-mutability/,
  'constant expressions may not read mutable imported globals',
);

assert.doesNotThrow(() => parseWasm(wasm(globalSection(0x7f, i32Zero))));
assert.throws(
  () => parseWasm(wasm(globalSection(0x7f, f64Zero))),
  /wasm-invalid-const-expr-result-type/,
  'global initializer result type must match its declared global type',
);

assert.throws(
  () => parseWasm(wasm(globalSection(0x70, [0xd2, 0x00, 0x0b]))),
  /wasm-invalid-const-expr-function-index/,
  'ref.func must reference an existing function',
);

const typeSection = section(1, [0x01, 0x60, 0x00, 0x00]);
const functionImport = section(2, [
  0x01,
  0x01, 0x6d,
  0x01, 0x66,
  0x00, 0x00,
]);
assert.doesNotThrow(() => parseWasm(wasm(
  typeSection,
  functionImport,
  globalSection(0x70, [0xd2, 0x00, 0x0b]),
)));

const tableSection = section(4, [0x01, 0x70, 0x00, 0x01]);
const elementSection = (expr) => section(9, [0x01, 0x00, ...expr, 0x00]);
assert.doesNotThrow(() => parseWasm(wasm(tableSection, elementSection(i32Zero))));
assert.throws(
  () => parseWasm(wasm(tableSection, elementSection(f64Zero))),
  /wasm-invalid-const-expr-result-type/,
  'active element offsets must produce i32',
);

const memorySection = section(5, [0x01, 0x00, 0x01]);
const dataSection = (expr) => section(11, [0x01, 0x00, ...expr, 0x00]);
assert.doesNotThrow(() => parseWasm(wasm(memorySection, dataSection(i32Zero))));
assert.throws(
  () => parseWasm(wasm(memorySection, dataSection(f64Zero))),
  /wasm-invalid-const-expr-result-type/,
  'active data offsets must produce i32',
);

console.log('  ok wasm const-expression validation #3756 passed');

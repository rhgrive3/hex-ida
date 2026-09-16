// Regression for #5045: the Core 3.0 element section binary grammar defines the
// expression-vector forms flags 4..7 (active table 0, passive, active explicit
// table, declarative) next to the legacy index-vector forms 0..3. The parser
// rejected 4..7 before reading any segment content while probeWasm() published
// `vmSpecEdition:'core-3.0'`, so valid reference-type binaries were unopenable.
// Flags 4..7 must decode structurally, carry their reftype, and connect every
// initializer expression to the existing constant-expression validator.
import assert from 'node:assert/strict';

import { parseWasm } from '../js/managed/wasm/parser.js';

console.log('[phase11] running wasm element expression-vector forms #5045...');

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const section = (id, payload) => [id, payload.length, ...payload];
const wasm = (...sections) => Uint8Array.from([...HEADER, ...sections.flat()]);
const i32Zero = [0x41, 0x00, 0x0b];
const f64Zero = [0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0x0b];
const refNull = (t) => [0xd0, t, 0x0b];
const refFunc = (i) => [0xd2, i, 0x0b];
const exprVector = (...exprs) => [exprs.length, ...exprs.flat()];
const indexVector = (...idx) => [idx.length, ...idx];
const funcrefType = section(1, [0x01, 0x60, 0x00, 0x00]);
const oneFunction = section(3, [0x01, 0x00]);
const oneEmptyBody = section(10, [0x01, 0x02, 0x00, 0x0b]);
const funcrefTable = (min = 1) => section(4, [0x01, 0x70, 0x00, min]);
const externrefTable = (min = 1) => section(4, [0x01, 0x6f, 0x00, min]);
const twoTables = section(4, [0x02, 0x70, 0x00, 0x01, 0x6f, 0x00, 0x01]);

function decode(bytes, label) {
  assert.equal(WebAssembly.validate(bytes), true, `${label}: fixture must be a valid Core 3.0 binary`);
  const module = parseWasm(bytes);
  assert.equal(module.vmSpecEdition, 'core-3.0', `${label}: probe identity must stay core-3.0`);
  assert.equal(module.elements.length, 1, `${label}: exactly one element segment`);
  return module.elements[0];
}

// flags=5: passive + reftype + expression vector. The issue's minimal counterexample
// needs no function, table, or code section at all.
{
  const element = decode(wasm(section(9, [0x01, 0x05, 0x70, 0x00])), 'flags=5 empty funcref');
  assert.equal(element.mode, 'passive');
  assert.equal(element.refType, 0x70);
  assert.deepEqual(element.initializers, []);
}

// flags=4: active table 0 + offset expression + expression vector.
{
  const bytes = wasm(funcrefTable(), section(9, [0x01, 0x04, ...i32Zero, ...exprVector(refNull(0x70))]));
  const element = decode(bytes, 'flags=4');
  assert.equal(element.mode, 'active');
  assert.equal(element.tableIndex, 0);
  assert.equal(element.refType, 0x70);
  assert.equal(element.offsetExpr.ops.length, 1);
  assert.equal(element.offsetExpr.ops[0].opcode, 0x41);
  assert.equal(element.initializers.length, 1);
  assert.equal(element.initializers[0].ops[0].opcode, 0xd0);
  assert.equal(element.initializers[0].ops[0].refType, 0x70);
  assert.deepEqual(element.functionIndices, []);
}

// flags=6: active explicit table + offset expression + reftype + expression vector.
{
  const bytes = wasm(twoTables, section(9, [0x01, 0x06, 0x01, ...i32Zero, 0x6f, ...exprVector(refNull(0x6f))]));
  const element = decode(bytes, 'flags=6');
  assert.equal(element.mode, 'active');
  assert.equal(element.tableIndex, 1);
  assert.equal(element.refType, 0x6f);
  assert.equal(element.initializers[0].ops[0].refType, 0x6f);
}

// flags=7: declarative + reftype + expression vector, with a ref.func initializer.
{
  const bytes = wasm(
    funcrefType,
    oneFunction,
    funcrefTable(),
    section(9, [0x01, 0x07, 0x70, ...exprVector(refFunc(0))]),
    oneEmptyBody,
  );
  const element = decode(bytes, 'flags=7');
  assert.equal(element.mode, 'declarative');
  assert.equal(element.tableIndex, 0);
  assert.equal(element.offsetExpr, null);
  assert.equal(element.refType, 0x70);
  assert.equal(element.initializers[0].ops[0].opcode, 0xd2);
  assert.equal(element.initializers[0].ops[0].index, 0);
}

// Expression vectors hold several initializers and may mix with a legacy form.
{
  const bytes = wasm(
    funcrefType,
    oneFunction,
    funcrefTable(2),
    section(9, [
      0x02,
      0x01, 0x00, ...indexVector(0),
      0x05, 0x70, ...exprVector(refNull(0x70), refFunc(0)),
    ]),
    oneEmptyBody,
  );
  assert.equal(WebAssembly.validate(bytes), true, 'mixed: fixture must be a valid Core 3.0 binary');
  const module = parseWasm(bytes);
  assert.equal(module.elements.length, 2);
  assert.equal(module.elements[0].mode, 'passive');
  assert.deepEqual(module.elements[0].functionIndices, [0]);
  assert.equal(module.elements[0].refType, 0x70);
  assert.equal(module.elements[1].mode, 'passive');
  assert.equal(module.elements[1].refType, 0x70);
  assert.equal(module.elements[1].initializers.length, 2);
  assert.deepEqual(module.elements[1].functionIndices, []);
}

// Legacy index-vector forms 0..3 must not regress.
for (const [flags, payload, expected] of [
  [0x00, [0x01, 0x00, ...i32Zero, ...indexVector(0)], { mode: 'active', tableIndex: 0 }],
  [0x01, [0x01, 0x01, 0x00, ...indexVector(0)], { mode: 'passive', tableIndex: 0 }],
  [0x02, [0x01, 0x02, 0x00, ...i32Zero, 0x00, ...indexVector(0)], { mode: 'active', tableIndex: 0 }],
  [0x03, [0x01, 0x03, 0x00, ...indexVector(0)], { mode: 'declarative', tableIndex: 0 }],
]) {
  const bytes = wasm(funcrefType, oneFunction, funcrefTable(), section(9, payload), oneEmptyBody);
  const label = `legacy flags=${flags}`;
  const element = decode(bytes, label);
  assert.equal(element.mode, expected.mode, `${label}: mode`);
  assert.equal(element.tableIndex, expected.tableIndex, `${label}: table index`);
  assert.deepEqual(element.functionIndices, [0], `${label}: index vector`);
  assert.deepEqual(element.initializers, [], `${label}: no expression vector`);
  assert.equal(element.refType, 0x70, `${label}: func kind keeps the funcref type`);
}

// Malformed reftype / expression content stays fail-closed. V8 accepts a numeric
// reftype byte in a passive segment; the Core 3.0 grammar only allows reference
// types there, so the parser must still reject it.
const failClosed = [
  ['numeric reftype', wasm(section(9, [0x01, 0x05, 0x7f, 0x00])), /wasm-invalid-element-ref-type/],
  ['funcref form on externref table', wasm(externrefTable(), section(9, [0x01, 0x04, ...i32Zero, 0x00])), /wasm-invalid-element-table-type-mismatch/],
  ['truncated reftype', wasm(section(9, [0x01, 0x05])), /wasm-truncated-element-ref-type/],
  ['truncated initializer', wasm(section(9, [0x01, 0x05, 0x70, 0x01])), /wasm-truncated-const-expr/],
  ['non-constant initializer opcode', wasm(section(9, [0x01, 0x05, 0x70, 0x01, 0x6a, 0x0b])), /wasm-unsupported-const-expr-opcode/],
  ['unterminated initializer', wasm(section(9, [0x01, 0x05, 0x70, 0x01, 0x41, 0x00])), /wasm-truncated-const-expr/],
  ['vector longer than payload', wasm(section(9, [0x01, 0x05, 0x70, 0x02, 0xd0, 0x70, 0x0b])), /wasm-truncated-const-expr/],
  ['trailing segment bytes', wasm(section(9, [0x01, 0x05, 0x70, 0x00, 0x00])), /wasm-section-9-trailing-bytes/],
  ['flags outside the grammar', wasm(section(9, [0x01, 0x08])), /wasm-unsupported-element-flags-8/],
  ['legacy func kind on externref table', wasm(externrefTable(), section(9, [0x01, 0x00, ...i32Zero, ...indexVector()])), /wasm-invalid-element-table-type-mismatch/],
];
for (const [label, bytes, expected] of failClosed) {
  assert.throws(() => parseWasm(bytes), expected, `${label}: must fail closed`);
}

// Segment expressions connect to the existing constant-expression validator.
const validatorConnection = [
  ['externref initializer in funcref segment', wasm(section(9, [0x01, 0x05, 0x70, ...exprVector(refNull(0x6f))])), /wasm-invalid-const-expr-result-type/],
  ['out-of-range ref.func initializer', wasm(funcrefType, oneFunction, section(9, [0x01, 0x05, 0x70, ...exprVector(refFunc(3))]), oneEmptyBody), /wasm-invalid-const-expr-function-index/],
  ['non-i32 offset expression', wasm(funcrefTable(), section(9, [0x01, 0x04, ...f64Zero, ...exprVector(refNull(0x70))])), /wasm-invalid-const-expr-result-type/],
];
for (const [label, bytes, expected] of validatorConnection) {
  assert.equal(WebAssembly.validate(bytes), false, `${label}: fixture must be an invalid binary`);
  assert.throws(() => parseWasm(bytes), expected, `${label}: constant-expression validator must reject`);
}

// A ref.func initializer that resolves stays accepted.
{
  const bytes = wasm(funcrefType, oneFunction, section(9, [0x01, 0x05, 0x70, ...exprVector(refFunc(0))]), oneEmptyBody);
  const element = decode(bytes, 'passive ref.func');
  assert.equal(element.mode, 'passive');
  assert.equal(element.initializers[0].ops[0].opcode, 0xd2);
  assert.equal(element.initializers[0].ops[0].index, 0);
}

console.log('[phase11] ok: wasm element expression-vector forms #5045');

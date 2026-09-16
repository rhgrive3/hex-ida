import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

const HEADER = [0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00];
const section = (id, payload) => [id, payload.length, ...payload];
const wasm = (...sections) => Uint8Array.from([...HEADER, ...sections.flat()]);
const i32Zero = [0x41,0x00,0x0b];
const f64Zero = [0x44,0,0,0,0,0,0,0,0,0x0b];
const refNull = (type) => [0xd0,type,0x0b];
const refFunc = (index) => [0xd2,index,0x0b];
const exprs = (...values) => [values.length,...values.flat()];
const indices = (...values) => [values.length,...values];
const funcrefType = section(1,[0x01,0x60,0x00,0x00]);
const oneFunction = section(3,[0x01,0x00]);
const oneBody = section(10,[0x01,0x02,0x00,0x0b]);
const funcrefTable = section(4,[0x01,0x70,0x00,0x01]);
const externrefTable = section(4,[0x01,0x6f,0x00,0x01]);
const twoTables = section(4,[0x02,0x70,0x00,0x01,0x6f,0x00,0x01]);

function parseValid(bytes) {
  assert.equal(WebAssembly.validate(bytes), true);
  return parseWasm(bytes);
}

test('flags 4-7 expression-vector element forms decode', () => {
  const f5 = parseValid(wasm(section(9,[0x01,0x05,0x70,0x00]))).elements[0];
  assert.equal(f5.mode,'passive');
  assert.equal(f5.refType,0x70);
  assert.deepEqual(f5.initializers,[]);

  const f4 = parseValid(wasm(funcrefTable,section(9,[0x01,0x04,...i32Zero,...exprs(refNull(0x70))]))).elements[0];
  assert.equal(f4.mode,'active');
  assert.equal(f4.tableIndex,0);
  assert.equal(f4.refType,0x70);
  assert.equal(f4.initializers[0].ops[0].opcode,0xd0);

  const f6 = parseValid(wasm(twoTables,section(9,[0x01,0x06,0x01,...i32Zero,0x6f,...exprs(refNull(0x6f))]))).elements[0];
  assert.equal(f6.mode,'active');
  assert.equal(f6.tableIndex,1);
  assert.equal(f6.refType,0x6f);

  const f7 = parseValid(wasm(funcrefType,oneFunction,section(9,[0x01,0x07,0x70,...exprs(refFunc(0))]),oneBody)).elements[0];
  assert.equal(f7.mode,'declarative');
  assert.equal(f7.initializers[0].ops[0].index,0);
});

test('legacy flags 0-3 remain function-index vectors', () => {
  const cases = [
    [0x00,[0x01,0x00,...i32Zero,...indices(0)],'active'],
    [0x01,[0x01,0x01,0x00,...indices(0)],'passive'],
    [0x02,[0x01,0x02,0x00,...i32Zero,0x00,...indices(0)],'active'],
    [0x03,[0x01,0x03,0x00,...indices(0)],'declarative'],
  ];
  for (const [,payload,mode] of cases) {
    const el = parseValid(wasm(funcrefType,oneFunction,funcrefTable,section(9,payload),oneBody)).elements[0];
    assert.equal(el.mode,mode);
    assert.equal(el.refType,0x70);
    assert.deepEqual(el.functionIndices,[0]);
    assert.deepEqual(el.initializers,[]);
  }
});

test('malformed expression-vector forms fail closed', () => {
  const cases = [
    [wasm(section(9,[0x01,0x05,0x7f,0x00])),/wasm-invalid-element-ref-type/],
    [wasm(section(9,[0x01,0x05])),/wasm-truncated-element-ref-type/],
    [wasm(section(9,[0x01,0x05,0x70,0x01])),/wasm-truncated-const-expr/],
    [wasm(section(9,[0x01,0x05,0x70,0x01,0x6a,0x0b])),/wasm-unsupported-const-expr-opcode/],
    [wasm(section(9,[0x01,0x08])),/wasm-unsupported-element-flags-8/],
    [wasm(externrefTable,section(9,[0x01,0x04,...i32Zero,0x00])),/wasm-invalid-element-table-type-mismatch/],
  ];
  for (const [bytes,expected] of cases) assert.throws(() => parseWasm(bytes),expected);
});

test('element initializers use existing constant-expression validation', () => {
  assert.throws(
    () => parseWasm(wasm(section(9,[0x01,0x05,0x70,...exprs(refNull(0x6f))]))),
    /wasm-invalid-const-expr-result-type/,
  );
  assert.throws(
    () => parseWasm(wasm(funcrefType,oneFunction,section(9,[0x01,0x05,0x70,...exprs(refFunc(3))]),oneBody)),
    /wasm-invalid-const-expr-function-index/,
  );
  assert.throws(
    () => parseWasm(wasm(funcrefTable,section(9,[0x01,0x04,...f64Zero,...exprs(refNull(0x70))]))),
    /wasm-invalid-const-expr-result-type/,
  );
});

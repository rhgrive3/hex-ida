import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

console.log('[phase11] running Wasm element/table reference-type regression #4004...');

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const FUNCREF = 0x70;
const EXTERNREF = 0x6f;
const section = (id, payload) => [id, payload.length, ...payload];
const wasm = (...sections) => Uint8Array.from([...HEADER, ...sections.flat()]);
const typeSection = section(1, [0x01, 0x60, 0x00, 0x00]);
const functionImportEntry = [0x01, 0x6d, 0x01, 0x66, 0x00, 0x00]; // m.f : func type 0
const tableImportEntry = (elementType) => [0x01, 0x6d, 0x01, 0x74, 0x01, elementType, 0x00, 0x01];
const importSection = (...entries) => section(2, [entries.length, ...entries.flat()]);
const tableSection = (elementType) => section(4, [0x01, elementType, 0x00, 0x01]);
const i32Zero = [0x41, 0x00, 0x0b];
const legacyElement = ({ flags = 0, tableIndex = 0 } = {}) => section(9, [
  0x01,
  flags,
  ...(flags === 2 ? [tableIndex] : []),
  ...i32Zero,
  ...(flags === 2 ? [0x00] : []), // elemkind: funcref
  0x01, 0x00, // one function index: imported function 0
]);

function definedTableModule(elementType, flags = 0) {
  return wasm(
    typeSection,
    importSection(functionImportEntry),
    tableSection(elementType),
    legacyElement({ flags }),
  );
}

function importedTableModule(elementType, flags = 2) {
  return wasm(
    typeSection,
    importSection(functionImportEntry, tableImportEntry(elementType)),
    legacyElement({ flags }),
  );
}

for (const [label, bytes] of [
  ['defined table, implicit table 0', definedTableModule(FUNCREF, 0)],
  ['defined table, explicit table 0', definedTableModule(FUNCREF, 2)],
  ['imported table, implicit table 0', importedTableModule(FUNCREF, 0)],
  ['imported table, explicit table 0', importedTableModule(FUNCREF, 2)],
]) {
  assert.equal(WebAssembly.validate(bytes), true, `${label}: independent engine should accept funcref`);
  const parsed = parseWasm(bytes);
  assert.equal(parsed.elements[0].tableIndex, 0, `${label}: target table identity`);
  assert.deepEqual(parsed.elements[0].functionIndices, [0], `${label}: function-index vector`);
  assert.equal(parsed.elements[0].elementType, FUNCREF, `${label}: legacy index segment carries funcref authority`);
}

for (const [label, bytes] of [
  ['defined table, implicit table 0', definedTableModule(EXTERNREF, 0)],
  ['defined table, explicit table 0', definedTableModule(EXTERNREF, 2)],
  ['imported table, implicit table 0', importedTableModule(EXTERNREF, 0)],
  ['imported table, explicit table 0', importedTableModule(EXTERNREF, 2)],
]) {
  assert.equal(WebAssembly.validate(bytes), false, `${label}: independent engine rejects funcref -> externref`);
  assert.throws(
    () => parseWasm(bytes),
    (error) => error instanceof TypeError && error.message === 'wasm-element-table-type-mismatch',
    `${label}: parser must fail closed on element/table type mismatch`,
  );
}



function mixedTableModule(importedElementType, definedElementType) {
  return wasm(
    typeSection,
    importSection(functionImportEntry, tableImportEntry(importedElementType)),
    tableSection(definedElementType),
    legacyElement({ flags: 2, tableIndex: 1 }),
  );
}

const mixedValid = mixedTableModule(EXTERNREF, FUNCREF);
assert.equal(WebAssembly.validate(mixedValid), true, 'combined table index 1 resolves to the defined funcref table');
assert.doesNotThrow(() => parseWasm(mixedValid));
const mixedInvalid = mixedTableModule(FUNCREF, EXTERNREF);
assert.equal(WebAssembly.validate(mixedInvalid), false, 'combined table index 1 must not reuse imported table type');
assert.throws(
  () => parseWasm(mixedInvalid),
  (error) => error instanceof TypeError && error.message === 'wasm-element-table-type-mismatch',
  'combined table index resolves imported tables before defined tables',
);

const outOfRangeTable = wasm(
  typeSection,
  importSection(functionImportEntry),
  tableSection(FUNCREF),
  legacyElement({ flags: 2, tableIndex: 1 }),
);
assert.throws(
  () => parseWasm(outOfRangeTable),
  (error) => error instanceof TypeError && error.message === 'wasm-invalid-element-table-index',
  'existing element table-index bounds remain authoritative',
);

console.log('  ok Wasm element/table reference-type regression #4004 passed');

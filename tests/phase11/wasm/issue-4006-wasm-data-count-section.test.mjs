import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser-core.js';
import { parseWasm as parseWasmPublic } from '../../../js/managed/wasm/parser.js';

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function uleb32(value) {
  assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff);
  let remaining = value >>> 0;
  const out = [];
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    out.push(byte);
  } while (remaining !== 0);
  return out;
}

function section(id, payload) {
  return [id, ...uleb32(payload.length), ...payload];
}

function wasm(...sections) {
  return Uint8Array.from([...HEADER, ...sections.flat()]);
}


function oneVoidFunctionSections(bytecode) {
  return [
    section(1, [1, 0x60, 0, 0]), // one [] -> [] type
    section(3, [1, 0]),          // one function using type 0
    section(10, [1, bytecode.length + 1, 0, ...bytecode]), // no locals
  ];
}

const zeroDataCount = parseWasm(wasm(section(12, [0])));
assert.equal(zeroDataCount.dataCount, 0, 'Data Count=0 is a standard valid section and remains explicit evidence');
assert.deepEqual(zeroDataCount.dataSegments, []);
assert.equal(parseWasmPublic(wasm(section(12, [0]))).dataCount, 0, 'the public WASM open path accepts the same standard section');

const passiveOne = parseWasm(wasm(
  section(12, [1]),
  section(11, [1, 1, 0]), // one passive segment with zero bytes
));
assert.equal(passiveOne.dataCount, 1);
assert.equal(passiveOne.dataSegments.length, 1);
assert.equal(passiveOne.dataSegments[0].mode, 'passive');

for (const declared of [0, 2]) {
  assert.throws(
    () => parseWasm(wasm(section(12, [declared]), section(11, [1, 1, 0]))),
    /wasm-data-count-mismatch/,
    `Data Count=${declared} must not disagree with one actual data segment`,
  );
}

assert.throws(
  () => parseWasm(wasm(section(12, [0]), section(12, [0]))),
  /wasm-duplicate-section-12/,
  'Data Count is a standard singleton section',
);

const dataCountThenCodeThenData = parseWasm(wasm(
  section(12, [0]),
  section(10, [0]),
  section(11, [0]),
));
assert.equal(dataCountThenCodeThenData.dataCount, 0, 'standard Data Count -> Code -> Data ordering must be accepted');

assert.throws(
  () => parseWasm(wasm(section(10, [0]), section(12, [0]))),
  /wasm-out-of-order-section-12/,
  'Data Count after Code must be rejected even though section id 12 is numerically larger',
);
assert.throws(
  () => parseWasm(wasm(section(11, [0]), section(12, [0]))),
  /wasm-out-of-order-section-12/,
  'Data Count after Data must be rejected',
);


const memoryInit = [0xfc, 0x08, 0x00, 0x00, 0x0b]; // memory.init data 0, memory 0; end
const dataDrop = [0xfc, 0x09, 0x00, 0x0b];          // data.drop 0; end
const passiveSegment = section(11, [1, 1, 0]);

for (const instruction of [memoryInit, dataDrop]) {
  const [typeSection, functionSection, codeSection] = oneVoidFunctionSections(instruction);
  assert.doesNotThrow(() => parseWasm(wasm(
    typeSection,
    functionSection,
    section(12, [1]),
    codeSection,
    passiveSegment,
  )), 'data-index instructions may use an in-range index backed by Data Count');
  assert.throws(
    () => parseWasm(wasm(typeSection, functionSection, codeSection, passiveSegment)),
    /wasm-data-count-required/,
    'data-index instructions require Data Count evidence before Code',
  );
}

{
  const [typeSection, functionSection, codeSection] = oneVoidFunctionSections([
    0xfc, 0x09, 0x01, 0x0b, // data.drop 1 with declared count 1: out of range
  ]);
  assert.throws(
    () => parseWasm(wasm(typeSection, functionSection, section(12, [1]), codeSection, passiveSegment)),
    /wasm-invalid-data-index/,
    'Data Count is authoritative for dataidx bounds during single-pass code validation',
  );
}

console.log('[phase11] issue #4006 WebAssembly Data Count section regression passed');

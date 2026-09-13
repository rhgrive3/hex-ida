import assert from 'node:assert/strict';
import { parseWasm } from '../js/managed/wasm/parser.js';
import { parseWasm as parseWasmCore } from '../js/managed/wasm/parser-core.js';

console.log('[issue-4855] running WASM ref.null heaptype decoding regression...');

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const section = (id, payload) => [id, payload.length, ...payload];
const wasm = (...sections) => Uint8Array.from([...HEADER, ...sections.flat()]);

const I32 = 0x7f;
const I64 = 0x7e;
const F32 = 0x7d;
const F64 = 0x7c;
const V128 = 0x7b;
const NUM_OR_VEC_TYPES = [I32, I64, F32, F64, V128];
const ABSTRACT_HEAP_TYPES = [0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70, 0x71, 0x72, 0x73, 0x74];
const UNASSIGNED_NEGATIVES = [0x40, 0x68, 0x75, 0x7a];
const FUNC = 0x70;
const EXTERN = 0x6f;
const REF_NULL = 0xd0;
const END = 0x0b;

const funcTypes = (count) => {
  const payload = [count];
  for (let i = 0; i < count; i += 1) payload.push(0x60, 0x00, 0x00);
  return section(1, payload);
};
const refNullGlobal = (valType, heapTypeBytes) => section(6, [0x01, valType, 0x00, REF_NULL, ...heapTypeBytes, END]);
const refNullBodySections = (heapTypeBytes) => {
  const body = [0x00, REF_NULL, ...heapTypeBytes, END];
  return [funcTypes(1), section(3, [0x01, 0x00]), section(10, [0x01, body.length, ...body])];
};
const rejects = (code) => (error) => error instanceof TypeError && error.message === code;

for (const numOrVec of NUM_OR_VEC_TYPES) {
  const bytes = wasm(refNullGlobal(FUNC, [numOrVec]));
  assert.throws(
    () => parseWasm(bytes),
    rejects('wasm-invalid-ref-null-type'),
    `ref.null must not accept number/vector type 0x${numOrVec.toString(16)}`,
  );
  assert.throws(
    () => parseWasmCore(bytes),
    rejects('wasm-invalid-ref-null-type'),
    `the core grammar must reject number/vector type 0x${numOrVec.toString(16)} as a heap type`,
  );
}

for (const unassigned of UNASSIGNED_NEGATIVES) {
  assert.throws(
    () => parseWasmCore(wasm(refNullGlobal(FUNC, [unassigned]))),
    rejects('wasm-invalid-ref-null-type'),
    `ref.null must not accept unassigned heap type 0x${unassigned.toString(16)}`,
  );
}

assert.throws(
  () => parseWasmCore(wasm(...refNullBodySections([I32]))),
  rejects('wasm-invalid-ref-null-type'),
  'ref.null in a function body shares the same heap type grammar',
);

assert.throws(
  () => parseWasmCore(wasm(section(6, [0x01, FUNC, 0x00, REF_NULL]))),
  rejects('wasm-invalid-ref-null-type'),
  'a truncated ref.null immediate is rejected at the immediate',
);

assert.throws(
  () => parseWasmCore(wasm(refNullGlobal(FUNC, [END]))),
  rejects('wasm-invalid-ref-null-type-index'),
  'an end byte is a type-index heap type, so it must be range-checked',
);

for (const heapType of ABSTRACT_HEAP_TYPES) {
  assert.doesNotThrow(
    () => parseWasmCore(wasm(refNullGlobal(FUNC, [heapType]))),
    `abstract heap type 0x${heapType.toString(16)} must decode`,
  );
}

assert.throws(
  () => parseWasm(wasm(refNullGlobal(FUNC, [0x6e]))),
  rejects('wasm-invalid-const-expr-result-type'),
  'a decoded any heap type must not launder into a funcref global initializer',
);

assert.doesNotThrow(() => parseWasm(wasm(refNullGlobal(FUNC, [FUNC]))));
assert.doesNotThrow(() => parseWasm(wasm(refNullGlobal(EXTERN, [EXTERN]))));

{
  const module = parseWasm(wasm(refNullGlobal(FUNC, [FUNC])));
  assert.equal(module.globals[0].valType, FUNC);
  assert.deepEqual(module.globals[0].init.ops, [{ opcode: REF_NULL, refType: FUNC, typeIndex: null }]);
}

{
  const module = parseWasmCore(wasm(funcTypes(2), refNullGlobal(FUNC, [0x01])));
  assert.deepEqual(module.globals[0].init.ops, [{ opcode: REF_NULL, refType: null, typeIndex: 1 }]);
}

assert.throws(
  () => parseWasmCore(wasm(funcTypes(2), refNullGlobal(FUNC, [0x02]))),
  rejects('wasm-invalid-ref-null-type-index'),
  'a type-index heap type must be in range for the module type count',
);

assert.throws(
  () => parseWasmCore(wasm(...refNullBodySections([0x02]))),
  rejects('wasm-invalid-ref-null-type-index'),
  'a type-index heap type in a function body must be in range too',
);

assert.doesNotThrow(() => parseWasmCore(wasm(...refNullBodySections([0x00]))));
assert.doesNotThrow(() => parseWasmCore(wasm(...refNullBodySections([FUNC]))));

{
  const body = [0x01, 0x01, I32, 0x20, 0x00, END];
  assert.doesNotThrow(
    () => parseWasmCore(wasm(
      funcTypes(1),
      section(3, [0x01, 0x00]),
      section(6, [0x01, I32, 0x00, 0x41, 0x00, END]),
      section(10, [0x01, body.length, ...body]),
    )),
    'number value types must stay legal where the grammar is valtype-shaped',
  );
}

{
  const body = [0x00, 0x1c, 0x01, I32, END];
  assert.doesNotThrow(
    () => parseWasmCore(wasm(funcTypes(1), section(3, [0x01, 0x00]), section(10, [0x01, body.length, ...body]))),
    'select t* must keep accepting number type encodings',
  );
}

console.log('  ok issue-4855 WASM ref.null heaptype regression passed');

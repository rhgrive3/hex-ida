import assert from 'node:assert/strict';
import { liftWasmFunction } from '../js/managed/wasm/lifter.js';
import { liftWasmFunction as liftWasmFunctionCore } from '../js/managed/wasm/lifter-core.js';

console.log('[issue-4894] running WASM `if` without else implicit-else branch validation regression...');

const I32 = 0x7f;
const I64 = 0x7e;

function moduleWith(bytecode, types = [{ params: [], results: [] }]) {
  return {
    moduleId: 'wasm:issue-4894',
    imageId: 'image:issue-4894',
    formatVersion: 1,
    vmSpecEdition: 'core-1',
    imports: [],
    types,
    functions: [0],
    tables: [],
    globals: [],
    codeBodies: [{
      bodyOffset: 0,
      locals: [],
      bytecode: Uint8Array.from(bytecode),
    }],
    exports: [],
  };
}

const minimalCounterexample = [
  0x41, 0x01,
  0x04, I32,
  0x41, 0x2a,
  0x0b,
  0x1a,
  0x0b,
];

assert.throws(
  () => liftWasmFunctionCore(0, moduleWith(minimalCounterexample)),
  /wasm-invalid-if-without-else-type/,
  'a single-result `if` with no else must reject the empty implicit else branch in the lifter',
);

assert.throws(
  () => liftWasmFunction(0, moduleWith(minimalCounterexample)),
  /wasm-invalid-if-without-else-type/,
  'the public lift path must also reject the `if (result i32)` without else before promotion',
);

assert.throws(
  () => liftWasmFunctionCore(0, moduleWith([0x41, 0x01, 0x04, I32, 0x00, 0x0b, 0x1a, 0x0b])),
  /wasm-invalid-if-without-else-type/,
  'an unreachable then path does not rescue an else-less `if` that produces a result',
);

{
  const types = [{ params: [], results: [] }, { params: [], results: [I32, I32] }];
  assert.throws(
    () => liftWasmFunctionCore(0, moduleWith([0x41, 0x01, 0x04, 0x01, 0x41, 0x00, 0x41, 0x01, 0x0b, 0x1a, 0x1a, 0x0b], types)),
    /wasm-invalid-if-without-else-type/,
    'a multi-value else-less `if` must reject when the implicit else yields no values',
  );
}

assert.throws(
  () => liftWasmFunctionCore(0, moduleWith([0x41, 0x01, 0x04, I32, 0x41, 0x00, 0x05, 0x0b, 0x1a, 0x0b])),
  /wasm-invalid-block-result-stack/,
  'an explicit empty else that fails to produce the declared result is rejected',
);

assert.doesNotThrow(
  () => liftWasmFunctionCore(0, moduleWith([0x41, 0x01, 0x04, 0x40, 0x0b, 0x0b])),
  'a void `if` without else stays valid because the empty implicit else satisfies the block type',
);

assert.doesNotThrow(
  () => liftWasmFunctionCore(0, moduleWith([0x41, 0x01, 0x04, I32, 0x41, 0x2a, 0x05, 0x41, 0x00, 0x0b, 0x1a, 0x0b])),
  'a result `if` with an explicit else producing a value on both paths stays valid',
);

{
  const types = [{ params: [], results: [] }, { params: [I32], results: [I32] }];
  assert.doesNotThrow(
    () => liftWasmFunctionCore(0, moduleWith([0x41, 0x00, 0x41, 0x01, 0x04, 0x01, 0x0b, 0x1a, 0x0b], types)),
    'a parameterized block type whose implicit else forwards its single param remains spec-valid',
  );
}

{
  const voidIf = liftWasmFunction(0, moduleWith([0x41, 0x01, 0x04, 0x40, 0x0b, 0x0b]));
  assert.equal(voidIf.metadata.wasmSpecValidation, 'valid');
}

console.log('  ok WASM `if` without else implicit-else branch validation regression passed');

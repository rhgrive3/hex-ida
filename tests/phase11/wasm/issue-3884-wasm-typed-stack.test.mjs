import assert from 'node:assert/strict';
import { WasmFrontend } from '../../../js/managed/wasm/frontend.js';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';

console.log('[phase11] running WASM typed operand-stack regression for #3884...');

const I32 = 0x7f;
const I64 = 0x7e;

function moduleWith(bytecode, options = {}) {
  const types = options.types ?? [{ params: [], results: [] }];
  const functions = options.functions ?? [0];
  const codeBodies = options.codeBodies ?? [{
    bodyOffset: 0,
    locals: options.locals ?? [],
    bytecode: Uint8Array.from(bytecode),
  }];
  return {
    moduleId: 'wasm:issue-3884',
    imageId: 'image:issue-3884',
    formatVersion: 1,
    vmSpecEdition: 'core-1',
    imports: options.imports ?? [],
    types,
    functions,
    tables: options.tables ?? [],
    globals: options.globals ?? [],
    codeBodies,
    exports: [],
  };
}

assert.throws(
  () => liftWasmFunction(0, moduleWith([0x41, 0x00, 0x41, 0x00, 0x7c, 0x1a, 0x0b])),
  /wasm-stack-type-mismatch/,
  'two i32 values cannot satisfy i64.add merely because the stack height balances',
);

const validI64 = liftWasmFunction(0, moduleWith([0x42, 0x00, 0x42, 0x00, 0x7c, 0x1a, 0x0b]));
assert.equal(validI64.metadata.wasmSpecValidation, 'valid');

{
  const types = [
    { params: [], results: [] },
    { params: [I64], results: [] },
  ];
  const codeBodies = [
    { bodyOffset: 0, locals: [], bytecode: Uint8Array.from([0x41, 0x00, 0x10, 0x01, 0x0b]) },
    { bodyOffset: 0, locals: [], bytecode: Uint8Array.from([0x0b]) },
  ];
  assert.throws(
    () => liftWasmFunction(0, moduleWith([], { types, functions: [0, 1], codeBodies })),
    /wasm-stack-type-mismatch/,
    'direct call parameters must use the callee signature types',
  );
}

assert.throws(
  () => liftWasmFunction(0, moduleWith([0x02, I64, 0x41, 0x00, 0x0b, 0x1a, 0x0b])),
  /wasm-stack-type-mismatch/,
  'a balanced block stack still must match the block result type',
);

assert.throws(
  () => liftWasmFunction(0, moduleWith([0x41, 0x00, 0x21, 0x00, 0x0b], { locals: [I64] })),
  /wasm-stack-type-mismatch/,
  'local.set must consume the declared local type',
);

assert.doesNotThrow(
  () => liftWasmFunction(0, moduleWith([0x00, 0x7c, 0x1a, 0x0b])),
  'unreachable code keeps the WASM polymorphic-bottom stack rule',
);

assert.throws(
  () => liftWasmFunction(0, moduleWith([0x42, 0x00, 0x41, 0x00, 0x41, 0x01, 0x1b, 0x1a, 0x0b])),
  /wasm-stack-type-mismatch/,
  'select operands must agree on their value type',
);

{
  const partial = liftWasmFunction(0, moduleWith([0x41, 0x00, 0x67, 0x1a, 0x0b]));
  assert.equal(partial.aggregateCompleteness, 'partial');
  assert.equal(partial.metadata.wasmSpecValidation, 'partial');
  const validation = await new WasmFrontend().validateMethod(partial);
  assert.equal(validation.completeness.specValidation, 'partial');
  assert.equal(validation.completeness.semanticEffect, 'partial');
}

console.log('  ok WASM typed operand-stack regression passed');

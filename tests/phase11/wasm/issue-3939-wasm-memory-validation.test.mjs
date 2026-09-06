import assert from 'node:assert/strict';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import {
  createWasmMemoryValidationContext,
  resolveWasmMemory,
  validateWasmMemoryInstruction,
} from '../../../js/managed/wasm/memory-validation.js';

console.log('[phase11] running WASM memory instruction validation regression for #3939...');

const I32 = 0x7f;

function memory32(overrides = {}) {
  return { min: 1, max: null, shared: false, flags: 0, ...overrides };
}

function moduleWith(bytecode, options = {}) {
  return {
    moduleId: 'wasm:issue-3939',
    imageId: 'image:issue-3939',
    formatVersion: '1',
    vmSpecEdition: 'core-3.0',
    imports: options.imports ?? [],
    types: [{ params: [], results: [] }],
    functions: [0],
    tables: [],
    memories: options.memories ?? [],
    globals: [],
    codeBodies: [{ bodyOffset: 0, locals: [], bytecode: Uint8Array.from(bytecode) }],
    exports: [],
  };
}

const i32Load = (align) => [0x41, 0x00, 0x28, align, 0x00, 0x1a, 0x0b];
const i32Store = (align) => [0x41, 0x00, 0x41, 0x00, 0x36, align, 0x00, 0x0b];

assert.throws(
  () => liftWasmFunction(0, moduleWith(i32Load(2))),
  /wasm-invalid-memory-index/,
  'a load cannot publish an exact linear-memory effect when memory 0 does not exist',
);
assert.throws(
  () => liftWasmFunction(0, moduleWith(i32Store(2))),
  /wasm-invalid-memory-index/,
  'a store cannot publish an exact linear-memory effect when memory 0 does not exist',
);
assert.throws(
  () => liftWasmFunction(0, moduleWith(i32Load(3), { memories: [memory32()] })),
  /wasm-invalid-memory-alignment/,
  'i32.load rejects an alignment exponent above its natural alignment',
);
assert.throws(
  () => liftWasmFunction(0, moduleWith(i32Store(3), { memories: [memory32()] })),
  /wasm-invalid-memory-alignment/,
  'i32.store rejects an alignment exponent above its natural alignment',
);

const validLoad = liftWasmFunction(0, moduleWith(i32Load(2), { memories: [memory32()] }));
assert.equal(validLoad.aggregateCompleteness, 'exact');
assert.equal(validLoad.metadata.wasmSpecValidation, 'valid');
assert.equal(validLoad.bundles.find((bundle) => bundle.opcode === 0x28)?.memoryEffects.length, 1);
const validStore = liftWasmFunction(0, moduleWith(i32Store(2), { memories: [memory32()] }));
assert.equal(validStore.aggregateCompleteness, 'exact');
assert.equal(validStore.metadata.wasmSpecValidation, 'valid');
assert.equal(validStore.bundles.find((bundle) => bundle.opcode === 0x36)?.memoryEffects.length, 1);

assert.doesNotThrow(() => liftWasmFunction(0, moduleWith(i32Load(2), {
  imports: [{ module: 'env', field: 'memory', desc: { kind: 2, ...memory32() } }],
})), 'imported memory 0 is valid memory authority');

assert.throws(
  () => liftWasmFunction(0, moduleWith(i32Load(2), { memories: [memory32({ addressType: 'i64' })] })),
  /wasm-unsupported-memory-address-type/,
  'memory64 remains fail-closed until its parser/lifter profile is implemented',
);
assert.throws(
  () => liftWasmFunction(0, moduleWith(i32Load(2), { memories: [{ min: 1, max: null, shared: false }] })),
  /wasm-memory-address-type-unresolved/,
  'a synthetic/foreign descriptor without a proven address width is not trusted',
);
assert.throws(
  () => liftWasmFunction(0, moduleWith(i32Load(2), { memories: [memory32({ addressType: 'i32', indexType: 'i64' })] })),
  /wasm-conflicting-memory-address-type/,
  'conflicting address-width witnesses fail closed',
);
assert.throws(
  () => liftWasmFunction(0, moduleWith(i32Load(2), { memories: [memory32({ addressType: 'i32', flags: 4 })] })),
  /wasm-conflicting-memory-address-type/,
  'an explicit i32 type cannot override a non-memory32 limits encoding',
);

const alignments = new Map([
  [0x28, 2], [0x29, 3], [0x2a, 2], [0x2b, 3],
  [0x2c, 0], [0x2d, 0], [0x2e, 1], [0x2f, 1],
  [0x36, 2], [0x37, 3], [0x38, 2], [0x39, 3], [0x3a, 0], [0x3b, 1],
]);
const context = createWasmMemoryValidationContext(moduleWith([0x0b], { memories: [memory32()] }));
for (const [opcode, maxAlign] of alignments) {
  const valid = validateWasmMemoryInstruction(context, opcode, maxAlign, 0);
  assert.equal(valid.memoryIndex, 0);
  assert.equal(valid.addressType, I32);
  assert.equal(valid.naturalAlign, maxAlign);
  assert.throws(
    () => validateWasmMemoryInstruction(context, opcode, maxAlign + 1, 0),
    /wasm-invalid-memory-alignment/,
    `opcode 0x${opcode.toString(16)} rejects align exponent ${maxAlign + 1}`,
  );
}

const multiMemoryContext = createWasmMemoryValidationContext(moduleWith([0x0b], {
  imports: [{ module: 'env', field: 'm0', desc: { kind: 2, ...memory32({ min: 2 }) } }],
  memories: [memory32({ min: 3 })],
}));
assert.equal(resolveWasmMemory(multiMemoryContext, 0).memoryIndex, 0);
assert.equal(resolveWasmMemory(multiMemoryContext, 1).memoryIndex, 1);
assert.throws(() => resolveWasmMemory(multiMemoryContext, 2), /wasm-invalid-memory-index/);

const controller = new AbortController();
controller.abort();
assert.throws(
  () => liftWasmFunction(0, moduleWith(i32Load(2), { memories: [memory32()] }), { signal: controller.signal }),
  (error) => error?.name === 'AbortError' && error?.message === 'wasm-validation-cancelled',
  'cancellation still prevents validation/lifting from publishing a result',
);

console.log('  ok WASM memory instruction validation regression passed');

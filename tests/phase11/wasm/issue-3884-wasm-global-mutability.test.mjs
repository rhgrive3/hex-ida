import assert from 'node:assert/strict';
import { validateWasmFunctionTypes } from '../../../js/managed/wasm/validator.js';

console.log('[phase11] running WASM global mutability validation regression for #3884...');

const I32 = 0x7f;
const globalSet0 = [0x41, 0x00, 0x24, 0x00, 0x0b];

function moduleWithGlobals({ imports = [], globals = [] } = {}) {
  return {
    moduleId: 'wasm:issue-3884-global-mutability',
    imageId: 'image:issue-3884-global-mutability',
    formatVersion: 1,
    vmSpecEdition: 'core-1',
    imports,
    types: [{ params: [], results: [] }],
    functions: [0],
    tables: [],
    globals,
    codeBodies: [{ bodyOffset: 0, locals: [], bytecode: Uint8Array.from(globalSet0) }],
    exports: [],
  };
}

assert.throws(
  () => validateWasmFunctionTypes(0, moduleWithGlobals({ globals: [{ valType: I32, mutable: false }] })),
  /wasm-write-immutable-global/,
  'global.set must reject a defined immutable global before consuming its value',
);

assert.throws(
  () => validateWasmFunctionTypes(0, moduleWithGlobals({
    imports: [{ module: 'env', field: 'g', desc: { kind: 3, valType: I32, mutable: false } }],
  })),
  /wasm-write-immutable-global/,
  'global.set must reject an imported immutable global before consuming its value',
);

assert.equal(
  validateWasmFunctionTypes(0, moduleWithGlobals({ globals: [{ valType: I32, mutable: true }] })).complete,
  true,
  'global.set remains valid for a defined mutable global',
);

assert.equal(
  validateWasmFunctionTypes(0, moduleWithGlobals({
    imports: [{ module: 'env', field: 'g', desc: { kind: 3, valType: I32, mutable: true } }],
  })).complete,
  true,
  'global.set remains valid for an imported mutable global',
);

console.log('  ok WASM global mutability validation regression passed');

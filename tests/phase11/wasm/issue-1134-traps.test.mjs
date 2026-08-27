import assert from 'node:assert/strict';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';

function mod(bytecode) {
  return {
    moduleId: 'module_test', vmSpecEdition: 'wasm-test', imports: [], functions: [0],
    types: [{ params: [], results: [] }],
    codeBodies: [{ bodyOffset: 100, locals: [], bytecode: Uint8Array.from(bytecode) }],
  };
}

const divu = liftWasmFunction(0, mod([0x41,1,0x41,0,0x6e,0x0b])).bundles.find((b)=>b.mnemonic==='i32.div_u');
assert.deepEqual(divu.possibleExceptions, [{ kind:'integer-divide-by-zero', condition:'rhs==0' }]);
assert.equal(divu.completeness, 'exact');

const divs = liftWasmFunction(0, mod([0x41,1,0x41,1,0x6d,0x0b])).bundles.find((b)=>b.mnemonic==='i32.div_s');
assert.deepEqual(divs.possibleExceptions.map((e)=>e.kind), ['integer-divide-by-zero','integer-divide-overflow']);

const load = liftWasmFunction(0, mod([0x41,0,0x28,0,0,0x1a,0x0b])).bundles.find((b)=>b.mnemonic==='i32.load');
assert.equal(load.possibleExceptions[0].kind, 'linear-memory-oob');
assert.equal(load.possibleExceptions[0].condition, 'effectiveAddress+4>memorySize');

const store = liftWasmFunction(0, mod([0x41,0,0x41,0,0x36,0,0,0x0b])).bundles.find((b)=>b.mnemonic==='i32.store');
assert.equal(store.possibleExceptions[0].kind, 'linear-memory-oob');
console.log('issue #1134 wasm trap effects PASS');

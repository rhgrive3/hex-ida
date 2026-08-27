import assert from 'node:assert/strict';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

console.log('[phase11] running wasm VMEffects tests...');

const wasmBytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  // Type: (func (param i32 i32) (result i32))
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  // Function: type 0
  0x03, 0x02, 0x01, 0x00,
  // Export: "test"
  0x07, 0x08, 0x01, 0x04, 0x74, 0x65, 0x73, 0x74, 0x00, 0x00,
  // Code:
  //   local.get 0
  //   local.get 1
  //   i32.add
  //   i32.const 5
  //   i32.mul
  //   return
  //   end
  0x0a, 0x0d, 0x01, 0x0b, 0x00,
  0x20, 0x00,
  0x20, 0x01,
  0x6a,
  0x41, 0x05,
  0x6c,
  0x0f,
  0x0b,
]);

const parsed = parseWasm(wasmBytes);
const vmFn = liftWasmFunction(0, parsed);

assert.equal(vmFn.frontendId, 'wasm');
assert.equal(vmFn.bundles.length, 7);
assert.equal(vmFn.aggregateCompleteness, 'exact');
assert.equal(vmFn.bundles[0].mnemonic, 'local.get');
assert.equal(vmFn.bundles[0].locationReads[0].kind, 'local');
assert.equal(vmFn.bundles[0].locationReads[0].index, 0);
assert.equal(vmFn.bundles[1].mnemonic, 'local.get');
assert.equal(vmFn.bundles[1].locationReads[0].index, 1);
assert.equal(vmFn.bundles[2].mnemonic, 'i32.add');
assert.equal(vmFn.bundles[2].consumedValues.length, 2);
assert.equal(vmFn.bundles[2].producedValues.length, 1);
assert.equal(vmFn.bundles[3].mnemonic, 'i32.const');
assert.equal(vmFn.bundles[3].producedValues[0].constant, 5);
assert.deepEqual(vmFn.bundles[0].origin.byteRanges, [{ start:'34', end:'36' }], 'local.get origin includes its index immediate');
assert.deepEqual(vmFn.bundles[2].origin.byteRanges, [{ start:'38', end:'39' }], 'single-byte op origin remains one byte');
assert.deepEqual(vmFn.bundles[3].origin.byteRanges, [{ start:'39', end:'41' }], 'i32.const origin includes its SLEB immediate');

const immediateModule = {
  ...parsed,
  imports:[],
  functions:[0],
  types:[{ params:[], results:[] }],
  codeBodies:[{
    ...parsed.codeBodies[0],
    bodyOffset:100,
    locals:[],
    bytecode:new Uint8Array([
      0x41, 0x80, 0x01,
      0x10, 0x80, 0x00,
      0x28, 0x02, 0x80, 0x01,
      0x0e, 0x02, 0x00, 0x80, 0x00, 0x00,
      0x01,
      0x0b,
    ]),
  }],
};
const immediateFn = liftWasmFunction(0, immediateModule);
assert.deepEqual(immediateFn.bundles.map((bundle) => bundle.origin.byteRanges[0]), [
  { start:'100', end:'103' },
  { start:'103', end:'106' },
  { start:'106', end:'110' },
  { start:'110', end:'116' },
  { start:'116', end:'117' },
  { start:'117', end:'118' },
]);

assert.equal(vmFn.bundles[4].mnemonic, 'i32.mul');
assert.equal(vmFn.bundles[5].mnemonic, 'return');
assert.equal(vmFn.bundles[5].controlEffects[0].kind, 'return');

console.log('  ok wasm VMEffects tests passed');

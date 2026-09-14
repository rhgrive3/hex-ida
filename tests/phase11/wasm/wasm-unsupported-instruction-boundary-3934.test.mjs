import assert from 'node:assert/strict';
import { liftWasmFunction as liftWasmFunctionCore } from '../../../js/managed/wasm/lifter-core.js';

console.log('[phase11] running WASM unsupported-instruction boundary regression for #3934...');

function moduleWith(bytecode, bodyOffset = 100) {
  return {
    moduleId: 'wasm:issue-3934',
    imageId: 'image:issue-3934',
    formatVersion: 1,
    vmSpecEdition: 'core-1',
    imports: [],
    types: [{ params: [], results: [] }],
    functions: [0],
    tables: [],
    globals: [],
    codeBodies: [{
      bodyOffset,
      locals: [],
      bytecode: Uint8Array.from(bytecode),
    }],
    exports: [],
  };
}

{
  const lifted = liftWasmFunctionCore(0, moduleWith([
    0x43, 0x01, 0x00, 0x00, 0x00, // unsupported f32.const + four-byte immediate
    0x1a,                         // must not become a later exact effect
    0x0b,
  ]));

  assert.equal(lifted.aggregateCompleteness, 'partial');
  assert.equal(lifted.bundles.length, 1, 'semantic lifting stops at the first unsupported instruction');
  assert.equal(lifted.bundles[0].opcode, 0x43);
  assert.equal(lifted.bundles[0].mnemonic, 'f32.const');
  assert.equal(lifted.bundles[0].completeness, 'partial');
  assert.deepEqual(lifted.bundles[0].origin.byteRanges, [{ start: '100', end: '105' }]);
  assert.equal(lifted.bundles[0].controlEffects.length, 0, 'immediate 0x00 bytes must not fabricate unreachable traps');
  assert.ok(lifted.bundles[0].unknownEffects.some((effect) => effect.reason === 'semantic-lifting-stopped-after-unsupported-instruction'));
}

{
  const lifted = liftWasmFunctionCore(0, moduleWith([
    0x44,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // f64 immediate
    0x01, 0x0b,
  ], 200));

  assert.equal(lifted.bundles.length, 1);
  assert.equal(lifted.bundles[0].opcode, 0x44);
  assert.deepEqual(lifted.bundles[0].origin.byteRanges, [{ start: '200', end: '209' }]);
}

{
  const lifted = liftWasmFunctionCore(0, moduleWith([
    0x43, 0x01, 0x00, // truncated f32.const immediate
  ], 300));

  assert.equal(lifted.aggregateCompleteness, 'partial');
  assert.equal(lifted.bundles.length, 1);
  assert.deepEqual(lifted.bundles[0].origin.byteRanges, [{ start: '300', end: '303' }]);
  assert.ok(lifted.bundles[0].unknownEffects.some((effect) => effect.reason === 'unsupported-instruction-boundary-unresolved'));
}

{
  const lifted = liftWasmFunctionCore(0, moduleWith([
    0xfc, 0x00, 0x00, 0x01, 0x0b,
  ], 400));

  assert.equal(lifted.aggregateCompleteness, 'partial');
  assert.equal(lifted.bundles.length, 1, 'unknown prefixed instruction must stop before subopcode/immediates can be reinterpreted');
  assert.equal(lifted.bundles[0].opcode, 0xfc);
  assert.ok(lifted.bundles[0].unknownEffects.some((effect) => effect.reason === 'unsupported-instruction-boundary-unresolved'));
}

{
  const exact = liftWasmFunctionCore(0, moduleWith([
    0x41, 0x00,
    0x1a,
    0x0b,
  ], 500));

  assert.equal(exact.aggregateCompleteness, 'exact');
  assert.deepEqual(exact.bundles.map((bundle) => bundle.mnemonic), ['i32.const', 'drop', 'end']);
}

console.log('  ok WASM unsupported-instruction boundary regression passed');

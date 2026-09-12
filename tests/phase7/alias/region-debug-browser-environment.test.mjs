import assert from 'node:assert/strict';
import { classifySemanticMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';

// The pointer-refinement diagnostic must not require Node globals in a
// browser Worker, nor turn absent canonical producer evidence into precision.
const origin = { instructionIds: ['instruction:browser-region'] };
const ir = {
  functionId: 'function:browser-region', origin,
  values: [{ id: 'pointer', kind: 'address' }],
  nodes: [{ id: 'load', kind: 'load', origin,
    memory: { addressSpace: 'memory', widthBits: 64, addressExpr: { valueId: 'pointer' } } }],
};
const expected = classifySemanticMemoryRegion(ir, 'load');
assert.equal(expected.kind, 'unknown');
const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
const diagnostics = [];
try {
  delete globalThis.process;
  assert.deepEqual(classifySemanticMemoryRegion(ir, 'load'), expected);
  for (const environment of [undefined, null, {}, { env: { HEX_DEBUG_C2_POINTER: '1' } },
    { env: { HEX_DEBUG_C2_POINTER: '1' }, stderr: { write: (text) => diagnostics.push(text) } }]) {
    Object.defineProperty(globalThis, 'process', { configurable: true, writable: true, value: environment });
    assert.deepEqual(classifySemanticMemoryRegion(ir, 'load'), expected,
      'diagnostic availability must not change conservative memory classification');
  }
} finally {
  if (processDescriptor) Object.defineProperty(globalThis, 'process', processDescriptor);
  else delete globalThis.process;
}
assert.ok(diagnostics.length > 0, 'explicit Node diagnostics still work when the sink exists');
console.log('memory-region pointer diagnostics in browser/Node environments: PASS');

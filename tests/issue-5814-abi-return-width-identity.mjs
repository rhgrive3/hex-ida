// Regression for #5814: ABI return publication must not Number()-coerce
// structured width metadata. `bits`, `bytes`, and hidden-sret `pointerBits`
// are exact placement evidence and accept primitive numbers only; a
// structured value (['32']) must fail closed instead of publishing exact
// return locations.
import assert from 'node:assert/strict';
import { semanticAbiAdapter } from '../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../js/targets/abi/index.js';

const adapter = semanticAbiAdapter(AAPCS64_ABI, { architecture: 'arm64' });

// Scalar return: structured bits are rejected.
const valid = adapter.classifyFunctionReturn({ functionPrototype: { returnType: 'int', bits: 32 } });
assert.equal(valid.reg, 'x0');
assert.deepEqual(adapter.returnLocations({ classified: { ...valid, bits: ['32'] }, returnType: 'int' }), [],
  "structured bits ['32'] must not publish an exact scalar return location");
assert.deepEqual(adapter.returnLocations({ classified: { ...valid, bytes: ['4'] }, returnType: 'int' }), [],
  "structured bytes ['4'] must not publish an exact scalar return location");
assert.equal(adapter.returnLocations({ classified: valid, returnType: 'int' }).length, 1,
  'primitive widths keep publishing the exact location');

// Hidden sret: structured pointerBits are rejected.
const indirect = adapter.classifyFunctionReturn({ functionPrototype: {
  returnType: 'struct Big', aggregate: true, returnBits: 512, indirectResult: true,
  members: Array.from({ length: 8 }, (_unused, index) => ({ type: 'uint64_t', bits: 64, byteOffset: index * 8 })),
} });
assert.equal(indirect.indirect, true);
assert.deepEqual(adapter.returnLocations({ classified: { ...indirect, hiddenResultPointer: { ...indirect.hiddenResultPointer, pointerBits: ['64'] } }, returnType: 'struct Big' }), [],
  "structured pointerBits ['64'] must not publish an indirect return location");
const indirectLocations = adapter.returnLocations({ classified: indirect, returnType: 'struct Big' });
assert.equal(indirectLocations.length, 1);
assert.equal(indirectLocations[0].kind, 'indirect', 'primitive pointerBits keep publishing the indirect location');

console.log('issue #5814 ABI return width identity: PASS');

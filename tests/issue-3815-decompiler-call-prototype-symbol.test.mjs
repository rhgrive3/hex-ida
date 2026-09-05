import assert from 'node:assert/strict';
import {
  normalizeExternalSymbol,
  knownCallPrototype,
  callArgumentIndices,
} from '../js/decompiler/call-prototypes.js';

for (const [input, normalized] of [
  ['malloc', 'malloc'],
  ['_malloc', 'malloc'],
  ['imp_malloc', 'malloc'],
  ['j_malloc', 'malloc'],
  ['_memcpy@@GLIBC_2.17', 'memcpy'],
]) assert.equal(normalizeExternalSymbol(input), normalized);

const forgedValues = [
  ['malloc'],
  { toString() { return 'malloc'; } },
  { [Symbol.toPrimitive]() { return 'memcpy'; } },
  123,
  true,
  Symbol('malloc'),
];
for (const name of forgedValues) {
  assert.equal(knownCallPrototype(name), null, 'structured/non-string callee identity must stay unknown');
  assert.equal(callArgumentIndices({ name }), null, 'structured/non-string callee identity must not mint argument-count evidence');
}

assert.deepEqual(knownCallPrototype('_malloc'), {
  name: 'malloc', arity: 1, variadic: false, confidence: 1,
});
assert.deepEqual(callArgumentIndices({ name: 'j_memcpy' }), [0, 1, 2]);

console.log('issue-3815 regression: PASS');

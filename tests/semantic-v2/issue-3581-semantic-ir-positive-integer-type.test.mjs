import assert from 'node:assert/strict';
import { budgetLimit } from '../../js/semantics/ir/common.js';
import { createSemanticMachineType, createSemanticMemoryAccess } from '../../js/semantics/ir/types.js';

const invalidPositiveIntegers = [
  ['64'],
  '64',
  true,
  64n,
  new Number(64),
  { value: 64 },
  1.5,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  0,
  -1,
];

assert.deepEqual(
  createSemanticMachineType({ kind: 'bitvector', widthBits: 64 }),
  { kind: 'bitvector', widthBits: 64 },
);
assert.deepEqual(
  createSemanticMachineType({
    kind: 'vector',
    laneCount: 4,
    elementType: { kind: 'bitvector', widthBits: 32 },
  }),
  { kind: 'vector', laneCount: 4, elementType: { kind: 'bitvector', widthBits: 32 } },
);

for (const value of invalidPositiveIntegers) {
  assert.throws(
    () => createSemanticMachineType({ kind: 'bitvector', widthBits: value }),
    /semantic-ir-invalid-width/,
  );
}

let coercionCalls = 0;
const coercibleWidth = {
  valueOf() { coercionCalls += 1; return 64; },
  toString() { coercionCalls += 1; return '64'; },
};
assert.throws(
  () => createSemanticMachineType({ kind: 'bitvector', widthBits: coercibleWidth }),
  /semantic-ir-invalid-width/,
);
assert.equal(coercionCalls, 0);

const access = createSemanticMemoryAccess({
  addressSpace: 'ram',
  addressExpr: { valueId: 'addr' },
  widthBits: 32,
  endian: 'little',
  alignment: 4,
});
assert.equal(access.widthBits, 32);
assert.equal(access.alignment, 4);
assert.throws(
  () => createSemanticMemoryAccess({
    addressSpace: 'ram',
    addressExpr: { valueId: 'addr' },
    widthBits: ['32'],
    endian: 'little',
    alignment: 4,
  }),
  /semantic-ir-invalid-memory-width/,
);
assert.throws(
  () => createSemanticMemoryAccess({
    addressSpace: 'ram',
    addressExpr: { valueId: 'addr' },
    widthBits: 32,
    endian: 'little',
    alignment: ['4'],
  }),
  /semantic-ir-invalid-memory-alignment/,
);

assert.equal(budgetLimit({ budget: { maxNodes: 1 } }, 'maxNodes'), 1);
assert.throws(
  () => budgetLimit({ budget: { maxNodes: ['1'] } }, 'maxNodes'),
  /semantic-ir-invalid-budget-maxNodes/,
);
assert.throws(
  () => budgetLimit({ budget: { maxNodes: '1' } }, 'maxNodes'),
  /semantic-ir-invalid-budget-maxNodes/,
);

console.log('issue 3581 semantic IR positive integer type boundary: PASS');

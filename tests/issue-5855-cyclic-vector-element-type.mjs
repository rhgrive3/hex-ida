import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticMachineType } from '../js/semantics/ir/types.js';

test('#5855 a self-referential vector elementType fails closed, not with a stack overflow', () => {
  const type = { kind: 'vector', laneCount: 1 };
  type.elementType = type;
  assert.throws(
    () => createSemanticMachineType(type),
    (err) => err.message === 'semantic-ir-invalid-vector-element-type',
  );
});

test('#5855 valid flat and one-level-nested vectors keep working', () => {
  const flat = createSemanticMachineType({ kind: 'vector', laneCount: 4, elementType: { kind: 'bitvector', widthBits: 32 } });
  assert.equal(flat.elementType.widthBits, 32);
  const predicateElem = createSemanticMachineType({
    kind: 'vector', laneCount: 2,
    elementType: { kind: 'predicate', widthBits: 8, laneCount: 4 },
  });
  assert.equal(predicateElem.elementType.kind, 'predicate');
});


test('#5855 deeply nested vector chains reject before recursive descent', () => {
  let elementType = { kind: 'bitvector', widthBits: 8 };
  for (let depth = 0; depth < 10_000; depth++) {
    elementType = { kind: 'vector', laneCount: 1, elementType };
  }
  assert.throws(
    () => createSemanticMachineType(elementType),
    (err) => err.message === 'semantic-ir-invalid-vector-element-type',
  );
});
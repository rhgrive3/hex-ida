import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticMachineType } from '../js/semantics/ir/types.js';
import { createMachineValue } from '../js/semantics/effects/index.js';

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

  const machineVector = createMachineValue({
    kind: 'vector', laneCount: 2,
    elementType: { kind: 'bitvector', widthBits: 32 },
  });
  assert.equal(machineVector.elementType.kind, 'bitvector');
});

test('#5855 Semantic IR and MachineEffects reject bounded nested vectors before descent', () => {
  let semanticType = { kind: 'bitvector', widthBits: 8 };
  let machineType = { kind: 'bitvector', widthBits: 8 };
  for (let depth = 0; depth < 64; depth++) {
    semanticType = { kind: 'vector', laneCount: 1, elementType: semanticType };
    machineType = { kind: 'vector', laneCount: 1, elementType: machineType };
  }
  assert.throws(
    () => createSemanticMachineType(semanticType),
    (err) => err.message === 'semantic-ir-invalid-vector-element-type',
  );
  assert.throws(
    () => createMachineValue(machineType),
    (err) => err.message === 'machine-effects-invalid-vector-element-type',
  );

  const machineCycle = { kind: 'vector', laneCount: 1 };
  machineCycle.elementType = machineCycle;
  assert.throws(
    () => createMachineValue(machineCycle),
    (err) => err.message === 'machine-effects-invalid-vector-element-type',
  );
});

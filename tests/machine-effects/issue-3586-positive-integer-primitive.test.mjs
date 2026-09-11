import assert from 'node:assert/strict';

import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMemoryAccess,
  createVectorValue,
} from '../../js/semantics/effects/index.js';

const instructionId = createInstructionId({
  binaryId: 'machine-effects-3586',
  sliceId: 'machine-effects-3586',
  virtualAddress: 0x1000n,
  decodeMode: 'a64',
  decoderSemanticVersion: '1',
});
const origin = {
  instructionIds: [instructionId],
  byteRanges: [{ binaryId: 'machine-effects-3586', start: 0n, end: 4n }],
};
const bundle = {
  instructionId,
  architectureId: 'arm64',
  mode: 'a64',
  operations: [],
  controlEffect: { kind: 'fallthrough' },
  possibleFaults: [],
  origin,
  completeness: 'exact',
  statePreservation: { proven: true, reason: 'test no-op' },
};

const coercibleValues = [
  '8',
  ['8'],
  true,
  { valueOf: () => 8 },
];

for (const value of coercibleValues) {
  assert.throws(
    () => createBitVectorValue(value),
    (error) => error?.message === 'machine-effects-invalid-bitvector-width',
    `bitvector width ${JSON.stringify(value)} must remain non-numeric`,
  );
  assert.throws(
    () => createVectorValue(value, createBitVectorValue(8)),
    (error) => error?.message === 'machine-effects-invalid-vector-lane-count',
    `vector lane count ${JSON.stringify(value)} must remain non-numeric`,
  );
  assert.throws(
    () => createMemoryAccess({
      space: 'memory',
      addressExpr: { kind: 'register', registerId: 'x0', widthBits: 64 },
      widthBits: value,
      endian: 'little',
    }),
    (error) => error?.message === 'machine-effects-invalid-memory-width',
    `memory width ${JSON.stringify(value)} must remain non-numeric`,
  );
  assert.throws(
    () => createMachineEffectBundle(bundle, { budget: { maxOperations: value } }),
    (error) => error?.message === 'machine-effects-invalid-budget-maxOperations',
    `operation budget ${JSON.stringify(value)} must remain non-numeric`,
  );
}

assert.throws(
  () => createMemoryAccess({
    space: 'memory',
    addressExpr: { kind: 'register', registerId: 'x0', widthBits: 64 },
    widthBits: 8,
    alignment: ['4'],
    endian: 'little',
  }),
  (error) => error?.message === 'machine-effects-invalid-memory-alignment',
);

assert.equal(createBitVectorValue(8).widthBits, 8);
assert.equal(createVectorValue(4, createBitVectorValue(8)).laneCount, 4);
assert.equal(createMemoryAccess({
  space: 'memory',
  addressExpr: { kind: 'register', registerId: 'x0', widthBits: 64 },
  widthBits: 32,
  alignment: 4,
  endian: 'little',
}).alignment, 4);
assert.doesNotThrow(() => createMachineEffectBundle(bundle, { budget: { maxOperations: 1 } }));

for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(
    () => createBitVectorValue(value),
    (error) => error?.message === 'machine-effects-invalid-bitvector-width',
  );
}

console.log('machine-effects #3586 primitive positive-integer boundary: PASS');

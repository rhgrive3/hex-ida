import assert from 'node:assert/strict';
import test from 'node:test';

import { jsonSafe, stableStringify } from '../js/core/identity/index.js';
import { serializable } from '../js/semantics/ir/common.js';
import {
  createMachineEffectBundle,
  createMachineOperation,
  createMachineValue,
  createMemoryAccess,
  createUnknownEffects,
} from '../js/semantics/effects/index.js';

test('#5853 jsonSafe rejects an invalid Date with a canonical identity error', () => {
  assert.throws(() => jsonSafe(new Date(NaN)), (err) => err.message === 'identity-invalid-date');
  assert.equal(jsonSafe(new Date(0)), '1970-01-01T00:00:00.000Z', 'valid dates keep ISO conversion');
  assert.throws(() => stableStringify({ d: new Date(NaN) }), (err) => err.message === 'identity-invalid-date');
  assert.equal(stableStringify({ d: new Date(0) }), '{"d":"1970-01-01T00:00:00.000Z"}');
});

test('#5853 serializable boundary rejects invalid Dates before jsonSafe runs', () => {
  assert.throws(() => serializable(new Date(NaN), 'semantic-ir-invalid-metadata'), (err) => err.message === 'semantic-ir-invalid-metadata');
  assert.equal(serializable(new Date(0), 'x'), '1970-01-01T00:00:00.000Z');
});

test('#5853 MachineEffects rejects invalid Dates at metadata, address, and detail boundaries', () => {
  const valid = new Date(0);
  assert.equal(
    createMachineOperation({ kind: 'barrier', scope: 'all', metadata: valid }).metadata,
    '1970-01-01T00:00:00.000Z',
  );
  assert.throws(
    () => createMachineOperation({ kind: 'barrier', scope: 'all', metadata: new Date(NaN) }),
    (err) => err.message === 'machine-effects-invalid-operation-metadata',
  );

  const bundle = {
    instructionId: 'i0',
    architectureId: 'test',
    mode: 'test',
    operations: [],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: { instructionIds: ['i0'] },
    completeness: 'exact',
    statePreservation: { proven: true, reason: 'test' },
  };
  assert.equal(createMachineEffectBundle({ ...bundle, metadata: valid }).metadata, '1970-01-01T00:00:00.000Z');
  assert.throws(
    () => createMachineEffectBundle({ ...bundle, metadata: new Date(NaN) }),
    (err) => err.message === 'machine-effects-invalid-metadata',
  );

  assert.equal(
    createMachineValue({ kind: 'memory', addressExpr: valid, widthBits: 8 }).addressExpr,
    '1970-01-01T00:00:00.000Z',
  );
  assert.throws(
    () => createMemoryAccess({ space: 'memory', addressExpr: new Date(NaN), widthBits: 8, endian: 'little' }),
    (err) => err.message === 'machine-effects-invalid-address-expression',
  );

  assert.equal(
    createUnknownEffects({ categories: ['other'], reason: 'test', detail: valid }).detail,
    '1970-01-01T00:00:00.000Z',
  );
  assert.throws(
    () => createUnknownEffects({ categories: ['other'], reason: 'test', detail: new Date(NaN) }),
    (err) => err.message === 'machine-effects-invalid-unknown-detail',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBitVectorValue,
  createMachineOperation,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';

const modulePath = '../../tools/validation/machine-effects/oracle-evidence-v2.mjs';
import { architecturalInput, clone, memoryInput } from './fixtures/evidence-v2-cases.mjs';

async function api() {
  return import(modulePath);
}

test('ME-01 Phase 2 counterexample: formal disagreement is blocking', async () => {
  const { assessArchitecturalEvidence, createArchitecturalEvidence } = await api();
  const evidence = createArchitecturalEvidence(architecturalInput());
  const result = assessArchitecturalEvidence({ evidence, subject: { profileId: evidence.profileId, effect: evidence.effect, observables: { ...evidence.expectedObservables, 'register:x0': '0x2' } } });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.exactAuthorized, false);
});

test('ME-01 Phase 2 counterexample: unknown ordering cannot authorize a known boundary', async () => {
  const { createMemoryOutcomeEvidence } = await api();
  assert.throws(() => createMemoryOutcomeEvidence(memoryInput('unknown', { completeness: 'complete' })), /unknown-ordering-cannot-be-complete/);
});

test('ME-01 Phase 2 counterexample: fully undefined result is first-class', () => {
  assert.doesNotThrow(() => createMachineOperation({
    kind: 'value', opcode: 'architecturally-undefined', inputs: [],
    outputs: [createTemporaryValue('undef-full', createBitVectorValue(8, 0n))],
    undefinedResult: { widthBits: 8, mask: '0xff', class: 'fully', reason: 'architecturally-undefined' },
  }));
});

test('ME-01 Phase 2 counterexample: partial undefined mask is validated', () => {
  const operation = createMachineOperation({
    kind: 'value', opcode: 'partial-result', inputs: [],
    outputs: [createTemporaryValue('undef-partial', createBitVectorValue(8, 0n))],
    undefinedResult: { widthBits: 8, mask: '0xf0', class: 'partial', reason: 'upper-nibble-undefined' },
  });
  assert.equal(operation.undefinedResult.mask, '0xf0');
});

test('ME-01 Phase 2 counterexample: stale oracle identity is rejected', async () => {
  const { createArchitecturalEvidence, validateArchitecturalEvidence } = await api();
  const stale = clone(createArchitecturalEvidence(architecturalInput()));
  stale.evidenceId = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateArchitecturalEvidence(stale), /stale-evidence-identity/);
});

test('ME-01 Phase 2 counterexample: unsupported profile/version stays unsupported', async () => {
  const { assessArchitecturalEvidence } = await api();
  const result = assessArchitecturalEvidence({ evidence: { profileId: 'arm64:sve', completeness: 'unsupported' }, subject: {} });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.exactAuthorized, false);
});

test('ME-01 Phase 2 counterexample: malformed artifact fails closed', async () => {
  const { createArchitecturalEvidence, validateArchitecturalEvidence } = await api();
  const malformed = clone(createArchitecturalEvidence(architecturalInput()));
  malformed.unexpected = true;
  assert.throws(() => validateArchitecturalEvidence(malformed), /unknown-field/);
});

test('ME-01 Phase 2 counterexample: incomplete observable set cannot be exact', async () => {
  const { createArchitecturalEvidence } = await api();
  assert.throws(() => createArchitecturalEvidence(architecturalInput({
    observables: { declared: ['register:x0', 'flag:N'], known: ['register:x0'], undefined: [], implementationDefined: [], unobserved: [] },
    expectedObservables: { 'register:x0': '0x0' },
  })), /observable-partition-incomplete/);
});

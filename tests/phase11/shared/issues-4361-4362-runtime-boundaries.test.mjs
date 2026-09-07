import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeObservation } from '../../../js/runtime/authority.js';
import {
  createManagedRuntimeBinding, managedRuntimeTargetProfileId, managedRuntimeProviderProfileId,
  validateManagedRuntimeState, validateManagedRuntimeObservation,
} from '../../../js/managed/runtime-binding.js';

const input = {
  frontendId: 'wasm', runtimeImplementation: 'wasmtime', runtimeVersion: '1',
  staticModuleIdentity: 'module-A', runtimeModuleIdentity: 'module-A',
  providerIdentity: 'provider-A', buildIdentity: 'build-A', runtimeInstanceIdentity: 'runtime-A',
  targetIdentity: 'target-A', binaryIdentity: 'binary-A', loadMappingIdentity: 'mapping-A',
  sessionIdentity: 'session-A', capabilityVersion: '1',
  maxThreads: 2, maxFramesPerThread: 2, maxLocalsPerFrame: 2, maxOperandStack: 2,
};
const binding = createManagedRuntimeBinding(input);
const frame = { moduleIdentity: 'module-A', locals: [], operandStack: [] };

for (const field of ['frontendId', 'runtimeImplementation', 'runtimeVersion', 'staticModuleIdentity', 'runtimeModuleIdentity', 'buildIdentity']) {
  test(`#4361 ${field} rejects structured identities before conversion`, () => {
    let converted = 0;
    const object = { toString() { converted++; return input[field]; } };
    for (const value of [[input[field]], object, true, false, 0, 1]) {
      assert.throws(() => createManagedRuntimeBinding({ ...input, [field]: value }), TypeError);
    }
    assert.equal(converted, 0);
  });
}

test('#4361 distinct malformed modules cannot collide at the managed authority boundary', () => {
  assert.throws(() => createManagedRuntimeBinding({ ...input, staticModuleIdentity: { static: 1 }, runtimeModuleIdentity: { runtime: 2 } }), /managed-runtime-static-module-required/);
  for (const make of [managedRuntimeTargetProfileId, managedRuntimeProviderProfileId]) {
    assert.throws(() => make(['wasm']), /managed-runtime-frontend-required/);
    assert.ok(make('wasm').startsWith('managed:wasm:'));
  }
  assert.throws(() => createManagedRuntimeBinding({ ...input, providerProfileId: ['managed:wasm:provider-bound-runtime-v1'] }), /managed-runtime-provider-profile-required/);
});

test('#4361 typed frame and observation module identity must match the static module', () => {
  for (const moduleIdentity of [['module-A'], {}, true, 1, '', ' ']) {
    assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ ...frame, moduleIdentity }] }] }).ok, false);
    const observation = createRuntimeObservation({ binding: binding.runtime, sequence: 1, observedAt: '2026-09-07T00:00:00Z', kind: 'managed-frame', payload: { moduleIdentity } });
    assert.equal(validateManagedRuntimeObservation(binding, observation).ok, false);
  }
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [frame] }] }).ok, true);
  const observation = createRuntimeObservation({ binding: binding.runtime, sequence: 1, observedAt: '2026-09-07T00:00:00Z', kind: 'managed-frame', payload: { moduleIdentity: 'module-A' } });
  assert.equal(validateManagedRuntimeObservation(binding, observation).ok, true);
});

for (const field of ['frames', 'locals', 'operandStack']) {
  test(`#4362 non-array ${field} cannot become a valid empty collection`, () => {
    for (const value of [false, true, 0, 1, '', 'bad', {}, new Uint8Array()]) {
      const state = field === 'frames'
        ? { threads: [{ frames: value }] }
        : { threads: [{ frames: [{ ...frame, [field]: value }] }] };
      const out = validateManagedRuntimeState(binding, state);
      assert.equal(out.ok, false, `${field}=${String(value)}`);
      assert.equal(out.reason, `managed-runtime-${field === 'operandStack' ? 'operand-stack' : field}-invalid`);
    }
    for (const value of [undefined, null, []]) {
      const state = field === 'frames'
        ? { threads: [{ frames: value }] }
        : { threads: [{ frames: [{ ...frame, [field]: value }] }] };
      assert.equal(validateManagedRuntimeState(binding, state).ok, true);
    }
  });
}

test('#4362 valid arrays still enforce every managed state budget', () => {
  assert.equal(validateManagedRuntimeState(binding, { threads: [{}, {}, {}] }).reason, 'managed-runtime-thread-budget-exceeded');
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [frame, frame, frame] }] }).reason, 'managed-runtime-frame-budget-exceeded');
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ ...frame, locals: [1, 2, 3] }] }] }).reason, 'managed-runtime-local-budget-exceeded');
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ ...frame, operandStack: [1, 2, 3] }] }] }).reason, 'managed-runtime-stack-budget-exceeded');
});

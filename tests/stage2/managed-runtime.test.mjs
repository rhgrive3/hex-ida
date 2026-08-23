import assert from 'node:assert/strict';
import { createRuntimeObservation, runtimeProfileSupport } from '../../js/runtime/authority.js';
import {
  createManagedRuntimeBinding,
  managedRuntimeProfileSupport,
  validateManagedRuntimeObservation,
  validateManagedRuntimeState,
} from '../../js/managed/runtime-binding.js';

const frontends = ['wasm', 'dex', 'cil', 'jvm'];
const requiredCapabilities = ['connect', 'disconnect', 'pause', 'resume', 'stepInto', 'readRegisters', 'readMemory', 'threads', 'modules', 'backtrace', 'cancel'];
const providerCapabilities = Object.fromEntries(requiredCapabilities.map((name) => [name, true]));
const commitSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const runtimeProofFlags = {
  exactHead: true,
  headSha: commitSha,
  treeSha,
  identityNegativeTests: true,
  staleEventTests: true,
  lifecycleTests: true,
  capabilityTests: true,
  moduleMappingTests: true,
  mutationAuthorityTests: true,
};
const managedProof = {
  exactHead: true,
  identityNegativeTests: true,
  staleEventTests: true,
  stateBudgetTests: true,
  runtimeDisagreementPreservesStaticTruth: true,
  frontendProviderTests: true,
  profileDenominatorComplete: true,
};

for (const frontendId of frontends) {
  const binding = createManagedRuntimeBinding({
    frontendId,
    runtimeImplementation: `${frontendId}-runtime-test`,
    runtimeVersion: '1-test',
    staticModuleIdentity: `managed-module:${frontendId}:1`,
    runtimeModuleIdentity: `managed-module:${frontendId}:1`,
    providerIdentity: `provider:${frontendId}:test`,
    buildIdentity: `build:${frontendId}:test`,
    commitSha,
    treeSha,
    runtimeInstanceIdentity: `runtime:${frontendId}:1`,
    targetIdentity: `process:${frontendId}:1`,
    binaryIdentity: `binary:${frontendId}:1`,
    loadMappingIdentity: `mapping:${frontendId}:1`,
    sessionIdentity: `session:${frontendId}:1`,
    capabilityVersion: 'managed-debug/v1',
    maxThreads: 2,
    maxFramesPerThread: 2,
    maxLocalsPerFrame: 2,
    maxOperandStack: 2,
  });

  assert.equal(binding.targetProfileId, `managed:${frontendId}:m6`);
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ moduleIdentity: binding.runtimeModuleIdentity, locals: [1], operandStack: [2] }] }] }).ok, true);
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ moduleIdentity: binding.runtimeModuleIdentity, locals: [1, 2, 3], operandStack: [] }] }] }).reason, 'managed-runtime-local-budget-exceeded');
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ moduleIdentity: 'wrong', locals: [], operandStack: [] }] }] }).reason, 'managed-runtime-frame-module-mismatch');
  assert.equal(validateManagedRuntimeState(binding, {}).reason, 'managed-runtime-threads-required');
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ locals: [], operandStack: [] }] }] }).reason, 'managed-runtime-frame-module-required');

  const observation = createRuntimeObservation({ binding: binding.runtime, sequence: 1, observedAt: '2026-08-22T00:00:00Z', kind: 'managed-frame', payload: { moduleIdentity: binding.runtimeModuleIdentity } });
  assert.equal(validateManagedRuntimeObservation(binding, observation).ok, true);
  const wrongObservation = createRuntimeObservation({ binding: binding.runtime, sequence: 2, observedAt: '2026-08-22T00:00:01Z', kind: 'managed-frame', payload: { moduleIdentity: 'other' } });
  assert.equal(validateManagedRuntimeObservation(binding, wrongObservation).reason, 'managed-runtime-observation-module-mismatch');
  const missingModuleObservation = createRuntimeObservation({ binding: binding.runtime, sequence: 3, observedAt: '2026-08-22T00:00:02Z', kind: 'managed-frame' });
  assert.equal(validateManagedRuntimeObservation(binding, missingModuleObservation).reason, 'managed-runtime-observation-payload-invalid');
  const tamperedObservation = { ...observation, payload: { moduleIdentity: binding.runtimeModuleIdentity, altered: true } };
  assert.equal(validateManagedRuntimeObservation(binding, tamperedObservation).reason, 'runtime-observation-identity-invalid');

  const runtimeProfileProof = runtimeProfileSupport({
    binding: binding.runtime,
    providerProfileId: `managed:${frontendId}:provider-bound-runtime-v1`,
    targetProfileId: binding.targetProfileId,
    providerCapabilities,
    requiredCapabilities,
    proof: runtimeProofFlags,
  });
  assert.equal(runtimeProfileProof.status, 'supported-for-exact-provider-profile');
  const support = managedRuntimeProfileSupport({ binding, runtimeProfileProof, proof: managedProof });
  assert.equal(support.frontendId, frontendId);
  assert.equal(support.targetProfileId, binding.targetProfileId);
  assert.equal(support.status, 'supported-for-exact-provider-profile');
  assert.equal(managedRuntimeProfileSupport({ binding, runtimeProfileProof: { ...runtimeProfileProof, bindingId: 'wrong' }, proof: managedProof }).status, 'partial');
  assert.equal(managedRuntimeProfileSupport({ binding, runtimeProfileProof: { ...runtimeProfileProof, targetProfileId: 'managed:other:m6' }, proof: managedProof }).status, 'partial', 'proof from another managed frontend must not be reusable');
  assert.equal(managedRuntimeProfileSupport({ binding, runtimeProfileProof: { ...runtimeProfileProof, providerProfileId: `managed:other:provider-bound-runtime-v1` }, proof: managedProof }).status, 'partial', 'provider profile from another managed frontend must not be reusable');
  assert.equal(managedRuntimeProfileSupport({ binding, runtimeProfileProof: { ...runtimeProfileProof, providerIdentity: 'provider:other:test' }, proof: managedProof }).status, 'partial', 'proof from another provider identity must not be reusable');
  assert.equal(managedRuntimeProfileSupport({ binding, runtimeProfileProof: { ...runtimeProfileProof, requiredCapabilities: runtimeProfileProof.requiredCapabilities.slice(1) }, proof: managedProof }).status, 'partial', 'a reduced provider denominator must not promote M6');
  assert.equal(managedRuntimeProfileSupport({ binding, runtimeProfileProof, proof: { ...managedProof, frontendProviderTests: false } }).status, 'partial');
}

assert.throws(() => createManagedRuntimeBinding({
  frontendId: 'jvm', runtimeImplementation: 'x', runtimeVersion: '1', staticModuleIdentity: 'a', runtimeModuleIdentity: 'b',
  providerIdentity: 'p', buildIdentity: 'build', commitSha, treeSha, runtimeInstanceIdentity: 'r', targetIdentity: 't', binaryIdentity: 'bin', loadMappingIdentity: 'map', sessionIdentity: 's', capabilityVersion: '1',
}), /module-identity-mismatch/);
assert.throws(() => createManagedRuntimeBinding({
  frontendId: 'jvm', runtimeImplementation: 'x', runtimeVersion: '1', staticModuleIdentity: 'a', runtimeModuleIdentity: 'a',
  providerProfileId: 'managed:attacker:provider-bound-runtime-v1', providerIdentity: 'p', buildIdentity: 'build', commitSha, treeSha, runtimeInstanceIdentity: 'r', targetIdentity: 't', binaryIdentity: 'bin', loadMappingIdentity: 'map', sessionIdentity: 's', capabilityVersion: '1',
}), /provider-profile-mismatch/);
console.log('[stage2] managed runtime binding tests passed for wasm/dex/cil/jvm');

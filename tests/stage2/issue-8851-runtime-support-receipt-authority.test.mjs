import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RuntimeAuthorityTracker,
  createRuntimeAuthorityBinding,
  createRuntimeObservation,
  isValidatedRuntimeProfileSupport,
  runtimeProfileSupport,
} from '../../js/runtime/authority.js';
import { createStage1ProfileProof, stage2ArchitectureMaturity } from '../../js/platform/stage2-capability-maturity.js';
import { validatedCapabilityProofFixture } from './helpers/profile-proof-fixture.mjs';

const { proofs } = validatedCapabilityProofFixture();
const profileProof = proofs['S2-A7-NATIVE'];
const REQUIRED = [
  'connect', 'disconnect', 'attach', 'pause', 'resume', 'stepInto',
  'breakpointAddress', 'removeBreakpoint', 'readRegisters', 'readMemory',
  'writeMemory', 'threads', 'modules', 'cancel',
];
const PROVIDER_PROFILE_ID = 'native:remote-debug-v1:qemu-lldb';
const TARGET_PROFILE_ID = 'arm64:a64';
const BOOLEAN_CLAIMS = {
  exactHead: true,
  identityNegativeTests: true,
  staleEventTests: true,
  lifecycleTests: true,
  capabilityTests: true,
  moduleMappingTests: true,
  mutationAuthorityTests: true,
};

function callerBinding(over = {}) {
  return createRuntimeAuthorityBinding({
    providerIdentity: 'caller:fake',
    providerProfileId: PROVIDER_PROFILE_ID,
    providerVersion: 'fake',
    runtimeInstanceIdentity: 'fake-runtime',
    targetIdentity: 'fake-process',
    targetProfileId: TARGET_PROFILE_ID,
    binaryIdentity: 'fake-binary',
    buildIdentity: 'caller-build',
    moduleIdentity: 'fake-module',
    loadMappingIdentity: 'fake-map',
    sessionIdentity: 'fake-session',
    capabilityVersion: 'debug/v1',
    commitSha: profileProof.commitSha,
    treeSha: profileProof.treeSha,
    epoch: 1,
    ...over,
  });
}

function evaluate(binding, extra = {}) {
  return runtimeProfileSupport({
    binding,
    providerProfileId: PROVIDER_PROFILE_ID,
    targetProfileId: TARGET_PROFILE_ID,
    providerCapabilities: Object.fromEntries(REQUIRED.map((name) => [name, true])),
    requiredCapabilities: REQUIRED,
    proof: { ...BOOLEAN_CLAIMS, headSha: binding.commitSha, treeSha: binding.treeSha },
    profileProof,
    ...extra,
  });
}

function maturityFor(support) {
  return stage2ArchitectureMaturity('arm64', {
    stage1Proof: createStage1ProfileProof({
      status: 'stage1-proven',
      exactHead: true,
      fullySatisfiedLevel: 'A6',
      profileIds: [TARGET_PROFILE_ID],
      commitSha: profileProof.commitSha,
      treeSha: profileProof.treeSha,
      artifactIdentity: 'artifact:issue-8851:stage1',
    }),
    runtimeProof: support,
    profileProof,
  });
}

function exercisedTracker(binding) {
  const tracker = new RuntimeAuthorityTracker(binding);
  const observationIds = [];
  for (let sequence = 1; sequence <= 2; sequence += 1) {
    const accepted = tracker.accept(createRuntimeObservation({
      binding, sequence, observedAt: `2026-09-15T00:00:0${sequence}Z`, kind: 'stop', payload: { pc: '0x1000' },
    }));
    assert.equal(accepted.status, 'accepted');
    observationIds.push(accepted.observationId);
  }
  const mutation = tracker.authorizeMutation({
    actorIdentity: 'local:user', operation: 'write-memory', issuedAt: '2026-09-15T00:00:09Z', explicitApproval: true,
  });
  assert.equal(mutation.status, 'authorized');
  return { tracker, observationIds, mutationId: mutation.token.tokenId };
}

function receiptFor(binding) {
  const { tracker, observationIds, mutationId } = exercisedTracker(binding);
  return tracker.mintProfileSupportReceipt({
    observationIdentities: observationIds,
    mutationAuthorityIdentities: [mutationId],
    testItemIdentities: ['lifecycle', 'capability', 'module-mapping', 'stale-event', 'mutation-authority'],
  });
}

test('#8851 caller-supplied proof booleans and an invented binding cannot mint runtime support authority', () => {
  const support = evaluate(callerBinding());
  assert.equal(support.status, 'partial');
  assert.equal(support.reason, 'runtime-validation-receipt-required');
  assert.equal(support.authority, 'none');
  assert.equal(isValidatedRuntimeProfileSupport(support), false);
  // The self-reported booleans stay visible as non-authoritative diagnostics.
  assert.equal(support.proofComplete, true);
});

test('#8851 the same caller-only construction cannot promote an architecture to A7', () => {
  const maturity = maturityFor(evaluate(callerBinding()));
  assert.notEqual(maturity.level, 'A7');
  assert.notEqual(maturity.status, 'supported');
  assert.notEqual(maturity.features.runtimeDebugPatchValidation, 'supported');
});

test('#8851 a rebuilt receipt-shaped plain object is not a receipt', () => {
  const binding = callerBinding();
  const forged = { ...receiptFor(binding) };
  assert.equal(isValidatedRuntimeProfileSupport(evaluate(binding, { runtimeReceipt: forged })), false);
  assert.equal(evaluate(binding, { runtimeReceipt: forged }).reason, 'runtime-validation-receipt-required');
});

test('#8851 a receipt bound to another provider/runtime/session/binary/build/module/mapping/epoch/head/tree identity is rejected', () => {
  const binding = callerBinding();
  const receipt = receiptFor(binding);
  for (const field of [
    'providerIdentity', 'runtimeInstanceIdentity', 'sessionIdentity', 'binaryIdentity',
    'buildIdentity', 'moduleIdentity', 'loadMappingIdentity', 'epoch',
  ]) {
    const substituted = callerBinding({ [field]: field === 'epoch' ? binding.epoch + 5 : `${binding[field]}-substituted` });
    const support = evaluate(substituted, { runtimeReceipt: receipt });
    assert.equal(support.status, 'partial', `${field} substitution must not reuse the receipt`);
    assert.match(support.reason, /^runtime-validation-receipt-identity-mismatch/);
    assert.equal(isValidatedRuntimeProfileSupport(support), false);
  }
  const staleHead = callerBinding({ commitSha: 'c'.repeat(40) });
  const staleSupport = evaluate(staleHead, { runtimeReceipt: receipt });
  assert.equal(staleSupport.status, 'partial');
  assert.equal(isValidatedRuntimeProfileSupport(staleSupport), false);
  assert.match(staleSupport.reason, /^runtime-validation-receipt-identity-mismatch|^runtime-proof-stale-head|^runtime-profile-evidence-required/);
});

test('#8851 only a concrete provider-session validation receipt produces branded support and A7', () => {
  const binding = callerBinding();
  const support = evaluate(binding, { runtimeReceipt: receiptFor(binding) });
  assert.equal(support.status, 'supported-for-exact-provider-profile');
  assert.equal(support.authority, 'runtime-evidence-bound');
  assert.equal(isValidatedRuntimeProfileSupport(support), true);
  const maturity = maturityFor(support);
  assert.equal(maturity.level, 'A7');
  assert.equal(maturity.status, 'supported');
  assert.equal(maturity.features.runtimeDebugPatchValidation, 'supported');
  assert.equal(support.runtimeReceiptBindingId, binding.bindingId);
});

test('#8851 copying a branded support object still loses the runtime authority brand', () => {
  const binding = callerBinding();
  const support = evaluate(binding, { runtimeReceipt: receiptFor(binding) });
  assert.equal(isValidatedRuntimeProfileSupport(support), true);
  assert.equal(isValidatedRuntimeProfileSupport({ ...support }), false);
});

test('#8851 a receipt cannot attest to runtime traffic its tracker never accepted', () => {
  const binding = callerBinding();
  const { tracker, observationIds, mutationId } = exercisedTracker(binding);
  const other = exercisedTracker(callerBinding({ sessionIdentity: 'session:other' }));
  assert.throws(
    () => tracker.mintProfileSupportReceipt({
      observationIdentities: [...observationIds, other.observationIds[0]],
      mutationAuthorityIdentities: [mutationId],
      testItemIdentities: ['lifecycle'],
    }),
    /runtime-receipt-observation-unbound/,
  );
  assert.throws(
    () => tracker.mintProfileSupportReceipt({
      observationIdentities: observationIds,
      mutationAuthorityIdentities: [other.mutationId],
      testItemIdentities: ['lifecycle'],
    }),
    /runtime-receipt-mutation-authority-unbound/,
  );
  assert.throws(
    () => tracker.mintProfileSupportReceipt({ observationIdentities: [], mutationAuthorityIdentities: [mutationId], testItemIdentities: ['lifecycle'] }),
    /runtime-receipt-observation-identities-required/,
  );
});

test('#8851 an epoch-rotated (closed) tracker cannot mint a support receipt', () => {
  const binding = callerBinding();
  const { tracker, observationIds, mutationId } = exercisedTracker(binding);
  tracker.nextEpoch();
  assert.equal(tracker.closed, true);
  assert.throws(
    () => tracker.mintProfileSupportReceipt({ observationIdentities: observationIds, mutationAuthorityIdentities: [mutationId], testItemIdentities: ['lifecycle'] }),
    /runtime-receipt-tracker-closed/,
  );
});

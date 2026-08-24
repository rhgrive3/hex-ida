import assert from 'node:assert/strict';
import {
  stage2ArchitectureMaturity,
  stage2FormatMaturity,
  stage2ManagedMaturity,
  stage2Phase12Maturity,
} from '../../js/platform/stage2-capability-maturity.js';
import { createStage2CapabilityProofs } from '../../js/platform/stage2-profile-evidence.js';
import { validatedCapabilityProofFixture } from './helpers/profile-proof-fixture.mjs';
import { RemoteCollaborationGate, remoteCollaborationSupport } from '../../js/collaboration/remote-authority.js';
import { createRuntimeAuthorityBinding, runtimeProfileSupport } from '../../js/runtime/authority.js';
import { createManagedRuntimeBinding, managedRuntimeProfileSupport } from '../../js/managed/runtime-binding.js';
import { validatedRebuildSupportFixture } from './helpers/rebuild-proof-fixture.mjs';

const { validation, proofs } = validatedCapabilityProofFixture();
assert.throws(() => createStage2CapabilityProofs({ ...validation }), /validation-authority-required/, 'a copied validation result has no promotion authority');

const arm64Stage1 = { status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'A6', profileIds: ['arm64:a64'] };
const arm64Runtime = { status: 'supported-for-exact-provider-profile', targetProfileId: 'arm64:a64' };
assert.notEqual(stage2ArchitectureMaturity('arm64', { stage1Proof: arm64Stage1, runtimeProof: arm64Runtime }).level, 'A7', 'status strings without validated profile evidence must not promote A7');
assert.notEqual(stage2ArchitectureMaturity('arm64', { stage1Proof: arm64Stage1, runtimeProof: { ...arm64Runtime, status: 'supported-for-exact-provider-profile-fabricated' }, profileProof: proofs['S2-A7-NATIVE'] }).level, 'A7', 'a status suffix must not promote A7');
const runtimeFlags = {
  exactHead: true, headSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
  identityNegativeTests: true, staleEventTests: true, lifecycleTests: true,
  capabilityTests: true, moduleMappingTests: true, mutationAuthorityTests: true,
};
const nativeCapabilities = ['connect', 'disconnect', 'attach', 'pause', 'resume', 'stepInto', 'breakpointAddress', 'removeBreakpoint', 'readRegisters', 'readMemory', 'writeMemory', 'threads', 'modules', 'cancel'];
const nativeBinding = createRuntimeAuthorityBinding({
  providerIdentity: 'provider:capability-test', providerProfileId: 'native:lldb-compatible-v1:test', providerVersion: '1',
  runtimeInstanceIdentity: 'runtime:capability-test', targetIdentity: 'process:capability-test', targetProfileId: 'arm64:a64',
  binaryIdentity: 'binary:capability-test', buildIdentity: 'build:capability-test', moduleIdentity: 'module:capability-test',
  loadMappingIdentity: 'mapping:capability-test', sessionIdentity: 'session:capability-test', capabilityVersion: 'debug/v1',
  commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
});
const validatedArm64Runtime = runtimeProfileSupport({
  binding: nativeBinding, providerProfileId: nativeBinding.providerProfileId, targetProfileId: nativeBinding.targetProfileId,
  providerCapabilities: Object.fromEntries(nativeCapabilities.map((name) => [name, true])), requiredCapabilities: nativeCapabilities,
  proof: runtimeFlags, profileProof: proofs['S2-A7-NATIVE'],
});
const arm64 = stage2ArchitectureMaturity('arm64', { stage1Proof: arm64Stage1, runtimeProof: validatedArm64Runtime, profileProof: proofs['S2-A7-NATIVE'] });
assert.equal(arm64.level, 'A7');
assert.equal(arm64.status, 'supported');
assert.equal(arm64.features.runtimeDebugPatchValidation, 'supported');
assert.notEqual(stage2ArchitectureMaturity('arm64', { stage1Proof: { verdict: 'READY' }, runtimeProof: arm64Runtime }).level, 'A7', 'generic Stage1 READY must not promote a target profile');
assert.notEqual(stage2ArchitectureMaturity('arm64', { stage1Proof: arm64Stage1, runtimeProof: { ...arm64Runtime, targetProfileId: 'x86_64:long-64' } }).level, 'A7', 'runtime proof from another architecture must not promote A7');
assert.notEqual(stage2ArchitectureMaturity('arm64', { stage1Proof: arm64Stage1, runtimeProof: arm64Runtime, profileProof: { ...proofs['S2-A7-NATIVE'] } }).level, 'A7', 'serialized or forged profile proof must not retain promotion authority');
assert.notEqual(stage2ArchitectureMaturity('arm64', { stage1Proof: arm64Stage1, runtimeProof: { ...validatedArm64Runtime }, profileProof: proofs['S2-A7-NATIVE'] }).level, 'A7', 'copied runtime support must not retain provider authority');

const jvmRuntime = { status: 'supported-for-exact-provider-profile', frontendId: 'jvm', targetProfileId: 'managed:jvm:m6' };
const managedCapabilities = ['connect', 'disconnect', 'pause', 'resume', 'stepInto', 'readRegisters', 'readMemory', 'threads', 'modules', 'backtrace', 'cancel'];
const managedBinding = createManagedRuntimeBinding({
  frontendId: 'jvm', runtimeImplementation: 'jvm-capability-test', runtimeVersion: '1',
  staticModuleIdentity: 'managed-module:jvm:test', runtimeModuleIdentity: 'managed-module:jvm:test',
  providerIdentity: 'provider:jvm:test', buildIdentity: 'build:jvm:test', commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
  runtimeInstanceIdentity: 'runtime:jvm:test', targetIdentity: 'process:jvm:test', binaryIdentity: 'binary:jvm:test',
  loadMappingIdentity: 'mapping:jvm:test', sessionIdentity: 'session:jvm:test', capabilityVersion: 'managed-debug/v1',
});
const managedRuntimeAuthority = runtimeProfileSupport({
  binding: managedBinding.runtime, providerProfileId: managedBinding.runtime.providerProfileId, targetProfileId: managedBinding.targetProfileId,
  providerCapabilities: Object.fromEntries(managedCapabilities.map((name) => [name, true])), requiredCapabilities: managedCapabilities,
  proof: runtimeFlags, profileProof: proofs['S2-M6-JVM'],
});
const validatedJvmRuntime = managedRuntimeProfileSupport({ binding: managedBinding, runtimeProfileProof: managedRuntimeAuthority, proof: {
  exactHead: true, identityNegativeTests: true, staleEventTests: true, stateBudgetTests: true,
  runtimeDisagreementPreservesStaticTruth: true, frontendProviderTests: true, profileDenominatorComplete: true,
} });
const jvm = stage2ManagedMaturity('jvm', { runtimeProof: validatedJvmRuntime, profileProof: proofs['S2-M6-JVM'] });
assert.equal(jvm.level, 'M6');
assert.equal(jvm.status, 'supported');
assert.notEqual(stage2ManagedMaturity('jvm', { runtimeProof: { ...validatedJvmRuntime }, profileProof: proofs['S2-M6-JVM'] }).level, 'M6', 'copied managed support must not retain runtime authority');
assert.notEqual(stage2ManagedMaturity('jvm', { runtimeProof: { ...jvmRuntime, frontendId: 'dex', targetProfileId: 'managed:dex:m6' } }).level, 'M6');

const machoStage1 = { status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'F5', profileIds: ['macho:64'] };
const machoRebuild = { status: 'supported-for-exact-rebuild-profile', format: 'macho', formatCoverageComplete: true, formatProfileIds: ['macho:64'] };
const validatedMachoRebuild = await validatedRebuildSupportFixture('macho', proofs['S2-F6-MACHO']);
const macho = stage2FormatMaturity('macho', { stage1Proof: machoStage1, rebuildProof: validatedMachoRebuild, profileProof: proofs['S2-F6-MACHO'] });
assert.equal(macho.level, 'F6');
assert.equal(macho.status, 'supported');
assert.equal(macho.features.validatedRebuildPatch, 'supported');
assert.notEqual(stage2FormatMaturity('macho', { stage1Proof: machoStage1, rebuildProof: { ...validatedMachoRebuild }, profileProof: proofs['S2-F6-MACHO'] }).level, 'F6', 'copied rebuild support must not retain publication authority');
assert.notEqual(stage2FormatMaturity('macho', { stage1Proof: { verdict: 'READY' }, rebuildProof: machoRebuild }).level, 'F6');
assert.notEqual(stage2FormatMaturity('macho', { stage1Proof: machoStage1, rebuildProof: { ...machoRebuild, formatCoverageComplete: false } }).level, 'F6');

const peStage1 = { status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'F4', profileIds: ['pe:pe32', 'pe:pe32+'] };
const peRebuild = { status: 'supported-for-exact-rebuild-profile', format: 'pe', formatCoverageComplete: true, formatProfileIds: ['pe:pe32', 'pe:pe32+'] };
const validatedPeRebuild = await validatedRebuildSupportFixture('pe', proofs['S2-F6-PE']);
const pe = stage2FormatMaturity('pe', { stage1Proof: peStage1, rebuildProof: validatedPeRebuild, profileProof: proofs['S2-F6-PE'] });
assert.equal(pe.features.validatedRebuildPatch, 'supported');
assert.equal(pe.fullySatisfiedLevel, 'F4', 'PE cannot claim cumulative F6 while F5 remains unsupported');
assert.equal(pe.status, 'partial');

const remoteCollaborationProof = remoteCollaborationSupport({
  gate: new RemoteCollaborationGate({
    projectIdentity: 'project:capability-test',
    sessionIdentity: 'session:capability-test',
    allowedActors: {},
    verifyTransportProof: () => true,
  }),
  profileProof: proofs['S2-P12-COLLAB-REMOTE'],
  expectedCommitSha: 'a'.repeat(40),
  expectedTreeSha: 'b'.repeat(40),
});
const phase12 = stage2Phase12Maturity({
  profileProofs: proofs,
  knowledgeProof: { deterministic: true, authorityNegativeTests: true, dependencyIdentityTests: true, invalidationTests: true, providerBoundaryTests: true },
  rulesProof: { deterministic: true, partialPropagationTests: true, dependencyTests: true, requiredFeatureTests: true, resourceBudgetTests: true },
  patternProof: { deterministic: true, bounded: true, noArbitraryJavaScript: true, truncationTests: true },
  remoteCollaborationProof,
  rebuildProof: validatedMachoRebuild,
});
assert.equal(phase12.knowledgePackages.status, 'supported');
assert.equal(phase12.capabilityRules.status, 'supported');
assert.equal(phase12.patterns.status, 'supported');
assert.equal(phase12.collaboration.status, 'supported');
assert.notEqual(stage2Phase12Maturity({ profileProofs: proofs, remoteCollaborationProof: { ...remoteCollaborationProof } }).collaboration.status, 'supported', 'copied remote support cannot retain transport authority');
assert.equal(phase12.rebuild.status, 'supported');
assert.equal(stage2Phase12Maturity({ rulesProof: { deterministic: true, partialPropagationTests: true } }).capabilityRules.status, 'partial');
console.log('[stage2] profile-bound capability promotion tests passed');

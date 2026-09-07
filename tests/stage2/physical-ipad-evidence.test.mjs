import assert from 'node:assert/strict';
import { createPhysicalIPadEvidence, createPhysicalIPadScenarioOutput, validatePhysicalIPadEvidence, validatePhysicalIPadScenarioOutput } from '../../js/platform/physical-ipad-evidence.js';

const commitSha = '1'.repeat(40);
const treeSha = '2'.repeat(40);
const checks = {
  runtimeActivationIdentity: true,
  openNontrivialBinary: true,
  demandDrivenNavigation: true,
  cancellation: true,
  workerLifecycleRecovery: true,
  indexedDbProjectRoundTrip: true,
  variableLengthViewer: true,
  semanticDecompilerWorkflow: true,
  memoryBudget: true,
  phase12UiPath: true,
};
const fixtureIdentity = 'artifact:reports/stage2/fixture.bin@sha256:' + '3'.repeat(64);
const scenarioEvidenceIdentity = 'artifact:reports/stage2/ipad-output.json@sha256:' + '4'.repeat(64);
const resolveEvidenceIdentity = (identity) => [fixtureIdentity, scenarioEvidenceIdentity].includes(identity) ? identity : null;
const scenarioChecks = Object.fromEntries(Object.keys(checks).map((key, index) => [key, {
  status: 'passed',
  observedAt: `2026-08-22T00:00:${String(index).padStart(2, '0')}Z`,
  observationIdentity: `physical-observation:${key}:exact-runtime`,
  detail: `observed ${key}`,
}]));
const scenario = createPhysicalIPadScenarioOutput({
  commitSha, treeSha, buildIdentity: 'build:test', runtimeIdentity: 'runtime:test', deviceModel: 'iPad mini 6',
  iPadOSVersion: '27.0-test', webKitVersion: 'test', startedAt: '2026-08-22T00:00:00Z', completedAt: '2026-08-22T00:01:00Z',
  fixtureIdentity, checks: scenarioChecks,
});
assert.equal(validatePhysicalIPadScenarioOutput(scenario, { commitSha, treeSha, buildIdentity: 'build:test', fixtureIdentity }).ok, true);
assert.equal(validatePhysicalIPadScenarioOutput(scenario, { commitSha, treeSha, buildIdentity: 'build:wrong', fixtureIdentity }).reason, 'ipad-scenario-build-mismatch');
const failedScenario = createPhysicalIPadScenarioOutput({ ...scenario, checks: { ...scenarioChecks, cancellation: { ...scenarioChecks.cancellation, status: 'failed' } } });
assert.equal(validatePhysicalIPadScenarioOutput(failedScenario).reason, 'ipad-scenario-required-check-failed');
const duplicateObservation = structuredClone(scenario);
duplicateObservation.checks.cancellation.observationIdentity = duplicateObservation.checks.runtimeActivationIdentity.observationIdentity;
duplicateObservation.scenarioId = createPhysicalIPadScenarioOutput({ ...duplicateObservation, checks: duplicateObservation.checks }).scenarioId;
assert.equal(validatePhysicalIPadScenarioOutput(duplicateObservation).reason, 'ipad-scenario-check-identity-invalid');
const record = createPhysicalIPadEvidence({
  commitSha,
  treeSha,
  buildIdentity: 'build:test',
  runtimeIdentity: 'runtime:test',
  deviceModel: 'iPad mini 6',
  iPadOSVersion: '27.0-test',
  webKitVersion: 'test',
  testedAt: '2026-08-22T00:00:00Z',
  attestedBy: 'test-harness-human-attestation-shape',
  fixtureIdentity,
  scenarioEvidenceIdentity,
  checks,
});
assert.equal(validatePhysicalIPadEvidence(record, { commitSha, treeSha, buildIdentity: 'build:test', resolveEvidenceIdentity }).ok, true);
assert.equal(validatePhysicalIPadEvidence(record, { commitSha: '3'.repeat(40), resolveEvidenceIdentity }).reason, 'ipad-evidence-stale-commit');
const missing = createPhysicalIPadEvidence({ ...record, checks: { ...checks, cancellation: false } });
assert.equal(validatePhysicalIPadEvidence(missing, { commitSha, treeSha, resolveEvidenceIdentity }).reason, 'ipad-evidence-required-check-missing');
const tampered = JSON.parse(JSON.stringify(record));
tampered.deviceModel = 'iPad Pro altered-after-attestation';
assert.equal(validatePhysicalIPadEvidence(tampered, { commitSha, treeSha, resolveEvidenceIdentity }).reason, 'ipad-evidence-tampered');
const malformedTime = { ...record, testedAt: 'not-a-date' };
assert.equal(validatePhysicalIPadEvidence(malformedTime, { commitSha, treeSha, resolveEvidenceIdentity }).reason, 'ipad-evidence-tested-at-invalid');
const missingDevice = { ...record, deviceModel: '' };
assert.equal(validatePhysicalIPadEvidence(missingDevice, { commitSha, treeSha, resolveEvidenceIdentity }).reason, 'ipad-evidence-deviceModel-invalid');
assert.equal(validatePhysicalIPadEvidence(record, { commitSha, treeSha, resolveEvidenceIdentity: () => null }).reason, 'ipad-evidence-fixture-unresolved');
const gitReadmeIdentity = 'git:README.md@' + 'a'.repeat(40);
const gitBacked = createPhysicalIPadEvidence({ ...record, fixtureIdentity: gitReadmeIdentity });
assert.equal(validatePhysicalIPadEvidence(gitBacked, { commitSha, treeSha, resolveEvidenceIdentity: (identity) => identity }).reason, 'ipad-evidence-fixture-identity-invalid');
const gitScenario = createPhysicalIPadEvidence({ ...record, scenarioEvidenceIdentity: gitReadmeIdentity });
assert.equal(validatePhysicalIPadEvidence(gitScenario, { commitSha, treeSha, resolveEvidenceIdentity: (identity) => identity }).reason, 'ipad-evidence-scenario-output-identity-invalid');
console.log('[stage2] physical iPad evidence contract tests passed');

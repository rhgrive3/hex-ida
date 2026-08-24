import { deepFreeze, stableDigest } from '../core/identity/index.js';

export const PHYSICAL_IPAD_EVIDENCE_SCHEMA = 'hex-physical-ipad-evidence/v2';
export const PHYSICAL_IPAD_SCENARIO_SCHEMA = 'hex-physical-ipad-scenario-output/v1';
export const REQUIRED_IPAD_CHECKS = Object.freeze([
  'runtimeActivationIdentity',
  'openNontrivialBinary',
  'demandDrivenNavigation',
  'cancellation',
  'workerLifecycleRecovery',
  'indexedDbProjectRoundTrip',
  'variableLengthViewer',
  'semanticDecompilerWorkflow',
  'memoryBudget',
  'phase12UiPath',
]);
const ARTIFACT_IDENTITY = /^artifact:[^@]+@sha256:[0-9a-f]{64}$/;

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

function evidencePayload(record) {
  return {
    schemaVersion: record.schemaVersion,
    commitSha: record.commitSha,
    treeSha: record.treeSha,
    buildIdentity: record.buildIdentity,
    runtimeIdentity: record.runtimeIdentity,
    deviceModel: record.deviceModel,
    iPadOSVersion: record.iPadOSVersion,
    webKitVersion: record.webKitVersion,
    testedAt: record.testedAt,
    attestedBy: record.attestedBy,
    fixtureIdentity: record.fixtureIdentity,
    scenarioEvidenceIdentity: record.scenarioEvidenceIdentity,
    checks: record.checks,
    runtimeProfilesExercised: record.runtimeProfilesExercised,
    rebuildProfilesExercised: record.rebuildProfilesExercised,
    notesDigest: record.notesDigest,
  };
}

function evidenceIdentity(record) {
  return `physical-ipad:${stableDigest(evidencePayload(record))}`;
}

function scenarioPayload(record) {
  return {
    schemaVersion: record.schemaVersion,
    commitSha: record.commitSha,
    treeSha: record.treeSha,
    buildIdentity: record.buildIdentity,
    runtimeIdentity: record.runtimeIdentity,
    deviceModel: record.deviceModel,
    iPadOSVersion: record.iPadOSVersion,
    webKitVersion: record.webKitVersion,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    fixtureIdentity: record.fixtureIdentity,
    checks: record.checks,
  };
}

function scenarioIdentity(record) {
  return `physical-ipad-scenario:${stableDigest(scenarioPayload(record))}`;
}

export function createPhysicalIPadScenarioOutput(input = {}) {
  const checks = {};
  for (const key of REQUIRED_IPAD_CHECKS) {
    const observed = input.checks?.[key] || {};
    checks[key] = deepFreeze({
      status: observed.status === 'passed' ? 'passed' : 'failed',
      observedAt: required(observed.observedAt, `ipad-scenario-${key}-observed-at-required`),
      observationIdentity: required(observed.observationIdentity, `ipad-scenario-${key}-identity-required`),
      detail: observed.detail == null ? null : String(observed.detail),
    });
  }
  const record = {
    schemaVersion: PHYSICAL_IPAD_SCENARIO_SCHEMA,
    commitSha: required(input.commitSha, 'ipad-scenario-commit-required').toLowerCase(),
    treeSha: required(input.treeSha, 'ipad-scenario-tree-required').toLowerCase(),
    buildIdentity: required(input.buildIdentity, 'ipad-scenario-build-required'),
    runtimeIdentity: required(input.runtimeIdentity, 'ipad-scenario-runtime-required'),
    deviceModel: required(input.deviceModel, 'ipad-scenario-device-required'),
    iPadOSVersion: required(input.iPadOSVersion, 'ipad-scenario-ipados-required'),
    webKitVersion: required(input.webKitVersion, 'ipad-scenario-webkit-required'),
    startedAt: required(input.startedAt, 'ipad-scenario-started-at-required'),
    completedAt: required(input.completedAt, 'ipad-scenario-completed-at-required'),
    fixtureIdentity: required(input.fixtureIdentity, 'ipad-scenario-fixture-required'),
    checks: deepFreeze(checks),
  };
  return deepFreeze({ ...record, scenarioId: scenarioIdentity(record) });
}

export function validatePhysicalIPadScenarioOutput(record, expected = {}) {
  if (!record || record.schemaVersion !== PHYSICAL_IPAD_SCENARIO_SCHEMA) return { ok: false, reason: 'ipad-scenario-schema-invalid' };
  if (record.scenarioId !== scenarioIdentity(record)) return { ok: false, reason: 'ipad-scenario-tampered' };
  if (!/^[0-9a-f]{40}$/.test(record.commitSha || '')) return { ok: false, reason: 'ipad-scenario-commit-invalid' };
  if (!/^[0-9a-f]{40}$/.test(record.treeSha || '')) return { ok: false, reason: 'ipad-scenario-tree-invalid' };
  for (const field of ['buildIdentity', 'runtimeIdentity', 'deviceModel', 'iPadOSVersion', 'webKitVersion', 'fixtureIdentity']) {
    if (typeof record[field] !== 'string' || !record[field].trim()) return { ok: false, reason: `ipad-scenario-${field}-invalid` };
  }
  const startedAt = Date.parse(record.startedAt);
  const completedAt = Date.parse(record.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return { ok: false, reason: 'ipad-scenario-time-invalid' };
  for (const [field, reason] of [
    ['commitSha', 'ipad-scenario-stale-commit'], ['treeSha', 'ipad-scenario-stale-tree'],
    ['buildIdentity', 'ipad-scenario-build-mismatch'], ['runtimeIdentity', 'ipad-scenario-runtime-mismatch'],
    ['deviceModel', 'ipad-scenario-device-mismatch'], ['iPadOSVersion', 'ipad-scenario-ipados-mismatch'],
    ['webKitVersion', 'ipad-scenario-webkit-mismatch'], ['fixtureIdentity', 'ipad-scenario-fixture-mismatch'],
  ]) if (expected[field] != null && record[field] !== expected[field]) return { ok: false, reason };
  const checkIds = Object.keys(record.checks || {}).sort();
  if (JSON.stringify(checkIds) !== JSON.stringify([...REQUIRED_IPAD_CHECKS].sort())) return { ok: false, reason: 'ipad-scenario-check-set-invalid' };
  const observations = new Set();
  for (const key of REQUIRED_IPAD_CHECKS) {
    const check = record.checks[key];
    if (!check || check.status !== 'passed') return { ok: false, reason: 'ipad-scenario-required-check-failed', check: key };
    if (!Number.isFinite(Date.parse(check.observedAt || ''))) return { ok: false, reason: 'ipad-scenario-check-time-invalid', check: key };
    if (typeof check.observationIdentity !== 'string' || !check.observationIdentity.trim() || observations.has(check.observationIdentity)) {
      return { ok: false, reason: 'ipad-scenario-check-identity-invalid', check: key };
    }
    observations.add(check.observationIdentity);
  }
  if (!record.deviceModel.toLowerCase().includes('ipad')) return { ok: false, reason: 'ipad-scenario-device-not-ipad' };
  return { ok: true, scenarioId: record.scenarioId };
}

export function createPhysicalIPadEvidence(input = {}) {
  const checks = {};
  for (const key of REQUIRED_IPAD_CHECKS) checks[key] = input.checks?.[key] === true;
  const record = {
    schemaVersion: PHYSICAL_IPAD_EVIDENCE_SCHEMA,
    commitSha: required(input.commitSha, 'ipad-evidence-commit-required').toLowerCase(),
    treeSha: required(input.treeSha, 'ipad-evidence-tree-required').toLowerCase(),
    buildIdentity: required(input.buildIdentity, 'ipad-evidence-build-required'),
    runtimeIdentity: required(input.runtimeIdentity, 'ipad-evidence-runtime-required'),
    deviceModel: required(input.deviceModel, 'ipad-evidence-device-required'),
    iPadOSVersion: required(input.iPadOSVersion, 'ipad-evidence-ipados-required'),
    webKitVersion: required(input.webKitVersion, 'ipad-evidence-webkit-required'),
    testedAt: required(input.testedAt, 'ipad-evidence-tested-at-required'),
    attestedBy: required(input.attestedBy, 'ipad-evidence-attestor-required'),
    fixtureIdentity: required(input.fixtureIdentity, 'ipad-evidence-fixture-required'),
    scenarioEvidenceIdentity: required(input.scenarioEvidenceIdentity, 'ipad-evidence-scenario-output-required'),
    checks: deepFreeze(checks),
    runtimeProfilesExercised: Object.freeze([...(input.runtimeProfilesExercised || [])].map(String).filter(Boolean).sort()),
    rebuildProfilesExercised: Object.freeze([...(input.rebuildProfilesExercised || [])].map(String).filter(Boolean).sort()),
    notesDigest: input.notesDigest == null ? null : String(input.notesDigest),
  };
  return deepFreeze({ ...record, evidenceId: evidenceIdentity(record) });
}

export function validatePhysicalIPadEvidence(record, expected = {}) {
  if (!record || record.schemaVersion !== PHYSICAL_IPAD_EVIDENCE_SCHEMA) return { ok: false, reason: 'ipad-evidence-schema-invalid' };
  const stringFields = ['commitSha','treeSha','buildIdentity','runtimeIdentity','deviceModel','iPadOSVersion','webKitVersion','testedAt','attestedBy','fixtureIdentity','scenarioEvidenceIdentity','evidenceId'];
  for (const key of stringFields) if (typeof record[key] !== 'string' || !record[key].trim()) return { ok: false, reason: `ipad-evidence-${key}-invalid` };
  if (!/^[0-9a-f]{40}$/.test(record.commitSha)) return { ok: false, reason: 'ipad-evidence-commit-invalid' };
  if (!/^[0-9a-f]{40}$/.test(record.treeSha)) return { ok: false, reason: 'ipad-evidence-tree-invalid' };
  const timestamp = Date.parse(record.testedAt);
  if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}T/.test(record.testedAt)) return { ok: false, reason: 'ipad-evidence-tested-at-invalid' };
  const expectedEvidenceId = evidenceIdentity(record);
  if (record.evidenceId !== expectedEvidenceId) return { ok: false, reason: 'ipad-evidence-tampered', expectedEvidenceId, observedEvidenceId: record.evidenceId };
  if (expected.commitSha && record.commitSha !== String(expected.commitSha).toLowerCase()) return { ok: false, reason: 'ipad-evidence-stale-commit' };
  if (expected.treeSha && record.treeSha !== String(expected.treeSha).toLowerCase()) return { ok: false, reason: 'ipad-evidence-stale-tree' };
  if (expected.buildIdentity && record.buildIdentity !== expected.buildIdentity) return { ok: false, reason: 'ipad-evidence-build-mismatch' };
  if (!ARTIFACT_IDENTITY.test(record.fixtureIdentity)) return { ok: false, reason: 'ipad-evidence-fixture-identity-invalid' };
  if (!ARTIFACT_IDENTITY.test(record.scenarioEvidenceIdentity)) return { ok: false, reason: 'ipad-evidence-scenario-output-identity-invalid' };
  if (typeof expected.resolveEvidenceIdentity !== 'function') return { ok: false, reason: 'ipad-evidence-identity-resolver-required' };
  if (expected.resolveEvidenceIdentity(record.fixtureIdentity, { kind: 'physical-ipad-fixture', record }) !== record.fixtureIdentity) return { ok: false, reason: 'ipad-evidence-fixture-unresolved' };
  if (expected.resolveEvidenceIdentity(record.scenarioEvidenceIdentity, { kind: 'physical-ipad-scenario-output', record }) !== record.scenarioEvidenceIdentity) return { ok: false, reason: 'ipad-evidence-scenario-output-unresolved' };
  const missingChecks = REQUIRED_IPAD_CHECKS.filter((key) => record.checks?.[key] !== true);
  if (missingChecks.length) return { ok: false, reason: 'ipad-evidence-required-check-missing', missingChecks };
  if (!record.deviceModel.toLowerCase().includes('ipad')) return { ok: false, reason: 'ipad-evidence-device-not-ipad' };
  return { ok: true, evidenceId: record.evidenceId };
}

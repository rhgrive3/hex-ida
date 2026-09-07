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
export const PHYSICAL_IPAD_NUMERIC_EVIDENCE_SCHEMA = 'hex-physical-ipad-numeric-evidence/v1';
export const FINAL_PLATFORM_EVIDENCE_SCHEMA = 'hex-final-platform-evidence/v1';
export const REQUIRED_FINAL_PLATFORM_WORKLOAD_IDS = Object.freeze([
  'H9-INITIAL-OPEN-METADATA',
  'H9-PAGED-BYTE-ACCESS',
  'H9-FIRST-DECODE-WINDOW',
  'H9-DISTANT-NAVIGATION',
  'H9-ACTIVE-FUNCTION-SEMANTIC-PIPELINE',
  'H9-FUNCTION-DISCOVERY-FIRST-USEFUL',
  'H9-DECOMPILER-FIRST-USEFUL',
  'H9-END-TO-END-TTFUA',
  'H9-PROJECT-SAVE-WARM-REOPEN',
  'H9-WORKER-CANCELLATION-SETTLEMENT',
  'H9-LARGE-LOGICAL-SOURCE-NO-WHOLE-READ',
  'H9-PATTERN-RULE-EVALUATION',
  'H9-REBUILD-VALIDATE-PUBLISH',
  'H9-VIRTUALIZED-RENDERING',
]);
const ARTIFACT_IDENTITY = /^artifact:[^@]+@sha256:[0-9a-f]{64}$/;
const DIGEST32_OR_64 = /^[0-9a-f]{32}$|^[0-9a-f]{64}$/;
const DIGEST64 = /^[0-9a-f]{64}$/;
const IPAD_MEMORY_LIMIT = 4 * 1024 * 1024 * 1024;

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

function profileCollection(value, code) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(code);
  const profiles = [];
  for (const profile of value) {
    if (typeof profile !== 'string' || !profile.trim()) throw new TypeError(code);
    profiles.push(profile.trim());
  }
  return Object.freeze([...new Set(profiles)].sort());
}

function numericRequired(value, code) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(code);
  return value.trim();
}

function numericDigest(value, code) {
  const normalized = numericRequired(value, code).toLowerCase();
  if (!DIGEST32_OR_64.test(normalized)) throw new TypeError(code);
  return normalized;
}

function numericSha(value, code) {
  const normalized = numericRequired(value, code).toLowerCase();
  if (!DIGEST64.test(normalized)) throw new TypeError(code);
  return normalized;
}

function numericDevice(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ipad-numeric-device-required');
  const model = numericRequired(input.model ?? input.deviceModel, 'ipad-numeric-device-model-required');
  const chip = numericRequired(input.chip ?? input.deviceChip, 'ipad-numeric-device-chip-required');
  const iPadOSVersion = numericRequired(input.iPadOSVersion, 'ipad-numeric-ipados-required');
  const webKitVersion = numericRequired(input.webKitVersion, 'ipad-numeric-webkit-required');
  const operatingSystem = numericRequired(input.operatingSystem ?? input.os, 'ipad-numeric-os-required');
  if (!model.toLowerCase().includes('ipad')) throw new TypeError('ipad-numeric-device-not-ipad');
  if (input.isPhysicalDevice !== true) throw new TypeError('ipad-numeric-physical-device-required');
  if (input.emulated !== false) throw new TypeError('ipad-numeric-emulation-forbidden');
  if (input.userAgentOverride !== false) throw new TypeError('ipad-numeric-user-agent-override-forbidden');
  if (!Number.isSafeInteger(input.memoryBytes) || input.memoryBytes <= 0 || input.memoryBytes > IPAD_MEMORY_LIMIT) {
    throw new TypeError('ipad-numeric-memory-invalid');
  }
  return {
    model,
    chip,
    memoryBytes: input.memoryBytes,
    iPadOSVersion,
    webKitVersion,
    operatingSystem,
    isPhysicalDevice: true,
    emulated: false,
    userAgentOverride: false,
  };
}

function numericTrace(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ipad-numeric-trace-required');
  const instrument = numericRequired(input.instrument ?? input.tool, 'ipad-numeric-instruments-required');
  if (instrument !== 'Apple Instruments') throw new TypeError('ipad-numeric-instruments-required');
  return {
    instrument,
    instrumentsVersion: numericRequired(input.instrumentsVersion, 'ipad-numeric-instruments-version-required'),
    xcodeVersion: numericRequired(input.xcodeVersion, 'ipad-numeric-xcode-version-required'),
    traceDigest: numericSha(input.traceDigest, 'ipad-numeric-trace-digest-invalid'),
  };
}

function numericMetricObject(metrics, code) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) throw new TypeError(`${code}-metrics-required`);
  const names = Object.keys(metrics).sort();
  if (names.length === 0) throw new TypeError(`${code}-metrics-empty`);
  const output = {};
  for (const name of names) {
    const value = metrics[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${code}-${name}-invalid`);
    output[name] = value;
  }
  return output;
}

function flattenPhysicalSamples(input) {
  if (input?.schemaVersion === FINAL_PLATFORM_EVIDENCE_SCHEMA) {
    const physicalRun = Array.isArray(input.runs)
      ? input.runs.find((run) => run?.runtimeClass === 'physical-ipad-supported-floor-v1')
      : null;
    if (!physicalRun || !Array.isArray(physicalRun.workloads)) throw new TypeError('ipad-numeric-physical-run-required');
    return physicalRun.workloads.flatMap((workload) => (Array.isArray(workload.samples) ? workload.samples : []).map((sample) => ({
      ...sample,
      workloadId: workload.workloadId,
      fixtureId: workload.fixtureId,
    })));
  }
  if (!Array.isArray(input?.samples)) throw new TypeError('ipad-numeric-samples-required');
  return input.samples;
}

function canonicalNumericSample(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`ipad-numeric-sample-${index}-required`);
  const workloadId = numericRequired(input.workloadId, `ipad-numeric-sample-${index}-workload-required`);
  if (!REQUIRED_FINAL_PLATFORM_WORKLOAD_IDS.includes(workloadId)) throw new TypeError(`ipad-numeric-sample-${index}-workload-invalid`);
  const fixtureId = numericRequired(input.fixtureId, `ipad-numeric-sample-${index}-fixture-required`);
  const phase = input.phase;
  if (phase !== 'warmup' && phase !== 'measured') throw new TypeError(`ipad-numeric-sample-${index}-phase-invalid`);
  if (!Number.isSafeInteger(input.index) || input.index < 0) throw new TypeError(`ipad-numeric-sample-${index}-index-invalid`);
  const metrics = numericMetricObject(input.metrics, `ipad-numeric-sample-${index}`);
  const processPeakPresent = Object.prototype.hasOwnProperty.call(metrics, 'processPeakFootprint');
  const traceIdentity = input.traceIdentity == null ? null : numericTrace(input.traceIdentity);
  if (phase === 'measured' && processPeakPresent && traceIdentity == null) {
    throw new TypeError(`ipad-numeric-sample-${index}-trace-required`);
  }
  return {
    workloadId,
    fixtureId,
    phase,
    index: input.index,
    metrics,
    ...(traceIdentity ? { traceIdentity } : {}),
  };
}

function numericEvidencePayload(record) {
  const { numericEvidenceId: ignoredNumericEvidenceId, ...payload } = record;
  void ignoredNumericEvidenceId;
  return payload;
}

function numericEvidenceIdentity(record) {
  return `physical-ipad-numeric:${stableDigest(numericEvidencePayload(record))}`;
}

function numericSampleDigest(samples) {
  return stableDigest({
    schemaVersion: PHYSICAL_IPAD_NUMERIC_EVIDENCE_SCHEMA,
    samples,
  });
}

/**
 * Create the numeric physical-iPad attachment. `finalPlatformEvidence` is
 * accepted as a convenience and is flattened to the physical runtime's raw
 * samples. No sample, summary, digest, target, or device field is invented.
 */
export function createPhysicalIPadNumericEvidence(input = {}) {
  const source = input.schemaVersion === PHYSICAL_IPAD_NUMERIC_EVIDENCE_SCHEMA
    ? input
    : (input.finalPlatformEvidence ?? input);
  const samples = flattenPhysicalSamples(source).map(canonicalNumericSample);
  if (samples.length === 0) throw new TypeError('ipad-numeric-samples-empty');
  const workloadIds = [...new Set(samples.map((sample) => sample.workloadId))].sort();
  if (JSON.stringify(workloadIds) !== JSON.stringify([...REQUIRED_FINAL_PLATFORM_WORKLOAD_IDS].sort())) {
    throw new TypeError('ipad-numeric-workload-denominator-invalid');
  }
  const measuredSamples = samples.filter((sample) => sample.phase === 'measured');
  if (measuredSamples.length === 0) throw new TypeError('ipad-numeric-measured-samples-required');
  const candidateCommitSha = numericRequired(
    source.candidateCommitSha ?? source.commitSha,
    'ipad-numeric-commit-required',
  ).toLowerCase();
  const candidateTreeSha = numericRequired(
    source.candidateTreeSha ?? source.treeSha,
    'ipad-numeric-tree-required',
  ).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(candidateCommitSha)) throw new TypeError('ipad-numeric-commit-invalid');
  if (!/^[0-9a-f]{40}$/.test(candidateTreeSha)) throw new TypeError('ipad-numeric-tree-invalid');
  const buildIdentity = numericRequired(source.buildIdentity, 'ipad-numeric-build-required');
  const runtimeIdentity = numericRequired(source.runtimeIdentity, 'ipad-numeric-runtime-required');
  const fixtureSetDigest = numericDigest(source.fixtureSetDigest, 'ipad-numeric-fixture-set-digest-invalid');
  const rawSampleDigest = numericDigest(
    source.rawSampleDigest ?? source.sampleDigest,
    'ipad-numeric-raw-sample-digest-invalid',
  );
  const sourceEvidenceId = numericRequired(
    input.sourceEvidenceId ?? source.evidenceId,
    'ipad-numeric-source-evidence-required',
  );
  if (!sourceEvidenceId.startsWith('final-platform:')) throw new TypeError('ipad-numeric-source-evidence-invalid');
  const physicalRun = source.schemaVersion === FINAL_PLATFORM_EVIDENCE_SCHEMA
    ? source.runs?.find((run) => run?.runtimeClass === 'physical-ipad-supported-floor-v1')
    : null;
  const browserOrWebKitVersion = numericRequired(
    input.browserOrWebKitVersion ?? source.browserOrWebKitVersion ?? physicalRun?.browserOrWebKitVersion ?? source.webKitVersion,
    'ipad-numeric-browser-version-required',
  );
  const device = numericDevice(input.device ?? physicalRun?.device ?? source.device ?? input);
  const fixtureIdentity = input.fixtureIdentity ?? source.fixtureIdentity ?? null;
  if (fixtureIdentity != null && !ARTIFACT_IDENTITY.test(fixtureIdentity)) {
    throw new TypeError('ipad-numeric-fixture-identity-invalid');
  }
  const scenarioEvidenceIdentity = input.scenarioEvidenceIdentity ?? source.scenarioEvidenceIdentity ?? null;
  if (scenarioEvidenceIdentity != null && !ARTIFACT_IDENTITY.test(scenarioEvidenceIdentity)) {
    throw new TypeError('ipad-numeric-scenario-identity-invalid');
  }
  const traceIdentities = [];
  for (const sample of measuredSamples) {
    if (Object.prototype.hasOwnProperty.call(sample.metrics, 'processPeakFootprint')) {
      if (!sample.traceIdentity) throw new TypeError('ipad-numeric-peak-trace-required');
      traceIdentities.push({
        workloadId: sample.workloadId,
        fixtureId: sample.fixtureId,
        sampleIndex: sample.index,
        ...sample.traceIdentity,
      });
    }
  }
  if (traceIdentities.length === 0) throw new TypeError('ipad-numeric-peak-trace-required');
  const record = {
    schemaVersion: PHYSICAL_IPAD_NUMERIC_EVIDENCE_SCHEMA,
    candidateCommitSha,
    candidateTreeSha,
    buildIdentity,
    runtimeIdentity,
    fixtureSetDigest,
    browserOrWebKitVersion,
    physicalRuntimeClass: 'physical-ipad-supported-floor-v1',
    device,
    sourceEvidenceId,
    rawSampleDigest,
    numericSampleDigest: numericSampleDigest(samples),
    ...(fixtureIdentity ? { fixtureIdentity } : {}),
    ...(scenarioEvidenceIdentity ? { scenarioEvidenceIdentity } : {}),
    workloadIds,
    sampleCount: samples.length,
    measuredSampleCount: measuredSamples.length,
    measured: true,
    samples,
    traceIdentities,
    ...(source.schemaVersion === FINAL_PLATFORM_EVIDENCE_SCHEMA
      ? { finalPlatformEvidence: source }
      : (input.finalPlatformEvidence?.schemaVersion === FINAL_PLATFORM_EVIDENCE_SCHEMA
        ? { finalPlatformEvidence: input.finalPlatformEvidence }
        : {})),
  };
  return deepFreeze({ ...record, numericEvidenceId: numericEvidenceIdentity(record) });
}

export function validatePhysicalIPadNumericEvidence(record, expected = {}) {
  if (!record || record.schemaVersion !== PHYSICAL_IPAD_NUMERIC_EVIDENCE_SCHEMA) {
    return { ok: false, reason: 'ipad-numeric-schema-invalid' };
  }
  let canonical;
  try {
    canonical = createPhysicalIPadNumericEvidence(record);
  } catch (error) {
    return { ok: false, reason: error?.message || 'ipad-numeric-invalid' };
  }
  if (record.numericEvidenceId !== canonical.numericEvidenceId) return { ok: false, reason: 'ipad-numeric-tampered' };
  if (record.numericSampleDigest !== canonical.numericSampleDigest) return { ok: false, reason: 'ipad-numeric-sample-digest-mismatch' };
  if (JSON.stringify(record.workloadIds) !== JSON.stringify([...REQUIRED_FINAL_PLATFORM_WORKLOAD_IDS].sort())) {
    return { ok: false, reason: 'ipad-numeric-workload-denominator-invalid' };
  }
  if (record.measured !== true || !Number.isSafeInteger(record.sampleCount) || record.sampleCount <= 0) {
    return { ok: false, reason: 'ipad-numeric-measured-invalid' };
  }
  if (expected.candidateCommitSha && record.candidateCommitSha !== String(expected.candidateCommitSha).toLowerCase()) return { ok: false, reason: 'ipad-numeric-stale-commit' };
  if (expected.candidateTreeSha && record.candidateTreeSha !== String(expected.candidateTreeSha).toLowerCase()) return { ok: false, reason: 'ipad-numeric-stale-tree' };
  for (const [field, reason] of [
    ['buildIdentity', 'ipad-numeric-build-mismatch'],
    ['runtimeIdentity', 'ipad-numeric-runtime-mismatch'],
    ['fixtureSetDigest', 'ipad-numeric-fixture-set-digest-mismatch'],
    ['sourceEvidenceId', 'ipad-numeric-source-evidence-mismatch'],
    ['browserOrWebKitVersion', 'ipad-numeric-browser-version-mismatch'],
    ['fixtureIdentity', 'ipad-numeric-fixture-identity-mismatch'],
    ['scenarioEvidenceIdentity', 'ipad-numeric-scenario-identity-mismatch'],
  ]) if (expected[field] != null && record[field] !== expected[field]) return { ok: false, reason };
  for (const [field, reason] of [
    ['model', 'ipad-numeric-device-model-mismatch'],
    ['chip', 'ipad-numeric-device-chip-mismatch'],
    ['memoryBytes', 'ipad-numeric-device-memory-mismatch'],
    ['iPadOSVersion', 'ipad-numeric-ipados-mismatch'],
    ['webKitVersion', 'ipad-numeric-webkit-mismatch'],
  ]) if (expected[field] != null && record.device[field] !== expected[field]) return { ok: false, reason };
  if (JSON.stringify(record) !== JSON.stringify(canonical)) return { ok: false, reason: 'ipad-numeric-noncanonical' };
  return { ok: true, numericEvidenceId: record.numericEvidenceId, rawSampleDigest: record.rawSampleDigest };
}

function isCanonicalProfileCollection(value) {
  if (!Array.isArray(value)) return false;
  try {
    const normalized = profileCollection(value, 'ipad-evidence-profile-collection-invalid');
    return JSON.stringify(value) === JSON.stringify(normalized);
  } catch {
    return false;
  }
}

function evidencePayload(record) {
  const payload = {
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
  if (record.numericEvidence != null) payload.numericEvidence = record.numericEvidence;
  return payload;
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
    runtimeProfilesExercised: profileCollection(input.runtimeProfilesExercised, 'ipad-evidence-runtime-profiles-invalid'),
    rebuildProfilesExercised: profileCollection(input.rebuildProfilesExercised, 'ipad-evidence-rebuild-profiles-invalid'),
    notesDigest: input.notesDigest == null ? null : String(input.notesDigest),
  };
  if (input.numericEvidence != null) {
    record.numericEvidence = createPhysicalIPadNumericEvidence({
      ...input.numericEvidence,
      fixtureIdentity: input.fixtureIdentity,
      scenarioEvidenceIdentity: input.scenarioEvidenceIdentity,
    });
  }
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
  if (!isCanonicalProfileCollection(record.runtimeProfilesExercised)) return { ok: false, reason: 'ipad-evidence-runtime-profiles-invalid' };
  if (!isCanonicalProfileCollection(record.rebuildProfilesExercised)) return { ok: false, reason: 'ipad-evidence-rebuild-profiles-invalid' };
  const expectedEvidenceId = evidenceIdentity(record);
  if (record.evidenceId !== expectedEvidenceId) return { ok: false, reason: 'ipad-evidence-tampered', expectedEvidenceId, observedEvidenceId: record.evidenceId };
  if (expected.commitSha && record.commitSha !== String(expected.commitSha).toLowerCase()) return { ok: false, reason: 'ipad-evidence-stale-commit' };
  if (expected.treeSha && record.treeSha !== String(expected.treeSha).toLowerCase()) return { ok: false, reason: 'ipad-evidence-stale-tree' };
  if (expected.buildIdentity && record.buildIdentity !== expected.buildIdentity) return { ok: false, reason: 'ipad-evidence-build-mismatch' };
  for (const [field, reason] of [
    ['runtimeIdentity', 'ipad-evidence-runtime-mismatch'],
    ['deviceModel', 'ipad-evidence-device-mismatch'],
    ['iPadOSVersion', 'ipad-evidence-ipados-mismatch'],
    ['webKitVersion', 'ipad-evidence-webkit-mismatch'],
  ]) if (expected[field] != null && record[field] !== expected[field]) return { ok: false, reason };
  if (!ARTIFACT_IDENTITY.test(record.fixtureIdentity)) return { ok: false, reason: 'ipad-evidence-fixture-identity-invalid' };
  if (!ARTIFACT_IDENTITY.test(record.scenarioEvidenceIdentity)) return { ok: false, reason: 'ipad-evidence-scenario-output-identity-invalid' };
  if (typeof expected.resolveEvidenceIdentity !== 'function') return { ok: false, reason: 'ipad-evidence-identity-resolver-required' };
  if (expected.resolveEvidenceIdentity(record.fixtureIdentity, { kind: 'physical-ipad-fixture', record }) !== record.fixtureIdentity) return { ok: false, reason: 'ipad-evidence-fixture-unresolved' };
  if (expected.resolveEvidenceIdentity(record.scenarioEvidenceIdentity, { kind: 'physical-ipad-scenario-output', record }) !== record.scenarioEvidenceIdentity) return { ok: false, reason: 'ipad-evidence-scenario-output-unresolved' };
  const missingChecks = REQUIRED_IPAD_CHECKS.filter((key) => record.checks?.[key] !== true);
  if (missingChecks.length) return { ok: false, reason: 'ipad-evidence-required-check-missing', missingChecks };
  if (!record.deviceModel.toLowerCase().includes('ipad')) return { ok: false, reason: 'ipad-evidence-device-not-ipad' };
  if (expected.requireNumericEvidence === true && record.numericEvidence == null) return { ok: false, reason: 'ipad-evidence-numeric-required' };
  if (record.numericEvidence != null) {
    const numeric = validatePhysicalIPadNumericEvidence(record.numericEvidence, {
      ...(expected.numericEvidence || {}),
      candidateCommitSha: record.commitSha,
      candidateTreeSha: record.treeSha,
      buildIdentity: record.buildIdentity,
      runtimeIdentity: record.runtimeIdentity,
      browserOrWebKitVersion: record.webKitVersion,
      model: record.deviceModel,
      iPadOSVersion: record.iPadOSVersion,
      webKitVersion: record.webKitVersion,
      fixtureIdentity: record.fixtureIdentity,
      scenarioEvidenceIdentity: record.scenarioEvidenceIdentity,
    });
    if (!numeric.ok) return { ok: false, reason: numeric.reason };
  }
  return { ok: true, evidenceId: record.evidenceId };
}

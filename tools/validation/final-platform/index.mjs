import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deepFreeze, stableDigest } from '../../../js/core/identity/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = path.resolve(HERE, '../../../specs/005-analysis-final-closure/contracts/final-platform-locks.json');

/**
 * The lock is the authority for the final-platform denominator.  This module
 * deliberately reads it from the repository rather than accepting a caller
 * supplied denominator.  A measurement packet can therefore carry samples,
 * but it cannot change the rows, fixtures, targets, or runtime classes which
 * the verifier evaluates.
 */
export const FINAL_PLATFORM_LOCKS = deepFreeze(JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')));
export const FINAL_PLATFORM_EVIDENCE_SCHEMA = 'hex-final-platform-evidence/v1';
export const FINAL_PLATFORM_SCHEMA = FINAL_PLATFORM_EVIDENCE_SCHEMA;
export const FINAL_PLATFORM_PHYSICAL_RUNTIME = 'physical-ipad-supported-floor-v1';
export const FINAL_PLATFORM_PRODUCTION_RUNTIME = 'production-faithful-webkit-v1';
export const FINAL_PLATFORM_RUNTIME_CLASSES = Object.freeze(
  FINAL_PLATFORM_LOCKS.runtimeClasses
    .filter((runtime) => runtime?.required === true)
    .map((runtime) => runtime.id),
);
export const FINAL_PLATFORM_WORKLOADS = Object.freeze(
  FINAL_PLATFORM_LOCKS.denominator.workloads.map((workload) => workload),
);
export const FINAL_PLATFORM_WORKLOAD_IDS = Object.freeze(
  FINAL_PLATFORM_WORKLOADS.map((workload) => workload.id),
);
export const FINAL_PLATFORM_FIXTURES = Object.freeze(
  FINAL_PLATFORM_LOCKS.denominator.fixtureSet.descriptor.fixtures.map((fixture) => fixture),
);
export const FINAL_PLATFORM_FIXTURE_SET_DIGEST = FINAL_PLATFORM_LOCKS.denominator.fixtureSet.stableDigest;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PHYSICAL_MEMORY_LIMIT = 4 * 1024 * 1024 * 1024;
const INTEGER_UNITS = new Set(['bytes', 'reads', 'items', 'objects', 'publications', 'tasks', 'rows', 'nodes', 'outputs']);

class FinalPlatformContractError extends TypeError {
  constructor(code, detail = null) {
    super(code);
    this.name = 'FinalPlatformContractError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = null) {
  throw new FinalPlatformContractError(code, detail);
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function text(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
}

function lowercaseSha(value, code) {
  const normalized = text(value, code).toLowerCase();
  if (!HEX40.test(normalized)) fail(code);
  return normalized;
}

function nonNegativeNumber(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(code);
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function exactSet(values, expected) {
  if (!Array.isArray(values)) return false;
  const observed = [...new Set(values)].sort();
  const wanted = [...new Set(expected)].sort();
  return observed.length === wanted.length && observed.every((value, index) => value === wanted[index]);
}

function workloadFor(id) {
  return FINAL_PLATFORM_WORKLOADS.find((workload) => workload.id === id) || null;
}

function fixtureFor(id) {
  return FINAL_PLATFORM_FIXTURES.find((fixture) => fixture.id === id) || null;
}

function fixtureDigest(fixture) {
  if (!fixture) return null;
  return fixture.sha256 || fixture.generatorSha256 || null;
}

function workloadMetricNames(workload) {
  if (!Array.isArray(workload?.targets) || workload.targets.length === 0) {
    fail(`final-platform-targets-missing:${workload?.id || 'UNKNOWN'}`);
  }
  const names = workload.targets.map((target) => target?.metric);
  if (names.some((name) => typeof name !== 'string' || name.trim() === '') || new Set(names).size !== names.length) {
    fail(`final-platform-targets-invalid:${workload.id}`);
  }
  return names;
}

function targetFor(workload, metric) {
  return workload.targets.find((target) => target.metric === metric) || null;
}

function canonicalTraceIdentity(input, code = 'final-platform-trace-identity-invalid') {
  object(input, code);
  const instrument = text(input.instrument ?? input.tool, code);
  const instrumentsVersion = text(input.instrumentsVersion, code);
  const xcodeVersion = text(input.xcodeVersion, code);
  const traceDigest = text(input.traceDigest, code).toLowerCase();
  if (instrument !== 'Apple Instruments') fail('final-platform-instruments-required');
  if (!HEX64.test(traceDigest)) fail('final-platform-trace-digest-invalid');
  return {
    instrument,
    instrumentsVersion,
    xcodeVersion,
    traceDigest,
  };
}

function canonicalDevice(input, runtimeClass) {
  object(input, 'final-platform-device-required');
  const model = text(input.model, 'final-platform-device-model-required');
  const operatingSystem = text(input.operatingSystem ?? input.os, 'final-platform-device-os-required');
  if (runtimeClass !== FINAL_PLATFORM_PHYSICAL_RUNTIME) {
    return { model, operatingSystem };
  }

  const chip = text(input.chip, 'final-platform-ipad-chip-required');
  const iPadOSVersion = text(input.iPadOSVersion, 'final-platform-ipados-version-required');
  const webKitVersion = text(input.webKitVersion, 'final-platform-device-webkit-required');
  if (input.isPhysicalDevice !== true) fail('final-platform-physical-device-required');
  if (input.emulated !== false) fail('final-platform-emulation-forbidden');
  if (input.userAgentOverride !== false) fail('final-platform-user-agent-override-forbidden');
  if (!Number.isSafeInteger(input.memoryBytes) || input.memoryBytes <= 0) fail('final-platform-device-memory-invalid');
  if (input.memoryBytes > PHYSICAL_MEMORY_LIMIT) fail('final-platform-device-memory-limit');
  if (!model.toLowerCase().includes('ipad')) fail('final-platform-device-not-ipad');
  return {
    model,
    operatingSystem,
    chip,
    memoryBytes: input.memoryBytes,
    iPadOSVersion,
    webKitVersion,
    isPhysicalDevice: true,
    emulated: false,
    userAgentOverride: false,
  };
}

function canonicalRuntimeAttestation(input, runtimeClass) {
  object(input, 'final-platform-runtime-attestation-required');
  const engine = text(input.engine, 'final-platform-engine-required');
  if (engine !== 'WebKit') fail('final-platform-webkit-engine-required');
  const runtimeActivationIdentity = text(input.runtimeActivationIdentity, 'final-platform-runtime-activation-identity-required');
  if (runtimeClass === FINAL_PLATFORM_PRODUCTION_RUNTIME) {
    if (input.productionOrigin !== true) fail('final-platform-production-origin-required');
    if (input.sameOriginIframe !== true) fail('final-platform-same-origin-iframe-required');
  }
  return {
    engine,
    runtimeActivationIdentity,
    ...(runtimeClass === FINAL_PLATFORM_PRODUCTION_RUNTIME
      ? { productionOrigin: true, sameOriginIframe: true }
      : {}),
  };
}

function canonicalMetrics(metrics, workload, codePrefix) {
  object(metrics, `${codePrefix}-metrics-required`);
  const metricNames = workloadMetricNames(workload);
  const keys = Object.keys(metrics).sort();
  const expected = [...metricNames].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${codePrefix}-metric-set-invalid`);
  }
  const normalized = {};
  for (const target of workload.targets) {
    const value = metrics[target.metric];
    if (target.unit === 'ratio' || target.unit === 'milliseconds') nonNegativeNumber(value, `${codePrefix}-${target.metric}-invalid`);
    else if (INTEGER_UNITS.has(target.unit)) nonNegativeInteger(value, `${codePrefix}-${target.metric}-invalid`);
    else nonNegativeNumber(value, `${codePrefix}-${target.metric}-invalid`);
    normalized[target.metric] = value;
  }
  return normalized;
}

function canonicalSample(input, workload, runtimeClass, sampleIndex, defaultTrace = null) {
  object(input, 'final-platform-sample-required');
  const phase = input.phase;
  if (phase !== 'warmup' && phase !== 'measured') fail('final-platform-sample-phase-invalid');
  const index = nonNegativeInteger(input.index, 'final-platform-sample-index-invalid');
  const metrics = canonicalMetrics(input.metrics, workload, `final-platform-sample-${phase}`);
  let traceIdentity = null;
  if (input.traceIdentity != null) traceIdentity = canonicalTraceIdentity(input.traceIdentity);
  else if (defaultTrace != null) traceIdentity = canonicalTraceIdentity(defaultTrace);
  if (runtimeClass === FINAL_PLATFORM_PHYSICAL_RUNTIME
    && phase === 'measured'
    && workload.targets.some((target) => target.metric === 'processPeakFootprint')) {
    if (!traceIdentity) fail(`final-platform-trace-missing:${workload.id}:${index}`);
  }
  return {
    phase,
    index,
    metrics,
    ...(traceIdentity ? { traceIdentity } : {}),
  };
}

function statisticFor(target, workload) {
  if (target.unit === 'milliseconds') return workload.repetitions.latencyStatistic;
  return workload.repetitions.memoryStatistic;
}

function summarizeValues(values, statistic) {
  const ordered = [...values].sort((left, right) => left - right);
  if (statistic === 'maximum') return ordered[ordered.length - 1];
  if (statistic === 'median') {
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  }
  if (statistic === 'p95') return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
  fail(`final-platform-statistic-invalid:${statistic}`);
}

function summarizeWorkload(workload, samples) {
  const measured = samples.filter((sample) => sample.phase === 'measured');
  if (measured.length !== workload.repetitions.measured) fail(`final-platform-measured-count-invalid:${workload.id}`);
  const metrics = {};
  for (const target of workload.targets) {
    const statistic = statisticFor(target, workload);
    const value = summarizeValues(measured.map((sample) => sample.metrics[target.metric]), statistic);
    metrics[target.metric] = { value, unit: target.unit, statistic };
  }
  return {
    measuredSampleCount: measured.length,
    metrics,
  };
}

function canonicalWorkload(input, runtimeClass) {
  object(input, 'final-platform-workload-result-required');
  const workloadId = text(input.workloadId ?? input.id, 'final-platform-workload-id-required');
  const workload = workloadFor(workloadId);
  if (!workload) fail(`final-platform-workload-unknown:${workloadId}`);
  const fixtureId = text(input.fixtureId, 'final-platform-fixture-id-required');
  if (!workload.fixtureIds.includes(fixtureId)) fail(`final-platform-fixture-not-in-workload:${workloadId}:${fixtureId}`);
  const fixture = fixtureFor(fixtureId);
  const expectedFixtureDigest = fixtureDigest(fixture);
  const exactFixtureSha256 = text(input.exactFixtureSha256 ?? input.fixtureSha256, 'final-platform-exact-fixture-digest-required').toLowerCase();
  if (!HEX64.test(exactFixtureSha256) || exactFixtureSha256 !== expectedFixtureDigest) {
    fail(`final-platform-fixture-digest-mismatch:${fixtureId}`);
  }
  if (!Array.isArray(input.samples) || input.samples.length === 0) fail(`final-platform-samples-required:${workloadId}:${fixtureId}`);
  const defaultTrace = input.traceIdentity == null ? null : canonicalTraceIdentity(input.traceIdentity);
  const samples = input.samples.map((sample, index) => canonicalSample(sample, workload, runtimeClass, index, defaultTrace));
  const warmupCount = samples.filter((sample) => sample.phase === 'warmup').length;
  const measuredCount = samples.filter((sample) => sample.phase === 'measured').length;
  if (warmupCount !== workload.repetitions.warmup) fail(`final-platform-warmup-count-invalid:${workloadId}:${fixtureId}`);
  if (measuredCount !== workload.repetitions.measured) fail(`final-platform-measured-count-invalid:${workloadId}:${fixtureId}`);
  const indices = { warmup: [], measured: [] };
  for (const sample of samples) indices[sample.phase].push(sample.index);
  for (const phase of ['warmup', 'measured']) {
    const expected = Array.from({ length: workload.repetitions[phase] }, (_, index) => index);
    if (JSON.stringify(indices[phase].sort((a, b) => a - b)) !== JSON.stringify(expected)) {
      fail(`final-platform-sample-indices-invalid:${workloadId}:${fixtureId}:${phase}`);
    }
  }
  const summary = summarizeWorkload(workload, samples);
  return {
    workloadId,
    fixtureId,
    exactFixtureSha256,
    samples,
    summary,
  };
}

function canonicalRun(input) {
  object(input, 'final-platform-runtime-result-required');
  const runtimeClass = text(input.runtimeClass, 'final-platform-runtime-class-required');
  if (!FINAL_PLATFORM_RUNTIME_CLASSES.includes(runtimeClass)) fail(`final-platform-runtime-class-invalid:${runtimeClass}`);
  const browserOrWebKitVersion = text(input.browserOrWebKitVersion, 'final-platform-browser-version-required');
  const measurementHarnessDigest = text(input.measurementHarnessDigest, 'final-platform-harness-digest-required').toLowerCase();
  if (!HEX64.test(measurementHarnessDigest)) fail('final-platform-harness-digest-invalid');
  const device = canonicalDevice(input.device, runtimeClass);
  const runtimeAttestation = canonicalRuntimeAttestation(input.runtimeAttestation, runtimeClass);
  const workloadInputs = input.workloads ?? input.workloadResults;
  if (!Array.isArray(workloadInputs)) fail(`final-platform-workloads-required:${runtimeClass}`);
  const expectedKeys = [];
  for (const workload of FINAL_PLATFORM_WORKLOADS) {
    for (const fixtureId of workload.fixtureIds) expectedKeys.push(`${workload.id}\u0000${fixtureId}`);
  }
  const observedKeys = workloadInputs.map((entry) => `${entry?.workloadId ?? entry?.id}\u0000${entry?.fixtureId}`);
  if (observedKeys.some((key) => key.endsWith('\u0000undefined')) || new Set(observedKeys).size !== observedKeys.length
    || !exactSet(observedKeys, expectedKeys)) {
    fail(`final-platform-workload-denominator-invalid:${runtimeClass}`);
  }
  const workloads = workloadInputs
    .map((entry) => canonicalWorkload(entry, runtimeClass))
    .sort((left, right) => {
      const leftKey = `${left.workloadId}\u0000${left.fixtureId}`;
      const rightKey = `${right.workloadId}\u0000${right.fixtureId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return { runtimeClass, browserOrWebKitVersion, measurementHarnessDigest, device, runtimeAttestation, workloads };
}

function canonicalCandidate(input) {
  object(input, 'final-platform-evidence-required');
  const candidateCommitSha = lowercaseSha(input.candidateCommitSha ?? input.commitSha, 'final-platform-candidate-commit-invalid');
  const candidateTreeSha = lowercaseSha(input.candidateTreeSha ?? input.treeSha, 'final-platform-candidate-tree-invalid');
  const buildIdentity = text(input.buildIdentity, 'final-platform-build-identity-required');
  const runtimeIdentity = text(input.runtimeIdentity, 'final-platform-runtime-identity-required');
  const fixtureSetDigest = text(input.fixtureSetDigest, 'final-platform-fixture-set-digest-required').toLowerCase();
  if (fixtureSetDigest !== FINAL_PLATFORM_FIXTURE_SET_DIGEST) fail('final-platform-fixture-set-digest-mismatch');
  return { candidateCommitSha, candidateTreeSha, buildIdentity, runtimeIdentity, fixtureSetDigest };
}

function rawSamplePayload(record) {
  return {
    schemaVersion: FINAL_PLATFORM_EVIDENCE_SCHEMA,
    candidateCommitSha: record.candidateCommitSha,
    candidateTreeSha: record.candidateTreeSha,
    buildIdentity: record.buildIdentity,
    runtimeIdentity: record.runtimeIdentity,
    fixtureSetDigest: record.fixtureSetDigest,
    runs: record.runs.map((run) => ({
      runtimeClass: run.runtimeClass,
      browserOrWebKitVersion: run.browserOrWebKitVersion,
      measurementHarnessDigest: run.measurementHarnessDigest,
      device: run.device,
      runtimeAttestation: run.runtimeAttestation,
      workloads: run.workloads.map((workload) => ({
        workloadId: workload.workloadId,
        fixtureId: workload.fixtureId,
        exactFixtureSha256: workload.exactFixtureSha256,
        samples: workload.samples,
      })),
    })),
  };
}

function evidencePayload(record) {
  const { evidenceId: ignoredEvidenceId, ...payload } = record;
  void ignoredEvidenceId;
  return payload;
}

function expectedWorkloadKeys() {
  return FINAL_PLATFORM_WORKLOADS.flatMap((workload) => workload.fixtureIds.map((fixtureId) => `${workload.id}\u0000${fixtureId}`));
}

function runtimeSort(left, right) {
  return FINAL_PLATFORM_RUNTIME_CLASSES.indexOf(left.runtimeClass) - FINAL_PLATFORM_RUNTIME_CLASSES.indexOf(right.runtimeClass);
}

/**
 * Build a complete packet from raw samples.  This function never fills in a
 * missing measurement: all lock rows, fixture identities, repetitions, and
 * target metric values must be present in `input.runs`.
 */
export function createFinalPlatformEvidence(input = {}) {
  const candidate = canonicalCandidate(input);
  if (!Array.isArray(input.runs) || input.runs.length === 0) fail('final-platform-runs-required');
  if (!exactSet(input.runs.map((run) => run?.runtimeClass), FINAL_PLATFORM_RUNTIME_CLASSES)
    || input.runs.length !== FINAL_PLATFORM_RUNTIME_CLASSES.length) {
    fail('final-platform-runtime-denominator-invalid');
  }
  const runs = input.runs.map(canonicalRun).sort(runtimeSort);
  const record = {
    schemaVersion: FINAL_PLATFORM_EVIDENCE_SCHEMA,
    ...candidate,
    runs,
  };
  const rawSampleDigest = stableDigest(rawSamplePayload(record));
  const withRawDigest = { ...record, rawSampleDigest };
  return deepFreeze({
    ...withRawDigest,
    evidenceId: `final-platform:${stableDigest(evidencePayload(withRawDigest))}`,
  });
}

function mismatchReason(error) {
  return error?.code || (error instanceof Error ? error.message : 'final-platform-contract-invalid');
}

function compareSummary(observed, expected, workloadId, fixtureId) {
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return `final-platform-summary-missing:${workloadId}:${fixtureId}`;
  if (observed.measuredSampleCount !== expected.measuredSampleCount) return `final-platform-summary-count-mismatch:${workloadId}:${fixtureId}`;
  if (stableDigest(observed.metrics) !== stableDigest(expected.metrics)) return `final-platform-summary-mismatch:${workloadId}:${fixtureId}`;
  return null;
}

function passesTarget(value, target) {
  if (target.operator === '<=') return value <= target.threshold;
  if (target.operator === '>=') return value >= target.threshold;
  if (target.operator === '==') return value === target.threshold;
  return false;
}

function validateLockTargets() {
  for (const workload of FINAL_PLATFORM_WORKLOADS) {
    if (workload.required !== true) return `final-platform-workload-not-required:${workload.id}`;
    if (!Array.isArray(workload.runtimeClassIds) || !exactSet(workload.runtimeClassIds, FINAL_PLATFORM_RUNTIME_CLASSES)) {
      return `final-platform-workload-runtime-lock-invalid:${workload.id}`;
    }
    if (!Array.isArray(workload.targets) || workload.targets.length === 0) return `final-platform-targetless:${workload.id}`;
    const seen = new Set();
    for (const target of workload.targets) {
      if (typeof target?.metric !== 'string' || !target.metric || typeof target?.unit !== 'string' || !target.unit
        || !['<=', '>=', '=='].includes(target?.operator) || !Number.isFinite(target?.threshold)) {
        return `final-platform-target-invalid:${workload.id}`;
      }
      if (seen.has(target.metric)) return `final-platform-target-duplicate:${workload.id}:${target.metric}`;
      seen.add(target.metric);
    }
  }
  return null;
}

function validatePhysicalRun(run, expected = {}) {
  if (run.device.isPhysicalDevice !== true) return 'final-platform-physical-device-required';
  if (run.device.emulated !== false) return 'final-platform-emulation-forbidden';
  if (run.device.userAgentOverride !== false) return 'final-platform-user-agent-override-forbidden';
  if (expected.deviceModel != null && run.device.model !== expected.deviceModel) return 'final-platform-device-model-mismatch';
  if (expected.deviceChip != null && run.device.chip !== expected.deviceChip) return 'final-platform-device-chip-mismatch';
  if (expected.deviceMemoryBytes != null && run.device.memoryBytes !== expected.deviceMemoryBytes) return 'final-platform-device-memory-mismatch';
  if (expected.iPadOSVersion != null && run.device.iPadOSVersion !== expected.iPadOSVersion) return 'final-platform-ipados-version-mismatch';
  if (expected.webKitVersion != null && run.device.webKitVersion !== expected.webKitVersion) return 'final-platform-webkit-version-mismatch';
  return null;
}

/**
 * Verify a packet against the frozen lock.  The returned object is suitable
 * for a release gate; callers must check `ok === true`.  No packet-provided
 * target, denominator, or status can relax the lock.
 */
export function validateFinalPlatformEvidence(record, expected = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, reason: 'final-platform-evidence-required' };
  if (record.schemaVersion !== FINAL_PLATFORM_EVIDENCE_SCHEMA) return { ok: false, reason: 'final-platform-schema-invalid' };
  const lockError = validateLockTargets();
  if (lockError) return { ok: false, reason: lockError };
  let canonical;
  try {
    canonical = createFinalPlatformEvidence(record);
  } catch (error) {
    return { ok: false, reason: mismatchReason(error) };
  }
  if (record.rawSampleDigest !== canonical.rawSampleDigest) return { ok: false, reason: 'final-platform-raw-sample-digest-mismatch' };
  if (record.evidenceId !== canonical.evidenceId) return { ok: false, reason: 'final-platform-evidence-tampered', expectedEvidenceId: canonical.evidenceId };
  if (stableDigest(record) !== stableDigest(canonical)) return { ok: false, reason: 'final-platform-canonical-form-invalid' };
  if (record.candidateCommitSha !== String(expected.candidateCommitSha ?? expected.commitSha ?? record.candidateCommitSha).toLowerCase()) {
    return { ok: false, reason: 'final-platform-stale-commit' };
  }
  if (record.candidateTreeSha !== String(expected.candidateTreeSha ?? expected.treeSha ?? record.candidateTreeSha).toLowerCase()) {
    return { ok: false, reason: 'final-platform-stale-tree' };
  }
  for (const [field, reason] of [
    ['buildIdentity', 'final-platform-build-mismatch'],
    ['runtimeIdentity', 'final-platform-runtime-mismatch'],
    ['fixtureSetDigest', 'final-platform-fixture-set-digest-mismatch'],
  ]) {
    if (expected[field] != null && record[field] !== expected[field]) return { ok: false, reason };
  }
  if (record.runs.length !== FINAL_PLATFORM_RUNTIME_CLASSES.length) return { ok: false, reason: 'final-platform-runtime-count-invalid' };
  for (const run of record.runs) {
    if (expected.runtimeClass != null && run.runtimeClass !== expected.runtimeClass) return { ok: false, reason: 'final-platform-runtime-class-mismatch' };
    if (expected.browserOrWebKitVersion != null && run.browserOrWebKitVersion !== expected.browserOrWebKitVersion) {
      return { ok: false, reason: 'final-platform-browser-version-mismatch' };
    }
    if (expected.measurementHarnessDigest != null && run.measurementHarnessDigest !== expected.measurementHarnessDigest) {
      return { ok: false, reason: 'final-platform-harness-digest-mismatch' };
    }
    if (run.runtimeClass === FINAL_PLATFORM_PHYSICAL_RUNTIME) {
      const physicalError = validatePhysicalRun(run, expected);
      if (physicalError) return { ok: false, reason: physicalError };
    }
    for (const workloadResult of run.workloads) {
      const workload = workloadFor(workloadResult.workloadId);
      const summaryError = compareSummary(
        workloadResult.summary,
        summarizeWorkload(workload, workloadResult.samples),
        workloadResult.workloadId,
        workloadResult.fixtureId,
      );
      if (summaryError) return { ok: false, reason: summaryError };
      for (const target of workload.targets) {
        const observed = workloadResult.summary.metrics[target.metric]?.value;
        if (!passesTarget(observed, target)) {
          return {
            ok: false,
            reason: `final-platform-target-failed:${run.runtimeClass}:${workload.id}:${workloadResult.fixtureId}:${target.metric}`,
            metric: target.metric,
            value: observed,
            operator: target.operator,
            threshold: target.threshold,
          };
        }
      }
    }
  }
  const allWorkloadKeys = record.runs.flatMap((run) => run.workloads.map((workload) => `${run.runtimeClass}\u0000${workload.workloadId}\u0000${workload.fixtureId}`));
  if (allWorkloadKeys.length !== FINAL_PLATFORM_RUNTIME_CLASSES.length * expectedWorkloadKeys().length
    || new Set(allWorkloadKeys).size !== allWorkloadKeys.length) {
    return { ok: false, reason: 'final-platform-denominator-shrink' };
  }
  return {
    ok: true,
    evidenceId: record.evidenceId,
    rawSampleDigest: record.rawSampleDigest,
    runtimeClasses: [...FINAL_PLATFORM_RUNTIME_CLASSES],
    workloadIds: [...FINAL_PLATFORM_WORKLOAD_IDS],
  };
}

export const verifyFinalPlatformEvidence = validateFinalPlatformEvidence;
export const verifyFinalPlatformPacket = validateFinalPlatformEvidence;
export const validateFinalPlatformPacket = validateFinalPlatformEvidence;

function abortIfNeeded(signal) {
  if (signal?.aborted) fail('final-platform-collection-aborted');
}

function snapshotRuntimeContext(input) {
  object(input, 'final-platform-runtime-context-required');
  let device;
  let runtimeAttestation;
  try {
    device = structuredClone(input.device);
    runtimeAttestation = structuredClone(input.runtimeAttestation);
  } catch {
    fail('final-platform-runtime-context-not-cloneable');
  }
  return deepFreeze({
    runtimeClass: input.runtimeClass,
    browserOrWebKitVersion: input.browserOrWebKitVersion,
    measurementHarnessDigest: input.measurementHarnessDigest,
    device,
    runtimeAttestation,
  });
}

/**
 * Collect every locked sample by invoking the caller's real measurement
 * callback.  The callback is intentionally mandatory and receives no default
 * metric values.  A physical run therefore cannot be represented by a
 * desktop/emulated placeholder or by an UNMEASURED status.
 */
export async function collectFinalPlatformEvidence(input = {}) {
  object(input, 'final-platform-collector-options-required');
  const measure = input.measure ?? input.measureSample;
  if (typeof measure !== 'function') fail('final-platform-measure-callback-required');
  const runtimeInputs = input.runtimes ?? input.runtimeContexts;
  if (!Array.isArray(runtimeInputs) || runtimeInputs.length !== FINAL_PLATFORM_RUNTIME_CLASSES.length) {
    fail('final-platform-runtime-contexts-required');
  }
  if (!exactSet(runtimeInputs.map((runtime) => runtime?.runtimeClass), FINAL_PLATFORM_RUNTIME_CLASSES)) {
    fail('final-platform-runtime-context-denominator-invalid');
  }
  const runtimes = runtimeInputs.map(snapshotRuntimeContext);
  const runs = [];
  for (const runtime of runtimes) {
    const workloadResults = [];
    for (const workload of FINAL_PLATFORM_WORKLOADS) {
      const fixtureResults = [];
      for (const fixtureId of workload.fixtureIds) {
        abortIfNeeded(input.signal);
        const fixture = fixtureFor(fixtureId);
        const samples = [];
        const phases = [
          ...Array.from({ length: workload.repetitions.warmup }, (_, index) => ['warmup', index]),
          ...Array.from({ length: workload.repetitions.measured }, (_, index) => ['measured', index]),
        ];
        for (const [phase, index] of phases) {
          abortIfNeeded(input.signal);
          const result = await measure(Object.freeze({
            runtimeClass: runtime.runtimeClass,
            browserOrWebKitVersion: runtime.browserOrWebKitVersion,
            measurementHarnessDigest: runtime.measurementHarnessDigest,
            device: runtime.device,
            runtimeAttestation: runtime.runtimeAttestation,
            workloadId: workload.id,
            fixtureId,
            fixture,
            phase,
            sampleIndex: index,
            repetitions: workload.repetitions,
            targets: workload.targets,
            signal: input.signal ?? null,
          }));
          abortIfNeeded(input.signal);
          object(result, 'final-platform-measurement-result-required');
          if (result.status != null && result.status !== 'measured') fail(`final-platform-measurement-status-invalid:${result.status}`);
          const metrics = result.metrics ?? result.sample?.metrics;
          if (!metrics) fail(`final-platform-measurement-metrics-missing:${runtime.runtimeClass}:${workload.id}:${fixtureId}:${phase}:${index}`);
          samples.push({
            phase,
            index,
            metrics,
            ...(result.traceIdentity ? { traceIdentity: result.traceIdentity } : {}),
          });
        }
        fixtureResults.push({
          workloadId: workload.id,
          fixtureId,
          exactFixtureSha256: fixtureDigest(fixture),
          samples,
        });
      }
      workloadResults.push(...fixtureResults);
    }
    runs.push({
      runtimeClass: runtime.runtimeClass,
      browserOrWebKitVersion: runtime.browserOrWebKitVersion,
      measurementHarnessDigest: runtime.measurementHarnessDigest,
      device: runtime.device,
      runtimeAttestation: runtime.runtimeAttestation,
      workloads: workloadResults,
    });
  }
  return createFinalPlatformEvidence({
    candidateCommitSha: input.candidateCommitSha ?? input.commitSha,
    candidateTreeSha: input.candidateTreeSha ?? input.treeSha,
    buildIdentity: input.buildIdentity,
    runtimeIdentity: input.runtimeIdentity,
    fixtureSetDigest: input.fixtureSetDigest ?? FINAL_PLATFORM_FIXTURE_SET_DIGEST,
    runs,
  });
}

export const createFinalPlatformCollector = collectFinalPlatformEvidence;
export const collectFinalPlatformPacket = collectFinalPlatformEvidence;
export const collectFinalPlatformMeasurements = collectFinalPlatformEvidence;
export const summarizeFinalPlatformEvidence = (record) => {
  const checked = validateFinalPlatformEvidence(record);
  if (!checked.ok) fail(checked.reason);
  return deepFreeze({
    evidenceId: record.evidenceId,
    rawSampleDigest: record.rawSampleDigest,
    runs: record.runs.map((run) => ({
      runtimeClass: run.runtimeClass,
      workloads: run.workloads.map((workload) => ({
        workloadId: workload.workloadId,
        fixtureId: workload.fixtureId,
        summary: workload.summary,
      })),
    })),
  });
};

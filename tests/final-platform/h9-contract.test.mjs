import assert from 'node:assert/strict';

import {
  collectFinalPlatformEvidence,
  createFinalPlatformEvidence,
  FINAL_PLATFORM_FIXTURE_SET_DIGEST,
  FINAL_PLATFORM_PHYSICAL_RUNTIME,
  validateFinalPlatformEvidence,
} from '../../tools/validation/final-platform/index.mjs';
import {
  createPhysicalIPadEvidence,
  createPhysicalIPadNumericEvidence,
  createPhysicalIPadScenarioOutput,
  validatePhysicalIPadEvidence,
  validatePhysicalIPadNumericEvidence,
} from '../../js/platform/physical-ipad-evidence.js';
import { validateStage2PhysicalEvidenceRecord } from '../../tools/validation/stage2/verify.mjs';

const commitSha = '1'.repeat(40);
const treeSha = '2'.repeat(40);
const traceDigest = '3'.repeat(64);
const fixtureIdentity = 'artifact:reports/stage2/fixture.bin@sha256:' + '4'.repeat(64);
const scenarioEvidenceIdentity = 'artifact:reports/stage2/ipad-output.json@sha256:' + '5'.repeat(64);
const resolver = (identity) => [fixtureIdentity, scenarioEvidenceIdentity].includes(identity) ? identity : null;

function metricValue(target) {
  if (target.operator === '==') return target.threshold;
  if (target.unit === 'milliseconds' || target.unit === 'ratio') return target.threshold / 2;
  return Math.min(1, target.threshold);
}

function makeRuntimeContexts() {
  return [
    {
      runtimeClass: 'production-faithful-webkit-v1',
      browserOrWebKitVersion: 'WebKit desktop test',
      measurementHarnessDigest: '6'.repeat(64),
      runtimeAttestation: {
        engine: 'WebKit',
        runtimeActivationIdentity: 'userscript-runtime:production-test',
        productionOrigin: true,
        sameOriginIframe: true,
      },
      device: { model: 'MacBook test', operatingSystem: 'macOS test' },
    },
    {
      runtimeClass: FINAL_PLATFORM_PHYSICAL_RUNTIME,
      browserOrWebKitVersion: 'WebKit iPad test',
      measurementHarnessDigest: '7'.repeat(64),
      runtimeAttestation: {
        engine: 'WebKit',
        runtimeActivationIdentity: 'userscript-runtime:ipad-test',
      },
      device: {
        model: 'iPad mini 6',
        chip: 'A15',
        memoryBytes: 4 * 1024 * 1024 * 1024,
        iPadOSVersion: '27.0-test',
        webKitVersion: 'WebKit iPad test',
        operatingSystem: 'iPadOS 27.0-test',
        isPhysicalDevice: true,
        emulated: false,
        userAgentOverride: false,
      },
    },
  ];
}

function makeMeasurement({ runtimeClass, targets }) {
  const metrics = Object.fromEntries(targets.map((target) => [target.metric, metricValue(target)]));
  if (runtimeClass === FINAL_PLATFORM_PHYSICAL_RUNTIME
    && targets.some((target) => target.metric === 'processPeakFootprint')) {
    return {
      metrics,
      traceIdentity: {
        instrument: 'Apple Instruments',
        instrumentsVersion: '17.0-test',
        xcodeVersion: '17.0-test',
        traceDigest,
      },
    };
  }
  return { metrics };
}

async function completePacket() {
  return collectFinalPlatformEvidence({
    candidateCommitSha: commitSha,
    candidateTreeSha: treeSha,
    buildIdentity: 'build:final-platform-test',
    runtimeIdentity: 'runtime:final-platform-test',
    fixtureSetDigest: FINAL_PLATFORM_FIXTURE_SET_DIGEST,
    runtimes: makeRuntimeContexts(),
    measure: makeMeasurement,
  });
}

const packet = await completePacket();
assert.equal(validateFinalPlatformEvidence(packet).ok, true);
assert.equal(validateStage2PhysicalEvidenceRecord(packet, {
  finalMode: true,
  headSha: commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
}).reason, 'physical-ipad-evidence-required');
assert.equal(packet.runs.length, 2);
assert.equal(packet.runs.every((run) => run.workloads.length === 35), true);
assert.equal(new Set(packet.runs.flatMap((run) => run.workloads.map((workload) => workload.workloadId))).size, 14);

const mutatedSample = structuredClone(packet);
const firstMetric = Object.keys(mutatedSample.runs[0].workloads[0].samples[0].metrics)[0];
mutatedSample.runs[0].workloads[0].samples[0].metrics[firstMetric] = 999;
assert.equal(validateFinalPlatformEvidence(mutatedSample).reason, 'final-platform-raw-sample-digest-mismatch');

const nonFiniteSample = structuredClone(packet);
nonFiniteSample.runs[0].workloads[0].samples[0].metrics[firstMetric] = Number.NaN;
assert.match(validateFinalPlatformEvidence(nonFiniteSample).reason, /final-platform-sample-warmup-.*-invalid|raw-sample-digest-mismatch/);

const summaryOnly = structuredClone(packet);
delete summaryOnly.runs[0].workloads[0].samples;
assert.match(validateFinalPlatformEvidence(summaryOnly).reason, /samples-required/);

const missingRow = structuredClone(packet);
missingRow.runs[0].workloads.pop();
assert.match(validateFinalPlatformEvidence(missingRow).reason, /workload-denominator-invalid|denominator-shrink/);

for (const workloadId of packet.runs[0].workloads.map((workload) => workload.workloadId)
  .filter((id, index, values) => values.indexOf(id) === index)) {
  const rowMutation = structuredClone(packet);
  const row = rowMutation.runs[0].workloads.find((workload) => workload.workloadId === workloadId);
  const sample = row.samples.find((candidate) => candidate.phase === 'measured');
  const metric = Object.keys(sample.metrics)[0];
  sample.metrics[metric] = Number.NaN;
  assert.equal(validateFinalPlatformEvidence(rowMutation).ok, false, `mutation must fail for ${workloadId}`);
}

const staleFixture = structuredClone(packet);
staleFixture.runs[0].workloads[0].exactFixtureSha256 = '8'.repeat(64);
assert.match(validateFinalPlatformEvidence(staleFixture).reason, /fixture-digest-mismatch|raw-sample-digest-mismatch/);

const staleBuild = structuredClone(packet);
staleBuild.buildIdentity = 'build:stale';
assert.match(validateFinalPlatformEvidence(staleBuild).reason, /raw-sample-digest-mismatch|tampered|build-mismatch/);

const missingRuntimeAttestation = structuredClone(packet);
delete missingRuntimeAttestation.runs[0].runtimeAttestation;
assert.equal(validateFinalPlatformEvidence(missingRuntimeAttestation).reason, 'final-platform-runtime-attestation-required');

const simulated = structuredClone(packet);
simulated.runs.find((run) => run.runtimeClass === FINAL_PLATFORM_PHYSICAL_RUNTIME).device.isPhysicalDevice = false;
assert.match(validateFinalPlatformEvidence(simulated).reason, /physical-device-required|raw-sample-digest-mismatch/);

const physicalTraceMissing = structuredClone(packet);
const physicalRun = physicalTraceMissing.runs.find((run) => run.runtimeClass === FINAL_PLATFORM_PHYSICAL_RUNTIME);
const peakWorkload = physicalRun.workloads.find((workload) => workload.samples.some((sample) => Object.hasOwn(sample.metrics, 'processPeakFootprint') && sample.phase === 'measured'));
delete peakWorkload.samples.find((sample) => Object.hasOwn(sample.metrics, 'processPeakFootprint') && sample.phase === 'measured').traceIdentity;
assert.match(validateFinalPlatformEvidence(physicalTraceMissing).reason, /trace-missing|raw-sample-digest-mismatch/);

const targetOverride = structuredClone(packet);
targetOverride.targets = [{ metric: 'processPeakFootprint', unit: 'bytes', operator: '<=', threshold: Number.MAX_SAFE_INTEGER }];
assert.match(validateFinalPlatformEvidence(targetOverride).reason, /tampered|canonical-form-invalid/);

const abortController = new AbortController();
abortController.abort();
await assert.rejects(
  collectFinalPlatformEvidence({
    candidateCommitSha: commitSha,
    candidateTreeSha: treeSha,
    buildIdentity: 'build:final-platform-test',
    runtimeIdentity: 'runtime:final-platform-test',
    runtimes: makeRuntimeContexts(),
    signal: abortController.signal,
    measure: makeMeasurement,
  }),
  /final-platform-collection-aborted/,
);
await assert.rejects(
  collectFinalPlatformEvidence({ runtimes: makeRuntimeContexts() }),
  /final-platform-measure-callback-required/,
);
await assert.rejects(
  collectFinalPlatformEvidence({
    candidateCommitSha: commitSha,
    candidateTreeSha: treeSha,
    buildIdentity: 'build:final-platform-test',
    runtimeIdentity: 'runtime:final-platform-test',
    runtimes: makeRuntimeContexts(),
    measure: () => ({ status: 'UNMEASURED' }),
  }),
  /final-platform-measurement-status-invalid:UNMEASURED/,
);

const numeric = createPhysicalIPadNumericEvidence({ finalPlatformEvidence: packet });
assert.equal(validatePhysicalIPadNumericEvidence(numeric, {
  candidateCommitSha: commitSha,
  candidateTreeSha: treeSha,
  buildIdentity: packet.buildIdentity,
  runtimeIdentity: packet.runtimeIdentity,
  fixtureSetDigest: FINAL_PLATFORM_FIXTURE_SET_DIGEST,
  sourceEvidenceId: packet.evidenceId,
  browserOrWebKitVersion: 'WebKit iPad test',
  model: 'iPad mini 6',
  chip: 'A15',
  memoryBytes: 4 * 1024 * 1024 * 1024,
  iPadOSVersion: '27.0-test',
  webKitVersion: 'WebKit iPad test',
}).ok, true);

const numericMutation = structuredClone(numeric);
numericMutation.samples[0].metrics[Object.keys(numericMutation.samples[0].metrics)[0]] = Number.NaN;
assert.equal(validatePhysicalIPadNumericEvidence(numericMutation).ok, false);
assert.throws(() => createPhysicalIPadNumericEvidence({
  ...numeric,
  samples: numeric.samples.filter((sample) => sample.workloadId !== 'H9-VIRTUALIZED-RENDERING'),
}), /ipad-numeric-workload-denominator-invalid/);

const checks = {};
for (const key of ['runtimeActivationIdentity', 'openNontrivialBinary', 'demandDrivenNavigation', 'cancellation', 'workerLifecycleRecovery', 'indexedDbProjectRoundTrip', 'variableLengthViewer', 'semanticDecompilerWorkflow', 'memoryBudget', 'phase12UiPath']) checks[key] = true;
const scenarioChecks = Object.fromEntries(Object.keys(checks).map((key, index) => [key, {
  status: 'passed',
  observedAt: `2026-08-22T00:00:${String(index).padStart(2, '0')}Z`,
  observationIdentity: `physical-observation:${key}:numeric-test`,
}]));
const scenario = createPhysicalIPadScenarioOutput({
  commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
  runtimeIdentity: packet.runtimeIdentity,
  deviceModel: 'iPad mini 6',
  iPadOSVersion: '27.0-test',
  webKitVersion: 'WebKit iPad test',
  startedAt: '2026-08-22T00:00:00Z',
  completedAt: '2026-08-22T00:01:00Z',
  fixtureIdentity,
  checks: scenarioChecks,
});
const physical = createPhysicalIPadEvidence({
  commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
  runtimeIdentity: packet.runtimeIdentity,
  deviceModel: 'iPad mini 6',
  iPadOSVersion: '27.0-test',
  webKitVersion: 'WebKit iPad test',
  testedAt: '2026-08-22T00:00:00Z',
  attestedBy: 'numeric-test-attestor',
  fixtureIdentity,
  scenarioEvidenceIdentity,
  checks,
  numericEvidence: numeric,
});
assert.equal(validatePhysicalIPadEvidence(physical, {
  commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
  resolveEvidenceIdentity: resolver,
  requireNumericEvidence: true,
  numericEvidence: { sourceEvidenceId: packet.evidenceId },
}).ok, true);
assert.equal(validateStage2PhysicalEvidenceRecord(physical, {
  finalMode: true,
  headSha: commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
  resolveEvidenceIdentity: resolver,
}).ok, true);

const wrongSourceNumeric = createPhysicalIPadNumericEvidence({
  finalPlatformEvidence: packet,
  sourceEvidenceId: `final-platform:${'8'.repeat(64)}`,
  fixtureIdentity,
  scenarioEvidenceIdentity,
});
const wrongSourcePhysical = createPhysicalIPadEvidence({
  commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
  runtimeIdentity: packet.runtimeIdentity,
  deviceModel: 'iPad mini 6',
  iPadOSVersion: '27.0-test',
  webKitVersion: 'WebKit iPad test',
  testedAt: '2026-08-22T00:00:00Z',
  attestedBy: 'numeric-test-attestor',
  fixtureIdentity,
  scenarioEvidenceIdentity,
  checks,
  numericEvidence: wrongSourceNumeric,
});
assert.equal(validateStage2PhysicalEvidenceRecord(wrongSourcePhysical, {
  finalMode: true,
  headSha: commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
  resolveEvidenceIdentity: resolver,
}).reason, 'physical-ipad-final-source-evidence-mismatch');

const wrongRuntimePacket = createFinalPlatformEvidence({
  ...packet,
  runtimeIdentity: 'runtime:wrong-pair',
  runs: packet.runs,
});
const wrongRuntimeNumeric = createPhysicalIPadNumericEvidence({
  finalPlatformEvidence: wrongRuntimePacket,
  fixtureIdentity,
  scenarioEvidenceIdentity,
});
const wrongRuntimePhysical = createPhysicalIPadEvidence({
  commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
  runtimeIdentity: packet.runtimeIdentity,
  deviceModel: 'iPad mini 6',
  iPadOSVersion: '27.0-test',
  webKitVersion: 'WebKit iPad test',
  testedAt: '2026-08-22T00:00:00Z',
  attestedBy: 'numeric-test-attestor',
  fixtureIdentity,
  scenarioEvidenceIdentity,
  checks,
  numericEvidence: wrongRuntimeNumeric,
});
assert.equal(validateStage2PhysicalEvidenceRecord(wrongRuntimePhysical, {
  finalMode: true,
  headSha: commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
  resolveEvidenceIdentity: resolver,
}).reason, 'ipad-numeric-runtime-mismatch');

const denominatorMutation = structuredClone(packet);
denominatorMutation.runs[0].workloads.pop();
const denominatorNumeric = createPhysicalIPadNumericEvidence({
  finalPlatformEvidence: denominatorMutation,
  fixtureIdentity,
  scenarioEvidenceIdentity,
});
const denominatorPhysical = createPhysicalIPadEvidence({
  commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
  runtimeIdentity: packet.runtimeIdentity,
  deviceModel: 'iPad mini 6',
  iPadOSVersion: '27.0-test',
  webKitVersion: 'WebKit iPad test',
  testedAt: '2026-08-22T00:00:00Z',
  attestedBy: 'numeric-test-attestor',
  fixtureIdentity,
  scenarioEvidenceIdentity,
  checks,
  numericEvidence: denominatorNumeric,
});
assert.match(
  validateStage2PhysicalEvidenceRecord(denominatorPhysical, {
    finalMode: true,
    headSha: commitSha,
    treeSha,
    buildIdentity: packet.buildIdentity,
    resolveEvidenceIdentity: resolver,
  }).reason,
  /final-platform-workload-denominator-invalid|final-platform-denominator-shrink/,
);

const booleanOnly = createPhysicalIPadEvidence({
  commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
  runtimeIdentity: packet.runtimeIdentity,
  deviceModel: 'iPad mini 6',
  iPadOSVersion: '27.0-test',
  webKitVersion: 'WebKit iPad test',
  testedAt: '2026-08-22T00:00:00Z',
  attestedBy: 'boolean-only-test',
  fixtureIdentity,
  scenarioEvidenceIdentity,
  checks,
});
assert.equal(validatePhysicalIPadEvidence(booleanOnly, {
  commitSha,
  treeSha,
  buildIdentity: packet.buildIdentity,
  resolveEvidenceIdentity: resolver,
  requireNumericEvidence: true,
}).reason, 'ipad-evidence-numeric-required');

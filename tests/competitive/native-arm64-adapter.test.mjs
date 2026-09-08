import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  createNativeArm64CaptureAdapter,
  decodeNativeArm64Function,
  nativeArm64ArtifactIdFor,
  observeCorpus,
  validateNativeArm64FunctionRecord,
} from '../../tools/validation/phase8/decompile-corpus.mjs';
import {
  collectCompetitiveMeasurements,
  measurePhase8Quality,
  phase8CurrentObservations,
} from '../../tools/validation/competitive/measurements.mjs';
import { extractElfFunctionRecord, loadCorpus } from '../../tools/validation/phase8/build-corpus.mjs';
import { loadFrozenBaseline } from '../../tools/validation/phase8/metrics.mjs';

test('native ARM64 artifact identity stays separate from frozen function ids', () => {
  assert.equal(nativeArm64ArtifactIdFor({
    id:'quality.aggregate_array_stride.O0',
    source:'quality.c',
    optimization:'-O0',
    architectureId:'arm64',
  }), 'arm64-native-quality.c-O0');
  assert.equal(nativeArm64ArtifactIdFor({
    id:'x86_64.quality.aggregate_array_stride.O0',
    source:'quality.c',
    optimization:'-O0',
    architectureId:'x86_64',
  }), null);
});

test('native ARM64 decoding carries byte encoding and verifies direct branch targets', () => {
  // `b #0x1008; ret`, encoded little-endian as two A64 words.
  const instructions = decodeNativeArm64Function(Uint8Array.of(
    0x02, 0x00, 0x00, 0x14,
    0xc0, 0x03, 0x5f, 0xd6,
  ), { baseAddress:0x1000n, instructionIdPrefix:'test:native-arm64' });
  assert.equal(instructions.length, 2);
  assert.equal(instructions[0].instructionId, 'test:native-arm64:0');
  assert.equal(instructions[0].branchTarget, 0x1008n);
  assert.deepEqual([...instructions[0].rawBytes], [0x02, 0x00, 0x00, 0x14]);
  assert.equal(instructions[0].word, 0x14000002);
  assert.equal(instructions[1].mnemonic, 'ret');
  assert.equal(instructions[1].branchTarget, undefined);
});

test('native ARM64 byte decoder rejects a truncated fixed-width function', () => {
  assert.throws(
    () => decodeNativeArm64Function(Uint8Array.of(0xc0, 0x03), { baseAddress:0x1000n }),
    /phase8-native-arm64-capture-function-bytes-invalid/,
  );
});

test('invalid native capture preserves the selected frozen row and fails closed', () => {
  const frozen = loadCorpus();
  const entry = frozen.functions.find((row) => row.id === 'quality.aggregate_array_stride.O0');
  const sample = { ...frozen, functions:[entry] };
  const observations = observeCorpus({ corpus:sample, nativeArm64Capture:{} });
  assert.deepEqual(observations.map((row) => row.id), [entry.id]);
  assert.match(observations[0].failure, /phase8-native-arm64-capture-/);
  assert.equal(observations[0].semantic, undefined);
});

test('competitive phase 8 observation entry point forwards native capture identity', () => {
  const frozen = loadCorpus();
  const entry = frozen.functions.find((row) => row.id === 'quality.aggregate_array_stride.O0');
  const sample = { ...frozen, functions:[entry] };
  const observations = phase8CurrentObservations({ corpus:sample, capture:{} });
  assert.deepEqual(observations.map((row) => row.id), [entry.id]);
  assert.match(observations[0].failure, /phase8-native-arm64-capture-/);
  assert.equal(observations[0].semantic, undefined);
});

const trustedP8CaptureFixture = process.env.HEX_COMPETITIVE_P8_CAPTURE_FIXTURE;
test('validated native ARM64 adapter admits one full-corpus row and rejects identity/ELF boundary violations', {
  skip:trustedP8CaptureFixture == null ? 'trusted P8 capture fixture not configured' : false,
}, () => {
  const frozen = loadCorpus();
  const baseline = loadFrozenBaseline();
  assert.equal(frozen.functions.length, 135);
  assert.deepEqual(
    frozen.functions.map((row) => row.id),
    baseline.observations.map((row) => row.id),
    'native adapter must be admitted against the complete frozen ID/order authority',
  );

  const capture = JSON.parse(fs.readFileSync(trustedP8CaptureFixture, 'utf8'));
  const adapter = createNativeArm64CaptureAdapter({ corpus:frozen, capture });
  assert.ok(adapter);
  const entry = frozen.functions.find((row) => row.id === 'quality.aggregate_array_stride.O0');
  assert.equal(entry?.architectureId, 'arm64');

  // Only this one native function is decoded; the rest of the frozen corpus
  // is used for identity admission, never as an implicit full measurement.
  const admitted = adapter.decompile(entry, { decompilerTimeBudgetMs:20000, deterministicTransforms:true, phase8Optimize:true });
  assert.equal(admitted.failure, undefined);
  assert.equal(admitted.id, entry.id);
  assert.equal(admitted.result?.semantic, true);
  assert.equal(admitted.result?.ctx?.decompilerPipeline?.completeness, 'complete');
  assert.equal(admitted.result?.metrics?.rawAssemblyFallbacks, 0);

  const swappedFunction = adapter.decompile({ ...entry, function:'sccp_dead_branch' });
  assert.equal(swappedFunction.id, entry.id);
  assert.equal(swappedFunction.failure, 'phase8-native-arm64-entry-identity-mismatch');
  const foreignId = adapter.decompile({ ...entry, id:'foreign.quality.aggregate_array_stride.O0' });
  assert.equal(foreignId.failure, 'phase8-native-arm64-entry-identity-mismatch');

  const candidate = baseline.observations.map((observation) => ({
    ...observation,
    failure:null,
    semantic:true,
    readability:{
      ...observation.readability,
      gotos:Number.isSafeInteger(observation.readability?.gotos) ? observation.readability.gotos : 0,
      rawAssemblyFallbacks:Number.isSafeInteger(observation.readability?.rawAssemblyFallbacks)
        ? observation.readability.rawAssemblyFallbacks : 0,
    },
  }));
  candidate[0] = { ...candidate[0], observationMethod:'validated-native-arm64-capture' };
  const methodMismatch = measurePhase8Quality({
    metricId:'decompiler-quality-gotos',
    observations:candidate,
    capture,
  });
  assert.equal(methodMismatch.status, 'UNMEASURED');
  assert.equal(methodMismatch.candidateValue, null);
  assert.equal(methodMismatch.reason, 'phase8-reference-method-mismatch');
  const collected = collectCompetitiveMeasurements({
    capturesByMetric:{ 'decompiler-quality-gotos':capture },
    phase8Observations:candidate,
    phase8Corpus:frozen,
    phase8ObservationMethod:'validated-native-arm64-capture',
  });
  assert.equal(collected['decompiler-quality-gotos'].status, 'UNMEASURED');
  assert.equal(collected['decompiler-quality-gotos'].reason, 'phase8-reference-method-mismatch');

  const artifact = capture.artifacts.find((candidate) => candidate.id === 'arm64-native-quality.c-O0');
  assert.ok(artifact);
  const functionRecord = extractElfFunctionRecord(fs.readFileSync(artifact.debugArtifactPath), entry.function);
  assert.equal(functionRecord.elfType, 2);
  assert.equal(functionRecord.elfMachine, 183);
  assert.equal(functionRecord.relocationSectionCount, 0);
  assert.doesNotThrow(() => validateNativeArm64FunctionRecord(functionRecord, entry.id));
  const foreignMachineBytes = Buffer.from(fs.readFileSync(artifact.debugArtifactPath));
  foreignMachineBytes.writeUInt16LE(62, 0x12);
  const foreignMachineRecord = extractElfFunctionRecord(foreignMachineBytes, entry.function);
  assert.equal(foreignMachineRecord.elfMachine, 62);
  assert.throws(
    () => validateNativeArm64FunctionRecord(foreignMachineRecord, entry.id),
    /phase8-native-arm64-capture-function-machine-mismatch/,
  );
  assert.throws(
    () => validateNativeArm64FunctionRecord({ ...functionRecord, elfType:1, address:null }, entry.id),
    /phase8-native-arm64-capture-function-relocations-or-address-unavailable/,
  );
  assert.throws(
    () => validateNativeArm64FunctionRecord({ ...functionRecord, relocationSectionCount:1 }, entry.id),
    /phase8-native-arm64-capture-function-relocations-or-address-unavailable/,
  );
});

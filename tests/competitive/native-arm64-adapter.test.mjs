import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeNativeArm64Function,
  nativeArm64ArtifactIdFor,
  observeCorpus,
} from '../../tools/validation/phase8/decompile-corpus.mjs';
import { phase8CurrentObservations } from '../../tools/validation/competitive/measurements.mjs';
import { loadCorpus } from '../../tools/validation/phase8/build-corpus.mjs';

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

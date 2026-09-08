import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../../js/core/identity/index.js';
import { provenanceFromSourceMap } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import {
  loadFrozenBaseline,
  loadFrozenProvenance,
  loadNativeAuthority,
  provenanceCoverageFailures,
  validateNativeBaseline,
  validateFrozenProvenance,
  validateNativeProvenance,
} from '../../../tools/validation/phase8/metrics.mjs';

const baseline = loadFrozenBaseline();
const frozen = loadFrozenProvenance(undefined, baseline);

function candidateFor(reference, overrides = {}) {
  const provenance = {
    sourceAddresses:[...reference.sourceAddresses],
    sourceAddressesDigest:reference.sourceAddressesDigest,
    irProvenance:[...reference.irProvenance],
    irProvenanceDigest:reference.irProvenanceDigest,
    irProvenanceCount:reference.irProvenanceCount,
    ...overrides,
  };
  return { id:reference.id, semantic:true, provenance };
}

function withDigests(provenance) {
  return {
    ...provenance,
    sourceAddressesDigest:stableDigest(provenance.sourceAddresses),
    irProvenanceDigest:stableDigest(provenance.irProvenance),
    irProvenanceCount:provenance.irProvenance.length,
  };
}

function referenceCase() {
  const reference = frozen.observations.find((observation) => observation.available
    && observation.sourceAddresses.length > 1 && observation.irProvenanceCount > 1);
  assert.ok(reference, 'the frozen corpus must contain a semantic provenance reference');
  return reference;
}

test('the frozen provenance sidecar is self-consistent and immutable', () => {
  assert.deepEqual(validateFrozenProvenance(frozen, baseline), []);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.observations), true);
  assert.equal(Object.isFrozen(frozen.observations[0]), true);
  assert.equal(Object.isFrozen(frozen.observations[0].sourceAddresses), true);
  assert.equal(frozen.observationsDigest, stableDigest(frozen.observations));
  assert.equal(stableDigest(frozen.toolchain), stableDigest(baseline.toolchain));
});

test('the native paired authority is bound to its adapter and 135-row provenance', () => {
  const native = loadNativeAuthority();
  assert.deepEqual(validateNativeBaseline(native.baseline, { corpus:native.corpus, frozenBaseline:baseline }), []);
  assert.deepEqual(validateNativeProvenance(native.provenance, native.baseline, { corpus:native.corpus }), []);
  assert.equal(native.baseline.observations.length, 135);
  assert.equal(native.provenance.observations.length, 135);

  const swappedAdapter = structuredClone(native.baseline);
  swappedAdapter.reference.adapter.sourceSha256 = '0'.repeat(64);
  assert.ok(validateNativeBaseline(swappedAdapter, { corpus:native.corpus, frozenBaseline:baseline })
    .includes('native baseline adapter identity mismatch'));

  const mutatedCorpus = structuredClone(native.corpus);
  mutatedCorpus.functions[0].function = `${mutatedCorpus.functions[0].function}.foreign`;
  assert.throws(() => loadNativeAuthority({ corpus:mutatedCorpus }), /supplied corpus differs from repository corpus/);

  const swappedObservation = structuredClone(native.provenance);
  swappedObservation.observations[0].observationMethod = 'frozen-legacy-assembly';
  swappedObservation.observationsDigest = stableDigest(swappedObservation.observations);
  swappedObservation.provenanceDigest = stableDigest({
    schemaVersion:swappedObservation.schemaVersion,
    referenceDigest:swappedObservation.referenceDigest,
    baselineObservationsDigest:swappedObservation.baselineObservationsDigest,
    observationsDigest:swappedObservation.observationsDigest,
  });
  assert.ok(validateNativeProvenance(swappedObservation, native.baseline, { corpus:native.corpus })
    .includes('native provenance quality.aggregate_array_stride.O0 method mismatch'));
});

test('provenance extraction preserves coalesced 44-address / 166-IR identity sets', () => {
  const sourceMap = Array.from({ length:44 }, (_unused, index) => ({
    source:{ addresses:[BigInt(0x1000 + index * 4)], ir:[] },
  }));
  for (let index = 0; index < 166; index += 1) {
    sourceMap[index % sourceMap.length].source.ir.push(index);
  }
  const provenance = provenanceFromSourceMap(sourceMap);
  assert.equal(provenance.sourceAddresses.length, 44);
  assert.equal(provenance.irProvenance.length, 166);
  assert.equal(provenance.irProvenanceCount, 166);
  assert.equal(provenance.sourceAddressesDigest, stableDigest(provenance.sourceAddresses));
  assert.equal(provenance.irProvenanceDigest, stableDigest(provenance.irProvenance));
});

test('equal-cardinality source-address substitution is rejected', () => {
  const reference = referenceCase();
  const sourceAddresses = [...reference.sourceAddresses];
  sourceAddresses[0] = '__substituted-address__';
  sourceAddresses.sort();
  const candidate = candidateFor(reference, withDigests({
    sourceAddresses,
    irProvenance:[...reference.irProvenance],
  }));
  const failures = provenanceCoverageFailures([candidate], baseline, frozen);
  assert.ok(failures.some((failure) => failure.kind === 'source-provenance-not-superset'));
});

test('missing candidate provenance is rejected rather than treated as zero', () => {
  const reference = referenceCase();
  const failures = provenanceCoverageFailures([{ id:reference.id, semantic:true, provenance:null }], baseline, frozen);
  assert.ok(failures.some((failure) => failure.kind === 'candidate-provenance-missing'));
});

test('decreased IR provenance count remains telemetry, not a hard floor', () => {
  const reference = referenceCase();
  const irProvenance = reference.irProvenance.slice(0, -1);
  const candidate = candidateFor(reference, withDigests({
    sourceAddresses:[...reference.sourceAddresses],
    irProvenance,
  }));
  const failures = provenanceCoverageFailures([candidate], baseline, frozen);
  assert.equal(failures.some((failure) => failure.kind === 'ir-provenance-count-decreased'), false);
});

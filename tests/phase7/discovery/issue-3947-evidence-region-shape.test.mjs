import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDiscoveryEvidence,
  createFunctionCandidate,
} from '../../../js/analysis/discovery/candidates.js';
import {
  DiscoveryProducerRegistry,
  fuseFunctionCandidates,
} from '../../../js/analysis/discovery/fusion.js';

const validRegion = Object.freeze({ start: 0x1000, end: 0x1010, ownership: 'exclusive' });

function evidence(overrides = {}) {
  return {
    kind: 'prologue-candidate',
    start: 0x1000,
    regions: [],
    producerId: 'test-producer',
    ...overrides,
  };
}

test('canonical evidence and candidate constructors reject non-array region containers', () => {
  for (const regions of [{}, 'x', new Set([validRegion]), new Uint8Array([1])]) {
    assert.throws(
      () => createDiscoveryEvidence(evidence({ regions })),
      /discovery-evidence-invalid-regions/,
    );
    assert.throws(
      () => createFunctionCandidate({ start: 0x1000, regions }),
      /discovery-candidate-invalid-regions/,
    );
  }

  const sparse = Array(1);
  assert.throws(
    () => createDiscoveryEvidence(evidence({ regions: sparse })),
    /discovery-evidence-invalid-regions/,
  );
  assert.throws(
    () => createFunctionCandidate({ start: 0x1000, regions: sparse }),
    /discovery-candidate-invalid-regions/,
  );
});

test('fusion validates evidence before its sort comparator touches regions', () => {
  const base = evidence();
  assert.throws(
    () => fuseFunctionCandidates([
      { ...base, regions: {} },
      { ...base, regions: [] },
    ], { snapshotId: 'snapshot-1' }),
    /discovery-evidence-invalid-regions/,
  );
});

test('registry fails closed on malformed custom evidence instead of publishing a partial result', () => {
  const registry = new DiscoveryProducerRegistry();
  registry.register({
    id: 'a-valid',
    architectureId: null,
    produce() {
      return [evidence({ kind: 'loader-function-start', regions: [validRegion] })];
    },
  });
  registry.register({
    id: 'b-malformed',
    architectureId: null,
    produce() {
      return [evidence({ regions: 'not-regions' })];
    },
  });

  assert.throws(
    () => registry.collect({}, 'generic'),
    /discovery-evidence-invalid-regions/,
  );
});

test('valid canonical evidence keeps deterministic fusion semantics', () => {
  const authoritative = createDiscoveryEvidence({
    kind: 'loader-function-start',
    start: 0x1000,
    regions: [validRegion],
    producerId: 'loader',
  });
  const corroborating = createDiscoveryEvidence({
    kind: 'symbol-table',
    start: 0x1000,
    regions: [validRegion],
    producerId: 'symbols',
  });

  const forward = fuseFunctionCandidates([authoritative, corroborating], { snapshotId: 'snapshot-1' });
  const reversed = fuseFunctionCandidates([corroborating, authoritative], { snapshotId: 'snapshot-1' });

  assert.deepEqual(reversed, forward);
  assert.equal(forward.status.completeness, 'complete');
  assert.equal(forward.candidates.length, 1);
  assert.equal(forward.candidates[0].startState, 'exact');
  assert.equal(forward.candidates[0].extentState, 'exact');
  assert.deepEqual(forward.candidates[0].regions, [{ start: '4096', end: '4112', ownership: 'exclusive' }]);
});

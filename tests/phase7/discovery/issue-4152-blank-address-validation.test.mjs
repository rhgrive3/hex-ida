import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDiscoveryEvidence,
  createFunctionCandidate,
  createRegion,
} from '../../../js/analysis/discovery/candidates.js';
import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';
import { loaderProducer } from '../../../js/analysis/discovery/producers.js';

const BLANK_ADDRESSES = ['', '   ', '\t\n'];

test('canonical discovery boundaries reject blank address strings', () => {
  for (const start of BLANK_ADDRESSES) {
    assert.throws(
      () => createDiscoveryEvidence({ kind: 'loader-function-start', start }),
      /discovery-evidence-invalid-start/,
    );
    assert.throws(
      () => createFunctionCandidate({ start }),
      /discovery-candidate-invalid-start/,
    );
    assert.throws(
      () => createRegion({ start, end: '1' }),
      /discovery-region-invalid-start/,
    );
    assert.throws(
      () => createRegion({ start: '0', end: start }),
      /discovery-region-invalid-end/,
    );
  }
});

test('loader compatibility seeds ignore blanks without losing valid zero', () => {
  const evidence = loaderProducer.produce({
    image: {
      functions: [],
      functionStarts: ['', '   ', '0', '0x10', '4096'],
      unwindEntries: [],
    },
  });

  assert.deepEqual(
    evidence.map((item) => [item.kind, item.authority, item.start]),
    [
      ['loader-function-start', 'authoritative', '0'],
      ['loader-function-start', 'authoritative', '16'],
      ['loader-function-start', 'authoritative', '4096'],
    ],
  );

  const fused = fuseFunctionCandidates(evidence, { snapshotId: 'issue-4152' });
  assert.deepEqual(
    fused.candidates.map((candidate) => [candidate.start, candidate.startState]),
    [['0', 'exact'], ['16', 'exact'], ['4096', 'exact']],
  );
});

test('raw fusion evidence fails closed on blank starts', () => {
  for (const start of BLANK_ADDRESSES) {
    assert.throws(
      () => fuseFunctionCandidates([
        { kind: 'loader-function-start', start, producerId: 'issue-4152' },
      ], { snapshotId: 'issue-4152-direct' }),
      /discovery-evidence-invalid-start/,
    );
  }
});

test('valid primitive address forms keep their existing canonical values', () => {
  assert.equal(createDiscoveryEvidence({ kind: 'export', start: '0' }).start, '0');
  assert.equal(createDiscoveryEvidence({ kind: 'export', start: '0x1000' }).start, '4096');
  assert.equal(createDiscoveryEvidence({ kind: 'export', start: '4096' }).start, '4096');
  assert.equal(createDiscoveryEvidence({ kind: 'export', start: 4096n }).start, '4096');
  assert.equal(createDiscoveryEvidence({ kind: 'export', start: 4096 }).start, '4096');
});

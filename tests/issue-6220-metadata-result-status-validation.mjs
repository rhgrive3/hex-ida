import assert from 'node:assert/strict';
import {
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataResult,
  isCanonicalAnalysisStatus,
  isLanguageRecordAuthoritative,
  applyLanguageMetadataTypesToGraph,
} from '../js/metadata/provider.js';
import { createAnalysisStatus } from '../js/analysis/status.js';

console.log('Testing #6220: Language metadata status validation...');

const validIdentity = createLanguageMetadataIdentity({
  verdict: 'matched-authoritative',
  providerId: 'p',
  providerVersion: '1',
  ecosystem: 'swift',
  expected: 'build-A',
  observed: 'build-A',
});

const validRecord = createLanguageMetadataRecord({
  kind: 'type',
  entityId: 'type-A',
  providerId: 'p',
  providerVersion: '1',
  ecosystem: 'swift',
  descriptor: { layer: 'nominal', claim: { name: 'TypeA' } },
});

// 1. schemaVersion mismatch in input.status must be rejected
assert.throws(() => {
  createLanguageMetadataResult({
    identity: validIdentity,
    completeness: { complete: true },
    status: {
      schemaVersion: 999,
      snapshotId: 'snap-1',
      analyzerId: 'p',
      analyzerVersion: '1',
      completeness: 'complete',
      stopReason: null,
    },
  });
}, /metadata-result-invalid-status-schema/);

// 2. Canonical createAnalysisStatus output works normally
const canonicalStatus = createAnalysisStatus({
  snapshotId: 'snap-1',
  analyzerId: 'p',
  analyzerVersion: '1',
  completeness: 'complete',
  stopReason: null,
});

const validResult = createLanguageMetadataResult({
  identity: validIdentity,
  completeness: { complete: true },
  status: canonicalStatus,
});
assert.equal(isCanonicalAnalysisStatus(canonicalStatus), true);
assert.equal(isLanguageRecordAuthoritative(validResult, validRecord), true);

// 3. Forged raw status without canonical structure must not be authoritative
const forgedResult = {
  identity: validIdentity,
  completeness: { complete: true },
  status: {
    schemaVersion: 999, // non-canonical schemaVersion
    completeness: 'complete',
    stopReason: null,
  },
};
assert.equal(isLanguageRecordAuthoritative(forgedResult, validRecord), false);

// 4. Raw status missing required identity fields must not be authoritative
const missingFieldsResult = {
  identity: validIdentity,
  completeness: { complete: true },
  status: {
    schemaVersion: 1,
    completeness: 'complete',
    stopReason: null,
    // missing snapshotId, analyzerId, analyzerVersion
  },
};
assert.equal(isLanguageRecordAuthoritative(missingFieldsResult, validRecord), false);

// 5. Creator-invalid fields must not be accepted by the hard-authority guard.
const creatorInvalidStatuses = [
  { ...canonicalStatus, budgetClass: 'unbounded' },
  { ...canonicalStatus, evidenceIds: [{}] },
  { ...canonicalStatus, dependencyIds: [''] },
];
for (const status of creatorInvalidStatuses) {
  assert.equal(isCanonicalAnalysisStatus(status), false);
  assert.equal(isLanguageRecordAuthoritative({
    identity: validIdentity,
    completeness: { complete: true },
    status,
  }, validRecord), false);
}

// 6. Forged status must not emit hard constraints in applyLanguageMetadataTypesToGraph
const graphEvents = [];
const mockGraph = {
  addHardConstraint(c) { graphEvents.push({ type: 'hard', ...c }); },
  addSoftEvidence(e) { graphEvents.push({ type: 'soft', ...e }); },
};

applyLanguageMetadataTypesToGraph(mockGraph, forgedResult, { records: [validRecord] });
assert.equal(graphEvents.some((e) => e.type === 'hard'), false);
assert.equal(graphEvents.some((e) => e.type === 'soft'), true);

console.log('#6220 tests passed successfully.');

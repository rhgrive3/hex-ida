import assert from 'node:assert/strict';
import {
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
  isLanguageRecordAuthoritative,
  applyLanguageMetadataTypesToGraph,
  isCanonicalLanguageRecord,
  languageMetadataFunctionEvidence,
} from '../js/metadata/provider.js';

console.log('Testing #4845: Language metadata page record shape validation...');

const result = createLanguageMetadataResult({
  providerId: 'p',
  providerVersion: '1',
  ecosystem: 'x',
  identity: {
    verdict: 'matched-authoritative',
    providerId: 'p',
    providerVersion: '1',
    ecosystem: 'x',
    expected: 'same',
    observed: 'same',
  },
  completeness: {
    present: true,
    declared: 1,
    scanned: 1,
    parsed: 1,
    complete: true,
  },
});

// Forged record: not constructed with createLanguageMetadataRecord, missing providerId and ecosystem
const forgedRecord = {
  kind: 'type',
  entityId: 'entity-A',
  descriptor: { layer: 'nominal', claim: { name: 'ForgedType' } },
  evidenceIds: [],
  providerVersion: '1',
  buildIdentity: null,
};

// 1. isCanonicalLanguageRecord returns false for forged record
assert.equal(isCanonicalLanguageRecord(forgedRecord), false);

// 2. isLanguageRecordAuthoritative returns false for forged record even with matched-authoritative result
assert.equal(isLanguageRecordAuthoritative(result, forgedRecord), false);

// 3. createLanguageMetadataPage containing forged record must not emit hard constraints
const forgedPage = createLanguageMetadataPage({
  records: [forgedRecord],
});

const hardConstraints = [];
const mockGraph = {
  addHardConstraint(v) { hardConstraints.push(v); },
  addSoftEvidence() {},
};

applyLanguageMetadataTypesToGraph(mockGraph, result, forgedPage);
assert.equal(hardConstraints.length, 0);

// 4. Raw records that merely look canonical cannot smuggle non-canonical evidence provenance into authority.
const nonCanonicalEvidenceRecord = {
  kind: 'type',
  entityId: 'entity-A',
  name: null,
  address: null,
  sizeBytes: null,
  descriptor: { layer: 'nominal', claim: { name: 'RawType' } },
  providerId: 'p',
  providerVersion: '1',
  ecosystem: 'x',
  buildIdentity: null,
  evidenceIds: ['  ev-2  ', 'ev-1', 'ev-1'],
};
assert.equal(isCanonicalLanguageRecord(nonCanonicalEvidenceRecord), false);
assert.equal(isLanguageRecordAuthoritative(result, nonCanonicalEvidenceRecord), false);
applyLanguageMetadataTypesToGraph(
  mockGraph,
  result,
  createLanguageMetadataPage({ records: [nonCanonicalEvidenceRecord] }),
);
assert.equal(hardConstraints.length, 0);

const rawSymbol = {
  ...nonCanonicalEvidenceRecord,
  kind: 'symbol',
  entityId: 'fn-A',
  address: '0x1000',
  descriptor: null,
};
const rawFunctionEvidence = languageMetadataFunctionEvidence(
  result,
  createLanguageMetadataPage({ records: [rawSymbol] }),
);
assert.equal(rawFunctionEvidence.length, 1);
assert.equal(rawFunctionEvidence[0].confidence, 'heuristic');

// 5. Valid record created with createLanguageMetadataRecord works as expected and canonicalizes evidence IDs.
const validRecord = createLanguageMetadataRecord({
  kind: 'type',
  entityId: 'entity-A',
  providerId: 'p',
  providerVersion: '1',
  ecosystem: 'x',
  descriptor: { layer: 'nominal', claim: { name: 'ValidType' } },
  evidenceIds: ['  ev-2  ', 'ev-1', 'ev-1'],
});

assert.deepEqual(validRecord.evidenceIds, ['ev-1', 'ev-2']);
assert.equal(isCanonicalLanguageRecord(validRecord), true);
assert.equal(isLanguageRecordAuthoritative(result, validRecord), true);

const validPage = createLanguageMetadataPage({
  records: [validRecord],
});

applyLanguageMetadataTypesToGraph(mockGraph, result, validPage);
assert.equal(hardConstraints.length, 1);

// 6. Creator-branded records remain authoritative under existing matched-partial coverage.
const partialResult = createLanguageMetadataResult({
  providerId: 'p',
  providerVersion: '1',
  ecosystem: 'x',
  identity: {
    verdict: 'matched-partial',
    providerId: 'p',
    providerVersion: '1',
    ecosystem: 'x',
    expected: 'same',
    observed: 'same',
    coverage: { entityIds: ['entity-A'] },
  },
  completeness: {
    present: true,
    declared: 1,
    scanned: 1,
    parsed: 1,
    complete: true,
  },
});
assert.equal(isLanguageRecordAuthoritative(partialResult, validRecord), true);

console.log('#4845 tests passed successfully.');

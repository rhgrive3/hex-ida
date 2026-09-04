import assert from 'node:assert/strict';
import {
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
  isLanguageRecordAuthoritative,
  applyLanguageMetadataTypesToGraph,
  isCanonicalLanguageRecord,
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

// 4. Valid record created with createLanguageMetadataRecord works as expected
const validRecord = createLanguageMetadataRecord({
  kind: 'type',
  entityId: 'entity-A',
  providerId: 'p',
  providerVersion: '1',
  ecosystem: 'x',
  descriptor: { layer: 'nominal', claim: { name: 'ValidType' } },
});

assert.equal(isCanonicalLanguageRecord(validRecord), true);
assert.equal(isLanguageRecordAuthoritative(result, validRecord), true);

const validPage = createLanguageMetadataPage({
  records: [validRecord],
});

applyLanguageMetadataTypesToGraph(mockGraph, result, validPage);
assert.equal(hardConstraints.length, 1);

console.log('#4845 tests passed successfully.');

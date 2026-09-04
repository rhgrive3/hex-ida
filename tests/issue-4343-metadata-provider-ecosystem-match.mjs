import assert from 'node:assert/strict';
import {
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataResult,
  isLanguageRecordAuthoritative,
  applyLanguageMetadataTypesToGraph,
} from '../js/metadata/provider.js';

console.log('Testing #4343: Language metadata provider and ecosystem match...');

const result = createLanguageMetadataResult({
  identity: createLanguageMetadataIdentity({
    verdict: 'matched-authoritative',
    providerId: 'go-metadata',
    providerVersion: '1.0.0',
    ecosystem: 'go',
    binaryIdentity: 'bin-A',
  }),
  completeness: { complete: true },
});

const matchingRecord = createLanguageMetadataRecord({
  kind: 'type',
  entityId: 'go:type:Config',
  providerId: 'go-metadata',
  providerVersion: '1.0.0',
  ecosystem: 'go',
  descriptor: { layer: 'nominal', claim: { name: 'Config' } },
});

const foreignRecord = createLanguageMetadataRecord({
  kind: 'type',
  entityId: 'foreign:type',
  providerId: 'rust-metadata',
  providerVersion: '999',
  ecosystem: 'rust',
  descriptor: { layer: 'nominal', claim: { name: 'ForeignType' } },
});

const versionMismatchRecord = createLanguageMetadataRecord({
  kind: 'type',
  entityId: 'go:type:Config',
  providerId: 'go-metadata',
  providerVersion: '2.0.0',
  ecosystem: 'go',
  descriptor: { layer: 'nominal', claim: { name: 'Config' } },
});

// 1. Matching record is authoritative
assert.equal(isLanguageRecordAuthoritative(result, matchingRecord), true);

// 2. Foreign ecosystem/provider record must NOT be authoritative
assert.equal(isLanguageRecordAuthoritative(result, foreignRecord), false);

// 3. Provider version mismatch record must NOT be authoritative
assert.equal(isLanguageRecordAuthoritative(result, versionMismatchRecord), false);

// 4. In applyLanguageMetadataTypesToGraph, foreign record must not be added as hard constraint
const graphEvents = [];
const mockGraph = {
  addHardConstraint(c) { graphEvents.push({ type: 'hard', ...c }); },
  addSoftEvidence(e) { graphEvents.push({ type: 'soft', ...e }); },
};

applyLanguageMetadataTypesToGraph(mockGraph, result, { records: [matchingRecord, foreignRecord] });
assert.equal(graphEvents.filter((e) => e.type === 'hard').length, 1);
assert.equal(graphEvents.find((e) => e.type === 'hard').claim.entityId, 'go:type:Config');

console.log('#4343 tests passed successfully.');

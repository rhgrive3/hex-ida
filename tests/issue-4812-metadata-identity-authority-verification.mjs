import assert from 'node:assert/strict';
import { createAnalysisStatus } from '../js/analysis/status.js';
import {
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataResult,
  isLanguageRecordAuthoritative,
  applyLanguageMetadataTypesToGraph,
  languageMetadataFunctionEvidence,
} from '../js/metadata/provider.js';

console.log('Testing #4812: Language metadata plain identity authority verification...');

const status = createAnalysisStatus({
  snapshotId: 'snap-1',
  analyzerId: 'provider:test',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

const validIdentity = createLanguageMetadataIdentity({
  verdict: 'matched-authoritative',
  providerId: 'provider:test',
  providerVersion: '1.0.0',
  ecosystem: 'swift',
  expected: 'build-1',
  observed: 'build-1',
});

const record = createLanguageMetadataRecord({
  kind: 'type',
  entityId: 'type:T',
  providerId: 'provider:test',
  providerVersion: '1.0.0',
  ecosystem: 'swift',
  descriptor: { layer: 'nominal', claim: { name: 'T' } },
});

const funcRecord = createLanguageMetadataRecord({
  kind: 'symbol',
  entityId: 'sym:test',
  name: 'testFunc',
  address: '0x1000',
  providerId: 'provider:test',
  providerVersion: '1.0.0',
  ecosystem: 'swift',
});

// 1. Plain unvalidated identity must NOT be authoritative
const forgedResult = {
  identity: {
    verdict: 'matched-authoritative',
  },
  completeness: { complete: true },
  status,
};
assert.equal(isLanguageRecordAuthoritative(forgedResult, record), false);

// 2. Canonical createLanguageMetadataIdentity identity works normally
const canonicalResult = createLanguageMetadataResult({
  identity: validIdentity,
  completeness: { complete: true },
  status,
});
assert.equal(isLanguageRecordAuthoritative(canonicalResult, record), true);

// 3. Forged identity does not emit hard constraints
const graphEvents = [];
const mockGraph = {
  addHardConstraint(c) { graphEvents.push({ type: 'hard', ...c }); },
  addSoftEvidence(e) { graphEvents.push({ type: 'soft', ...e }); },
};
applyLanguageMetadataTypesToGraph(mockGraph, forgedResult, { records: [record] });
assert.equal(graphEvents.some((e) => e.type === 'hard'), false);
assert.equal(graphEvents.some((e) => e.type === 'soft'), true);

// 4. Forged identity function evidence is heuristic, not exact
const evidences = languageMetadataFunctionEvidence(forgedResult, { records: [funcRecord] });
assert.equal(evidences.length, 1);
assert.equal(evidences[0].confidence, 'heuristic');

const canonicalEvidences = languageMetadataFunctionEvidence(canonicalResult, { records: [funcRecord] });
assert.equal(canonicalEvidences.length, 1);
assert.equal(canonicalEvidences[0].confidence, 'exact');

console.log('#4812 tests passed successfully.');

import assert from 'node:assert/strict';
import { createAnalysisStatus } from '../js/analysis/status.js';
import {
  createLanguageMetadataIdentity,
  createLanguageMetadataPage,
  createLanguageMetadataRecord,
  createLanguageMetadataResult,
  languageMetadataFunctionEvidence,
} from '../js/metadata/provider.js';

function record(address) {
  return createLanguageMetadataRecord({
    kind: 'symbol',
    entityId: 'sym:test',
    name: 'f',
    address,
    providerId: 'metadata.test',
    providerVersion: '1',
    ecosystem: 'test',
  });
}

for (const bad of [
  'not-an-address', '-1', '+1', '0x', '0x-1', '1.0', '1e3', 'NaN', 'Infinity', '0b10', '0o10',
]) {
  assert.throws(
    () => record(bad),
    /metadata-record-invalid-address/,
    `${bad} must not become a canonical metadata address`,
  );
}

for (const bad of [0, 1n, true, ['0x10'], { toString() { throw new Error('must not coerce'); } }]) {
  assert.throws(
    () => record(bad),
    /metadata-record-invalid-address/,
    `${typeof bad} input must not expand the public string address schema`,
  );
}

const canonical = [
  ['0x0', '0x0'],
  ['0x1234', '0x1234'],
  ['  0X00Ab  ', '0xab'],
  ['4660', '0x1234'],
  ['00016', '0x10'],
  ['0xffffffffffffffffffffffffffffffff', '0xffffffffffffffffffffffffffffffff'],
];
for (const [input, expected] of canonical) {
  assert.equal(record(input).address, expected, `${input} canonicalizes to ${expected}`);
}

const noAddress = createLanguageMetadataRecord({
  kind: 'type',
  entityId: 'type:no-address',
  address: null,
  providerId: 'metadata.test',
  providerVersion: '1',
  ecosystem: 'test',
});
assert.equal(noAddress.address, null, 'null address remains valid for non-address metadata');

const identity = createLanguageMetadataIdentity({
  verdict: 'matched-authoritative',
  providerId: 'metadata.test',
  providerVersion: '1',
  ecosystem: 'test',
  expected: 'build-1',
  observed: 'build-1',
});
const result = createLanguageMetadataResult({
  identity,
  completeness: { present: true, declared: 1, scanned: 1, parsed: 1, complete: true },
  status: createAnalysisStatus({
    snapshotId: 'issue-5008',
    analyzerId: 'metadata.test',
    analyzerVersion: '1',
    completeness: 'complete',
  }),
});
const good = record('4096');
const evidence = languageMetadataFunctionEvidence(result, createLanguageMetadataPage({ records: [good] }));
assert.equal(evidence.length, 1);
assert.equal(evidence[0].address, '0x1000');
assert.equal(evidence[0].confidence, 'exact');

assert.throws(
  () => createLanguageMetadataPage({ records: [record('not-an-address')] }),
  /metadata-record-invalid-address/,
  'invalid address cannot reach exact function evidence through the canonical record boundary',
);

console.log('issue-5008 metadata record address validation: PASS');

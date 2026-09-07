import assert from 'node:assert/strict';
import { validateArtifactRecordShape } from '../../js/core/artifacts/storage/integrity.js';

const validRecord = () => ({
  artifactId: 'artifact-id',
  artifactKind: 'kind',
  producerId: 'producer',
  producerVersion: '1',
  binaryId: 'binary',
  sliceId: null,
  entityId: null,
  runtimeSnapshotId: null,
  canonicalConfigHash: 'hash',
  payloadChecksum: 'sum',
  payloadSize: 0,
  versions: {
    loader: '1',
    architectureSemantic: '1',
    abiSemantic: '1',
    semanticSchema: '1',
    platform: 'n/a',
    runtime: 'n/a',
    plugin: 'n/a',
    provider: 'n/a',
  },
  upstreamArtifactIds: ['upstream'],
  originRefs: ['origin'],
});

assert.equal(validateArtifactRecordShape(validRecord()), true, 'canonical stored artifact records remain valid');

for (const [field, value] of [
  ['artifactId', ' artifact-id '],
  ['artifactKind', 'kind '],
  ['producerId', ' producer'],
  ['producerVersion', '\t1'],
  ['binaryId', '   '],
  ['canonicalConfigHash', '\thash'],
  ['payloadChecksum', 'sum\n'],
]) {
  const record = validRecord();
  record[field] = value;
  assert.throws(
    () => validateArtifactRecordShape(record),
    /artifact-record-required-field-missing/,
    `${field} must reject non-canonical surrounding whitespace`,
  );
}

for (const [field, value] of [
  ['loader', ' 1'],
  ['architectureSemantic', '1 '],
  ['abiSemantic', '\t'],
  ['semanticSchema', ' 1 '],
  ['platform', 'n/a '],
  ['runtime', ' n/a'],
  ['plugin', 'n/a\n'],
  ['provider', ' n/a '],
]) {
  const record = validRecord();
  record.versions[field] = value;
  assert.throws(
    () => validateArtifactRecordShape(record),
    /artifact-record-required-field-missing/,
    `versions.${field} must reject non-canonical surrounding whitespace`,
  );
}

for (const [field, value] of [
  ['upstreamArtifactIds', [' upstream ']],
  ['upstreamArtifactIds', ['\t']],
  ['originRefs', [' origin ']],
  ['originRefs', ['   ']],
]) {
  const record = validRecord();
  record[field] = value;
  assert.throws(
    () => validateArtifactRecordShape(record),
    /artifact-record-malformed/,
    `${field} entries must reject non-canonical surrounding whitespace`,
  );
}

console.log('issue #3327 artifact storage identity regression passed');

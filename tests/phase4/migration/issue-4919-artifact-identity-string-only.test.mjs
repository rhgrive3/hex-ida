import assert from 'node:assert/strict';
import {
  createWorkerAnalysisArtifactDescriptor,
  requireCanonicalBinaryId,
} from '../../../js/cache/artifact-orchestration.js';

const BINARY_ID = `bin_sha256_${'11'.repeat(32)}`;
const SLICE_ID = `slice_${'22'.repeat(16)}`;
const ENTITY_ID = `entity_${'33'.repeat(16)}`;
const VALID = Object.freeze({
  binaryId:BINARY_ID,
  sliceId:SLICE_ID,
  entityId:ENTITY_ID,
  architecture:'arm64',
  artifactKind:'issue-4919-fixture',
  producerId:'issue-4919-producer',
  producerVersion:'producer-v1',
  loaderVersion:'loader-v1',
  architectureSemanticVersion:'arch-v1',
  abiSemanticVersion:'abi-v1',
  semanticSchemaVersion:'schema-v1',
});

// Primitive strings retain their existing canonicalization contract.
assert.equal(requireCanonicalBinaryId(BINARY_ID.toUpperCase()), BINARY_ID);
const baseline = createWorkerAnalysisArtifactDescriptor(VALID);
assert.equal(
  baseline.artifactId,
  'artifact_1fa56742e11effda77cd304361e7161d',
  'valid primitive descriptor ArtifactId must remain byte-for-byte unchanged from the pre-fix snapshot',
);
const whitespace = createWorkerAnalysisArtifactDescriptor({
  ...VALID,
  architecture:' arm64 ',
  artifactKind:' issue-4919-fixture ',
  producerId:' issue-4919-producer ',
  producerVersion:' producer-v1 ',
  loaderVersion:' loader-v1 ',
  architectureSemanticVersion:' arch-v1 ',
  abiSemanticVersion:' abi-v1 ',
  semanticSchemaVersion:' schema-v1 ',
});
assert.equal(whitespace.artifactId, baseline.artifactId, 'primitive string trim semantics must remain unchanged');

// The public BinaryId boundary must reject schema-invalid structured values
// even when JavaScript String coercion could make them look canonical.
for (const value of [
  [BINARY_ID],
  { toString:() => BINARY_ID },
  new String(BINARY_ID),
  true,
  1,
  1n,
  Symbol('binary-id'),
]) {
  assert.throws(
    () => requireCanonicalBinaryId(value),
    /analysis-artifact-canonical-binary-id-required/,
    `structured/non-string BinaryId must be rejected: ${Object.prototype.toString.call(value)}`,
  );
}

// Rejection must not invoke attacker-controlled coercion hooks.
let coercions = 0;
const hostile = {
  toString() {
    coercions++;
    return BINARY_ID;
  },
};
assert.throws(() => requireCanonicalBinaryId(hostile), /analysis-artifact-canonical-binary-id-required/);
assert.equal(coercions, 0, 'identity validation must not execute user coercion code');

const structuredIdentityFields = [
  ['binaryId', [BINARY_ID], /analysis-artifact-canonical-binary-id-required/],
  ['artifactKind', ['issue-4919-fixture'], /analysis-artifact-kind-required/],
  ['architecture', ['arm64'], /analysis-artifact-architecture-required/],
  ['sliceId', [SLICE_ID], /analysis-artifact-slice-id-required/],
  ['entityId', [ENTITY_ID], /analysis-artifact-entity-id-required/],
  ['producerId', ['issue-4919-producer'], /analysis-artifact-producer-id-required/],
  ['producerVersion', ['producer-v1'], /analysis-artifact-producer-version-required/],
  ['loaderVersion', ['loader-v1'], /analysis-artifact-loader-version-required/],
  ['architectureSemanticVersion', ['arch-v1'], /analysis-artifact-architecture-version-required/],
  ['abiSemanticVersion', ['abi-v1'], /analysis-artifact-abi-version-required/],
  ['semanticSchemaVersion', ['schema-v1'], /analysis-artifact-schema-version-required/],
];
for (const [field, value, error] of structuredIdentityFields) {
  assert.throws(
    () => createWorkerAnalysisArtifactDescriptor({ ...VALID, [field]:value }),
    error,
    `${field} must reject structured identity/version input`,
  );
}

// Generated slice/entity identities remain on the existing canonical path.
const generated = createWorkerAnalysisArtifactDescriptor({
  ...VALID,
  sliceId:undefined,
  entityId:undefined,
  sliceIndex:0,
});
assert.match(generated.sliceId, /^slice_[0-9a-f]{32}$/);
assert.match(generated.entityId, /^entity_[0-9a-f]{32}$/);

// Valid primitive descriptors keep their exact identity material.
const again = createWorkerAnalysisArtifactDescriptor({ ...VALID });
assert.equal(again.artifactId, baseline.artifactId);
assert.deepEqual(again.versions, baseline.versions);

console.log('phase4 migration issue-4919 artifact identity string-only: PASS');

import assert from 'node:assert/strict';
import { canonicalAbiEvidence } from '../js/targets/abi/evidence.js';

function canonicalEvidence({ binaryId = 'binary-X' } = {}) {
  const abiId = 'sysv-amd64';
  const semanticVersion = '2';
  const semanticIdentity = 'sysv-amd64@2';
  const registryDigest = 'registry-digest-1';
  const architecture = 'x86_64';
  const platform = 'linux';
  const architectureProfile = {
    id:semanticIdentity,
    profileIdentity:semanticIdentity,
    semanticIdentity,
    abiSemanticIdentity:semanticIdentity,
    abiId,
    architectureId:architecture,
    architecture,
    platform,
    platformId:platform,
  };
  const mirror = {
    schemaVersion:3,
    snapshotId:'snapshot-1',
    analyzerId:'analyzer-1',
    analyzerVersion:'1',
    binaryId,
    sliceId:'slice-1',
    functionId:'function-1',
  };

  return {
    abiId,
    abiSemanticVersion:semanticVersion,
    abiSemanticIdentity:semanticIdentity,
    registryDigest,
    abiIdentity:{
      id:abiId,
      semanticVersion,
      semanticIdentity,
      architectureId:architecture,
      targetArchitecture:architecture,
      platform,
      profileIdentity:semanticIdentity,
      abiId,
      registryDigest,
      architectureProfile,
      ...mirror,
    },
    provenance:{
      source:'canonical-abi-registry',
      abiId,
      semanticVersion,
      semanticIdentity,
      registryDigest,
      architectureId:architecture,
      profileIdentity:semanticIdentity,
      targetArchitecture:architecture,
      platformId:platform,
      architectureProfile:structuredClone(architectureProfile),
      ...mirror,
    },
    invalidation:{
      abiId,
      abiSemanticVersion:semanticVersion,
      abiSemanticIdentity:semanticIdentity,
      registryDigest,
      architectureId:architecture,
      profileIdentity:semanticIdentity,
      targetArchitecture:architecture,
      platformId:platform,
      architectureProfile:structuredClone(architectureProfile),
      ...mirror,
    },
  };
}

const canonical = canonicalEvidence();
assert.equal(canonicalAbiEvidence(canonical), true, 'canonical scalar mirrors must remain valid');

{
  const forged = structuredClone(canonical);
  forged.provenance.binaryId = [canonical.abiIdentity.binaryId];
  assert.equal(
    canonicalAbiEvidence(forged),
    false,
    'array-valued provenance identity must not stringify into the canonical binaryId',
  );
}

{
  const forged = structuredClone(canonical);
  forged.invalidation.binaryId = { toString:() => canonical.abiIdentity.binaryId };
  assert.equal(
    canonicalAbiEvidence(forged),
    false,
    'object-valued invalidation identity must not stringify into the canonical binaryId',
  );
}

{
  const forged = structuredClone(canonical);
  forged.provenance.architectureProfile.architecture = [
    canonical.abiIdentity.architectureProfile.architecture,
  ];
  assert.equal(
    canonicalAbiEvidence(forged),
    false,
    'structured profile mirrors must preserve the canonical scalar type',
  );
}

{
  const forged = structuredClone(canonical);
  forged.provenance.schemaVersion = String(canonical.abiIdentity.schemaVersion);
  assert.equal(
    canonicalAbiEvidence(forged),
    false,
    'numeric mirror fields must not compare equal to string spellings of the same value',
  );
}

{
  const truthyId = canonicalEvidence({ binaryId:'true' });
  assert.equal(canonicalAbiEvidence(truthyId), true);
  truthyId.provenance.binaryId = true;
  assert.equal(
    canonicalAbiEvidence(truthyId),
    false,
    'boolean mirrors must not stringify into a canonical string identity',
  );
}

console.log('issue #3484 ABI evidence scalar identity regression: ok');

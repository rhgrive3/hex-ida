import assert from 'node:assert/strict';
import {
  canonicalAbiEvidence,
  canonicalAbiHiddenResult,
} from '../../../js/targets/abi/evidence.js';

function canonicalEvidence() {
  const abiId = 'sysv-amd64';
  const semanticVersion = '2';
  const semanticIdentity = 'sysv-amd64@2';
  const registryDigest = 'registry-digest-5552';
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
    snapshotId:'snapshot-5552',
    analyzerId:'analyzer-5552',
    analyzerVersion:'1',
    binaryId:'binary-5552',
    sliceId:'slice-5552',
    functionId:'function-5552',
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

function hiddenResult(raw, pointerBits) {
  return {
    input:'x8',
    canonicalInput:'x8',
    location:'register',
    pointerBits,
    profileIdentity:raw.abiIdentity.architectureProfile.profileIdentity,
    abiId:raw.abiId,
    abiSemanticIdentity:raw.abiSemanticIdentity,
    registryDigest:raw.registryDigest,
    abiIdentity:structuredClone(raw.abiIdentity),
    provenance:structuredClone(raw.provenance),
    invalidation:structuredClone(raw.invalidation),
  };
}

const raw = canonicalEvidence();
assert.equal(canonicalAbiEvidence(raw), true, 'fixture must carry canonical ABI evidence');
assert.equal(
  canonicalAbiHiddenResult(raw, hiddenResult(raw, 64)),
  true,
  'canonical primitive numeric pointer width must remain accepted',
);

for (const pointerBits of ['64', [64], true, 64.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.equal(
    canonicalAbiHiddenResult(raw, hiddenResult(raw, pointerBits)),
    false,
    `non-canonical pointerBits ${String(pointerBits)} must fail closed`,
  );
}

let coercions = 0;
const hostilePointerBits = {
  [Symbol.toPrimitive]() { coercions += 1; return 64; },
  valueOf() { coercions += 1; return 64; },
  toString() { coercions += 1; return '64'; },
};
assert.equal(
  canonicalAbiHiddenResult(raw, hiddenResult(raw, hostilePointerBits)),
  false,
  'coercible object width must not become canonical hidden-result evidence',
);
assert.equal(coercions, 0, 'pointer-width validation must not invoke coercion hooks');

console.log('issue #5552 ABI hidden-result pointer width authority: ok');

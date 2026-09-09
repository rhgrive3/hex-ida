import assert from 'node:assert/strict';

import {
  CANONICAL_ACCESS_ISSUER,
  MEMORY_SSA_PROOF_VERSION,
  canonicalAccessProof,
} from '../../js/semantics/memoryssa/proof.js';

const unknownDescriptor = {
  node: { id: 'load_mem0', origin: { instructionIds: ['i0'] } },
  memory: {
    widthBits: 64,
    endian: 'little',
    atomic: 'unknown',
    volatility: 'unknown',
    ordering: 'unknown',
  },
};

const provider = {
  kind: 'canonical-memory-access-qualifiers',
  issuer: {
    type: 'canonical-memory-access-provider',
    id: CANONICAL_ACCESS_ISSUER,
    version: MEMORY_SSA_PROOF_VERSION,
  },
  sourceEntityId: 'load_mem0',
  widthBits: 64,
  endian: 'little',
  atomic: false,
  volatility: false,
  ordering: 'unknown',
};

function prove(raw, descriptor = unknownDescriptor) {
  return canonicalAccessProof({
    raw,
    descriptor,
    identity: { functionId: 'fn4513' },
    functionId: 'fn4513',
  });
}

assert.equal(prove({ ...provider, issuer: undefined }), null,
  'an issuer-less plain provider cannot close unknown qualifiers');
assert.equal(prove({
  ...provider,
  issuer: { ...provider.issuer, id: 'untrusted.provider' },
}), null, 'an unknown issuer cannot mint canonical access authority');
assert.equal(prove({
  ...provider,
  issuer: { ...provider.issuer, version: '9.9.9' },
}), null, 'an unsupported issuer version cannot mint canonical access authority');
assert.equal(prove({
  ...provider,
  issuer: { ...provider.issuer, type: 'arbitrary-callback' },
}), null, 'a non-canonical issuer type cannot mint canonical access authority');
assert.equal(prove({ ...provider, sourceEntityId: 'other-node' }), null,
  'canonical provider evidence remains bound to the source entity');

const accepted = prove(provider);
assert.ok(accepted, 'the allowlisted canonical provider remains usable');
assert.deepEqual(accepted.issuer, provider.issuer);
assert.equal(accepted.sourceEntityId, 'load_mem0');
assert.equal(accepted.volatility, false);
assert.equal(accepted.atomic, false);

const knownDescriptor = {
  ...unknownDescriptor,
  memory: { ...unknownDescriptor.memory, atomic: false, volatility: false },
};
const sourceKnown = prove(null, knownDescriptor);
assert.ok(sourceKnown, 'explicit source qualifiers do not require an external provider');

console.log('#4513 access-proof provider authority: PASS');

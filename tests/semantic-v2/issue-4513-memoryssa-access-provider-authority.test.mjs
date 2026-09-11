import assert from 'node:assert/strict';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import * as memorySsaProof from '../../js/semantics/memoryssa/proof.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';

const {
  CANONICAL_ACCESS_ISSUER,
  MEMORY_SSA_PROOF_VERSION,
  canonicalAccessProof,
  isCanonicalAccessProvider,
} = memorySsaProof;

const functionId = 'function_issue_4513';
const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const cfg = createSemanticCfg({
  functionId,
  entryBlockId: 'entry',
  blocks: [{ id: 'entry', successors: [] }],
});
const region = createMemoryRegionRef({
  id: 'region_issue_4513',
  kind: 'rooted-offset',
  functionId,
  rootEntityId: 'root_issue_4513',
  offset: 0,
  widthBits: 64,
});

function memory(overrides = {}) {
  return {
    addressSpace: 'memory',
    addressValueId: 'address_0',
    widthBits: 64,
    endian: 'little',
    volatility: 'unknown',
    atomic: 'unknown',
    ordering: 'unknown',
    ...overrides,
  };
}

function makeIr(accessMemory, { canonicalMachineEffects = false } = {}) {
  return createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: ['load_0'], origin: origin('entry') }],
    values: [{
      id: 'address_0',
      kind: 'entry',
      machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' },
      origin: origin('address_0'),
    }],
    nodes: [{
      id: 'load_0',
      kind: 'load',
      blockId: 'entry',
      inputs: [],
      outputs: [],
      origin: origin('load_0'),
      memory: accessMemory,
      ...(canonicalMachineEffects ? {
        attributes: {
          machineEffects: {
            instructionId: 'instruction_load_0',
            architectureId: 'arm64',
            mode: 'a64',
            bundleCompleteness: 'exact',
            operationKind: 'memory-read',
            bundleMetadata: { family: 'arm64-memory', mnemonic: 'ldr' },
          },
        },
      } : {}),
    }],
    completeness: 'complete',
    unknowns: [],
    origin: origin('function'),
  });
}

function providerFor(descriptor, overrides = {}) {
  return {
    kind: 'canonical-memory-access-qualifiers',
    issuer: {
      type: 'canonical-memory-access-provider',
      id: CANONICAL_ACCESS_ISSUER,
      version: MEMORY_SSA_PROOF_VERSION,
    },
    sourceEntityId: descriptor.node.id,
    architectureId: 'arm64',
    family: 'arm64-memory',
    widthBits: descriptor.memory.widthBits,
    endian: descriptor.memory.endian,
    volatility: false,
    atomic: false,
    ordering: 'unknown',
    ...overrides,
  };
}

function buildWith(provider, accessMemory = memory(), { canonicalMachineEffects = false } = {}) {
  const artifact = buildMemorySsa(makeIr(accessMemory, { canonicalMachineEffects }), cfg, {
    regions: [region],
    resolveRegion() { return region; },
    queryAlias() { return 'must'; },
    accessProofForDescriptor: provider,
    identity: { functionId, memorySsaBuildVersion: '1.0.1' },
  });
  return artifact.accessMetadata.find((item) => item.sourceEntityId === 'load_0');
}

const descriptor = { node: { id: 'load_0', origin: origin('load_0') }, memory: memory() };
const identity = { functionId, memorySsaBuildVersion: '1.0.1' };
const exact = providerFor(descriptor);
const candidateProvider = (item) => providerFor(item);

assert.equal(Object.hasOwn(memorySsaProof, 'registerCanonicalAccessProvider'), false,
  'arbitrary callers must not receive a self-service canonical-provider registrar');
assert.equal(isCanonicalAccessProvider(candidateProvider), false,
  'an arbitrary canonical-looking callback must not acquire provider authority');
assert.equal(Object.hasOwn(memorySsaProof, 'canonicalSemanticAccessProvider'), false,
  'canonical provider implementation must remain module-private');

assert.equal(canonicalAccessProof({
  raw: { ...exact, issuer: { ...exact.issuer, id: 'untrusted.provider' } },
  descriptor,
  identity,
  functionId,
  providerCallback: candidateProvider,
}), null, 'unknown issuer must not close unknown source qualifiers');
assert.equal(canonicalAccessProof({
  raw: { ...exact, issuer: { ...exact.issuer, version: '0.0.1' } },
  descriptor,
  identity,
  functionId,
  providerCallback: candidateProvider,
}), null, 'issuer version mismatch must not close unknown source qualifiers');

let hostileCalls = 0;
const hostileProvider = () => {
  hostileCalls += 1;
  throw new Error('caller access provider must never execute');
};
const forgedCanonicalMetadata = buildWith(hostileProvider);
assert.equal(forgedCanonicalMetadata.accessProof, null,
  'caller callback cannot mint a canonical access proof');
assert.equal(forgedCanonicalMetadata.memory.volatility, 'unknown');
assert.equal(forgedCanonicalMetadata.memory.atomic, 'unknown');
assert.equal(hostileCalls, 0, 'untrusted access provider must not execute');

const canonicalMetadata = buildWith(hostileProvider, memory(), { canonicalMachineEffects: true });
assert.ok(canonicalMetadata.accessProof,
  'producer-owned canonical machine-effects route must remain reachable without caller authority');
assert.equal(canonicalMetadata.accessProof.issuer.id, CANONICAL_ACCESS_ISSUER);
assert.equal(canonicalMetadata.memory.volatility, false);
assert.equal(canonicalMetadata.memory.atomic, false);
assert.equal(hostileCalls, 0, 'canonical route must not execute the caller callback');

const knownSourceMetadata = buildWith(candidateProvider, memory({ volatility: false, atomic: false }));
assert.ok(knownSourceMetadata.accessProof, 'already-proven source qualifiers must retain the provider-free path');
assert.equal(knownSourceMetadata.memory.volatility, false);
assert.equal(knownSourceMetadata.memory.atomic, false);
assert.equal(knownSourceMetadata.accessProof.architectureId, 'canonical-semantic',
  'untrusted provider metadata must not decorate the provider-free proof');

console.log('issue #4513 MemorySSA access provider authority: PASS');

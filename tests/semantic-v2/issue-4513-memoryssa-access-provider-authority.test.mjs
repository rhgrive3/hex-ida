import assert from 'node:assert/strict';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import {
  CANONICAL_ACCESS_ISSUER,
  MEMORY_SSA_PROOF_VERSION,
  canonicalAccessProof,
  registerCanonicalAccessProvider,
} from '../../js/semantics/memoryssa/proof.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';

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

function makeIr(accessMemory) {
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
    widthBits: descriptor.memory.widthBits,
    endian: descriptor.memory.endian,
    volatility: false,
    atomic: false,
    ordering: 'unknown',
    ...overrides,
  };
}

function buildWith(provider, accessMemory = memory()) {
  const artifact = buildMemorySsa(makeIr(accessMemory), cfg, {
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
const trustedProvider = (item) => providerFor(item);
registerCanonicalAccessProvider(trustedProvider);

assert.equal(canonicalAccessProof({
  raw: { ...exact, issuer: { ...exact.issuer, id: 'untrusted.provider' } },
  descriptor,
  identity,
  functionId,
  providerCallback: trustedProvider,
}), null, 'unknown issuer must not close unknown source qualifiers');
assert.equal(canonicalAccessProof({
  raw: { ...exact, issuer: { ...exact.issuer, version: '0.0.1' } },
  descriptor,
  identity,
  functionId,
  providerCallback: trustedProvider,
}), null, 'issuer version mismatch must not close unknown source qualifiers');
assert.equal(canonicalAccessProof({
  raw: exact,
  descriptor,
  identity,
  functionId,
  providerTrusted: true,
}), null, 'a caller-controlled trust flag must not authorize a provider');

const forgedProvider = () => ({ ...exact, evidence: { memoryAccessDigest: 'forged' } });
const forgedMetadata = buildWith(forgedProvider);
assert.equal(forgedMetadata.accessProof, null, 'an unregistered callback cannot mint a canonical access proof');
assert.equal(forgedMetadata.memory.volatility, 'unknown');
assert.equal(forgedMetadata.memory.atomic, 'unknown');

const forgedCanonicalFields = () => exact;
const forgedCanonicalMetadata = buildWith(forgedCanonicalFields);
assert.equal(forgedCanonicalMetadata.accessProof, null, 'matching issuer fields alone cannot authorize an arbitrary callback');
assert.equal(forgedCanonicalMetadata.memory.volatility, 'unknown');
assert.equal(forgedCanonicalMetadata.memory.atomic, 'unknown');

const trustedMetadata = buildWith(trustedProvider);
assert.equal(trustedMetadata.accessProof?.issuer.id, CANONICAL_ACCESS_ISSUER);
assert.equal(trustedMetadata.accessProof?.issuer.version, MEMORY_SSA_PROOF_VERSION);
assert.equal(trustedMetadata.memory.volatility, false);
assert.equal(trustedMetadata.memory.atomic, false);

const registeredWrongIssuer = (item) => providerFor(item, {
  issuer: {
    type: 'canonical-memory-access-provider',
    id: 'wrong-provider',
    version: MEMORY_SSA_PROOF_VERSION,
  },
});
registerCanonicalAccessProvider(registeredWrongIssuer);
const wrongIssuerMetadata = buildWith(registeredWrongIssuer);
assert.equal(wrongIssuerMetadata.accessProof, null, 'registered callbacks still require the canonical issuer');
assert.equal(wrongIssuerMetadata.memory.volatility, 'unknown');
assert.equal(wrongIssuerMetadata.memory.atomic, 'unknown');

const knownSourceMetadata = buildWith(null, memory({ volatility: false, atomic: false }));
assert.ok(knownSourceMetadata.accessProof, 'already-proven source qualifiers must retain the provider-free path');
assert.equal(knownSourceMetadata.memory.volatility, false);
assert.equal(knownSourceMetadata.memory.atomic, false);

const arm64MemoryPlugin = Object.freeze({
  id: 'arm64',
  semanticVersion: 'issue-4513-test',
  fixedInstructionSize: 4,
  liftExact(decoded) {
    return createMachineEffectBundle({
      instructionId: decoded.instructionId,
      architectureId: 'arm64',
      mode: 'a64',
      possibleFaults: [],
      origin: decoded.origin,
      metadata: { family: 'arm64-memory', mnemonic: 'ldr' },
      operations: [{
        id: `${decoded.instructionId}:load`,
        kind: 'memory-read',
        access: {
          space: 'memory',
          addressExpr: { kind: 'bitvector', widthBits: 64, value: '20480' },
          widthBits: 64,
          endian: 'little',
        },
        value: { kind: 'bitvector', widthBits: 64 },
      }],
      controlEffect: { kind: 'return' },
      completeness: 'exact',
    });
  },
});
const compatibility = buildSemanticV2CompatibilityPipeline({
  architecturePlugin: arm64MemoryPlugin,
  decoderSemanticVersion: 'issue-4513-decoder',
  binaryId: 'binary_issue_4513',
  sliceId: 'slice_issue_4513',
  addressWidthBits: 64,
  blocks: [{
    key: 'entry',
    startAddress: 0x1000n,
    instructions: [{ decoded: { address: 0x1000n, mode: 'a64' } }],
    successors: [],
  }],
});
const compatibilityAccess = compatibility.memorySsa.accessMetadata[0];
assert.ok(compatibilityAccess?.accessProof, 'the compatibility pipeline must use its registered canonical provider');
assert.equal(compatibilityAccess.memory.volatility, false);
assert.equal(compatibilityAccess.memory.atomic, false);

console.log('issue #4513 MemorySSA access provider authority: PASS');

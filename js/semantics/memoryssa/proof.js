import { jsonSafe, stableDigest } from '../../core/identity/index.js';
import {
  CANONICAL_ACCESS_ISSUER,
  MEMORY_SSA_PROOF_VERSION,
  canonicalAccessProofDigest,
  canonicalIdentityDigest,
} from './proof-core.js';

// Keep the mature MemorySSA proof surface unchanged. This facade owns only the
// #4513 access-qualifier authority override; explicit exports below shadow the
// legacy same-name exports from the core module.
export * from './proof-core.js';

function weakObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function canonicalSemanticAccessProvider(descriptor) {
  const memory = descriptor?.memory;
  const machineEffects = descriptor?.node?.attributes?.machineEffects;
  const architectureId = machineEffects?.architectureId;
  const family = machineEffects?.bundleMetadata?.family;
  const bundleCompleteness = machineEffects?.bundleCompleteness;
  if (!memory || !['arm64', 'arm64e'].includes(architectureId)
      || family !== 'arm64-memory'
      || bundleCompleteness !== 'exact') return null;
  if (typeof descriptor?.node?.id !== 'string' || descriptor.node.id.length === 0) return null;
  if (typeof memory.widthBits !== 'number' || !Number.isSafeInteger(memory.widthBits)
      || memory.widthBits <= 0 || memory.widthBits % 8 !== 0) return null;
  if (typeof memory.endian !== 'string' || memory.endian.length === 0) return null;
  if (memory.ordering != null && memory.ordering !== 'unknown') return null;
  if (memory.atomic === true || memory.volatility === true) return null;
  return Object.freeze({
    kind:'canonical-memory-access-qualifiers',
    issuer:Object.freeze({
      type:'canonical-memory-access-provider',
      id:CANONICAL_ACCESS_ISSUER,
      version:MEMORY_SSA_PROOF_VERSION,
    }),
    sourceEntityId:descriptor.node.id,
    architectureId,
    family,
    widthBits:memory.widthBits,
    endian:memory.endian,
    volatility:false,
    atomic:false,
    ordering:'unknown',
    evidence:Object.freeze({
      operationKind:machineEffects.operationKind ?? null,
      machineFamily:family,
      sourceMnemonic:machineEffects.bundleMetadata?.mnemonic ?? null,
    }),
  });
}

export function isCanonicalAccessProvider(_provider) {
  // Caller-supplied callbacks never acquire access-qualifier authority.
  return false;
}

export function canonicalAccessProof({ descriptor, identity, functionId }) {
  const memory = descriptor?.memory;
  if (!memory) return null;
  const sourceEntityId = typeof descriptor?.node?.id === 'string' ? descriptor.node.id : '';
  if (!sourceEntityId) return null;

  const provider = canonicalSemanticAccessProvider(descriptor) ?? {};
  const providerIssuer = weakObject(provider.issuer);
  const providerAuthority = providerIssuer?.type === 'canonical-memory-access-provider'
    && providerIssuer.id === CANONICAL_ACCESS_ISSUER
    && providerIssuer.version === MEMORY_SSA_PROOF_VERSION;
  const sourceQualifiersKnown = memory.volatility === false
    && memory.atomic === false
    && (memory.ordering == null || memory.ordering === 'unknown');
  const providerQualifiersKnown = providerAuthority
    && provider.kind === 'canonical-memory-access-qualifiers'
    && provider.sourceEntityId === sourceEntityId
    && provider.volatility === false
    && provider.atomic === false
    && (provider.ordering == null || provider.ordering === 'unknown')
    && provider.widthBits === memory.widthBits
    && provider.endian === memory.endian;
  if (!sourceQualifiersKnown && !providerQualifiersKnown) return null;

  const rawEvidence = providerAuthority && provider.evidence
    && typeof provider.evidence === 'object' && !Array.isArray(provider.evidence)
    ? jsonSafe(provider.evidence) : {};
  const base = {
    kind:'canonical-memory-access-qualifiers',
    version:MEMORY_SSA_PROOF_VERSION,
    sourceEntityId,
    issuer:{
      type:'canonical-memory-access-provider',
      id:CANONICAL_ACCESS_ISSUER,
      version:MEMORY_SSA_PROOF_VERSION,
    },
    identity:{
      functionId:String(functionId ?? ''),
      digest:canonicalIdentityDigest(identity),
    },
    provenance:{
      functionId:String(functionId ?? ''),
      sourceEntityId,
      sourceOriginDigest:stableDigest(descriptor.node?.origin ?? null),
    },
    architectureId:providerAuthority && typeof provider.architectureId === 'string'
      ? provider.architectureId : 'canonical-semantic',
    family:providerAuthority && typeof provider.family === 'string'
      ? provider.family : 'semantic-memory-access',
    widthBits:Number(memory.widthBits),
    endian:String(memory.endian ?? ''),
    volatility:false,
    atomic:false,
    ordering:providerQualifiersKnown ? 'unknown' : (memory.ordering ?? 'unknown'),
    evidence:{
      ...rawEvidence,
      source:rawEvidence.source == null ? 'canonical-semantic-memory-access' : String(rawEvidence.source),
      memoryAccessDigest:stableDigest(memory),
    },
  };
  return { ...base, proofDigest:canonicalAccessProofDigest(base) };
}

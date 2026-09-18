import { arm64MemoryAccessQualifiers } from '../targets/architecture/arm64/memory-access-qualifiers.js';

// Composition boundary for built-in target adapters. The list is private and
// immutable: architecture-plugin registration and caller callbacks cannot add
// proof authority. Each adapter returns descriptor facts, never a sealed proof.
const PROVIDERS = Object.freeze([arm64MemoryAccessQualifiers]);

// Equivalent ordinary-memory bundles from other owned targets still use the
// same generic proof contract. Keep this fallback at the composition boundary
// so the proof core does not acquire target selectors. The family must identify
// ordinary memory and its root must agree with the architecture identity;
// mismatched target-family evidence remains unproven.
function genericMemoryAccessQualifiers(descriptor) {
  const memory = descriptor?.memory;
  const machineEffects = descriptor?.node?.attributes?.machineEffects;
  const architectureId = machineEffects?.architectureId;
  const family = machineEffects?.bundleMetadata?.family;
  const familyRoot = typeof family === 'string' && family.endsWith('-memory')
    ? family.slice(0, -'-memory'.length)
    : null;
  if (!memory || typeof architectureId !== 'string' || !architectureId
      || !familyRoot || !architectureId.startsWith(familyRoot)
      || machineEffects?.bundleCompleteness !== 'exact') return null;
  if (typeof descriptor?.node?.id !== 'string' || descriptor.node.id.length === 0) return null;
  if (typeof memory.widthBits !== 'number' || !Number.isSafeInteger(memory.widthBits)
      || memory.widthBits <= 0 || memory.widthBits % 8 !== 0) return null;
  if (typeof memory.endian !== 'string' || memory.endian.length === 0) return null;
  if (memory.ordering != null && memory.ordering !== 'unknown') return null;
  if (memory.atomic === true || memory.volatility === true) return null;
  return Object.freeze({
    sourceEntityId: descriptor.node.id,
    architectureId,
    family,
    widthBits: memory.widthBits,
    endian: memory.endian,
    volatility: false,
    atomic: false,
    ordering: 'unknown',
    evidence: Object.freeze({
      operationKind: machineEffects.operationKind ?? null,
      machineFamily: family,
      sourceMnemonic: machineEffects.bundleMetadata?.mnemonic ?? null,
    }),
  });
}

export function canonicalMemoryAccessQualifiers(descriptor) {
  for (const provider of PROVIDERS) {
    const qualifiers = provider(descriptor);
    if (qualifiers) return qualifiers;
  }
  return genericMemoryAccessQualifiers(descriptor);
}

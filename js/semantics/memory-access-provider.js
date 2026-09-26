import { arm64MemoryAccessQualifiers } from '../targets/architecture/arm64/memory-access-qualifiers.js';

function x86MemoryAccessQualifiers(descriptor) {
  const memory = descriptor?.memory;
  const machineEffects = descriptor?.node?.attributes?.machineEffects;
  const architectureId = machineEffects?.architectureId;
  const family = machineEffects?.bundleMetadata?.family;
  const bundleCompleteness = machineEffects?.bundleCompleteness;
  if (!memory || !['x86_64', 'x86'].includes(architectureId)
      || family !== 'x86-memory'
      || bundleCompleteness !== 'exact') return null;
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

// Composition boundary for built-in target adapters. The list is private and
// immutable: architecture-plugin registration and caller callbacks cannot add
// proof authority. Each adapter returns descriptor facts, never a sealed proof.
const PROVIDERS = Object.freeze([arm64MemoryAccessQualifiers, x86MemoryAccessQualifiers]);

export function canonicalMemoryAccessQualifiers(descriptor) {
  for (const provider of PROVIDERS) {
    const qualifiers = provider(descriptor);
    if (qualifiers) return qualifiers;
  }
  return null;
}

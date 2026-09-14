/**
 * Interpret the exact ordinary-memory contract of this target family. This
 * does not change the instruction's source qualifiers or issue a MemorySSA
 * proof; the canonical proof producer binds these facts to its descriptor.
 */
export function arm64MemoryAccessQualifiers(descriptor) {
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

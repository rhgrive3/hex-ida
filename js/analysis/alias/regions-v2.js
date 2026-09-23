import { isCanonicalMemorySsaProducerArtifact } from '../../semantics/memoryssa/build.js';
import { canonicalSemanticSsaProducerMatches } from '../../semantics/ssa/build.js';
import {
  REGION_ALIAS_FLOOR_VERSION,
  __regionInternalsForTests,
  canonicalMemoryPointerRegionEvidence,
  classifySemanticMemoryRegion as classifySemanticMemoryRegionCore,
  deriveMemoryRegion,
  genuineRenamedDefinitionRow,
  genuineRenamedUseRow,
  isPreciseMemoryRegion,
  sameMemoryRegionIdentity,
  semanticIrDigestFor,
} from './regions-v2-core.js';

export {
  REGION_ALIAS_FLOOR_VERSION,
  __regionInternalsForTests,
  canonicalMemoryPointerRegionEvidence,
  deriveMemoryRegion,
  genuineRenamedDefinitionRow,
  genuineRenamedUseRow,
  isPreciseMemoryRegion,
  sameMemoryRegionIdentity,
  semanticIrDigestFor,
};

// #2924 core contract preserved in regions-v2-core.js:
// categories.every((category) => category === 'flags')

/**
 * Filters and validates MemorySSA options to ensure identity, snapshot, and semantic digest match the IR.
 *
 * @param {object} ir - The semantic IR function
 * @param {object} options - Options containing candidate canonical MemorySSA
 * @returns {object} Safe options with canonicalMemorySsa retained if trusted, or stripped if untrusted
 */
function reloadAuthorityOptions(ir, options) {
  const memorySsa = options?.canonicalMemorySsa;
  if (memorySsa == null) return options;
  const ssa = options?.ssa;
  const semanticIrDigest = semanticIrDigestFor(ir, ssa);
  const identity = memorySsa?.identity;
  const scalarSsaDigest = typeof identity?.scalarSsaDigest === 'string' && identity.scalarSsaDigest.trim()
    ? identity.scalarSsaDigest.trim() : null;
  const snapshotId = typeof memorySsa?.snapshotId === 'string' && memorySsa.snapshotId.trim()
    ? memorySsa.snapshotId.trim() : null;
  const identitySnapshotId = typeof identity?.snapshotId === 'string' && identity.snapshotId.trim()
    ? identity.snapshotId.trim() : null;
  const trusted = isCanonicalMemorySsaProducerArtifact(memorySsa)
    && String(memorySsa.functionId ?? '') === String(ir?.functionId ?? '')
    && String(identity?.functionId ?? '') === String(ir?.functionId ?? '')
    && String(identity?.semanticIrDigest ?? '') === semanticIrDigest
    && scalarSsaDigest != null
    && snapshotId != null
    && identitySnapshotId != null
    && snapshotId === identitySnapshotId
    && canonicalSemanticSsaProducerMatches(ssa, {
      functionId: ir?.functionId,
      semanticIrDigest,
      scalarSsaDigest,
      snapshotId,
    });
  return trusted ? options : { ...options, canonicalMemorySsa: null };
}

/**
 * Classifies the semantic memory region for a node or node ID within a semantic IR function.
 *
 * @param {object} ir - The semantic IR function
 * @param {object|string} nodeOrId - The memory access node or its ID
 * @param {object} [options={}] - Analysis options including candidate MemorySSA and SSA context
 * @returns {object} The classified memory region object
 */
export function classifySemanticMemoryRegion(ir, nodeOrId, options = {}) {
  return classifySemanticMemoryRegionCore(ir, nodeOrId, reloadAuthorityOptions(ir, options));
}

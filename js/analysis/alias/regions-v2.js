import { stableDigest } from '../../core/identity/index.js';
import { isCanonicalMemorySsaProducerArtifact } from '../../semantics/memoryssa/build.js';
import { canonicalSemanticSsaProducerMatches } from '../../semantics/ssa/build.js';
import {
  REGION_ALIAS_FLOOR_VERSION,
  __regionInternalsForTests,
  classifySemanticMemoryRegion as classifySemanticMemoryRegionCore,
  deriveMemoryRegion,
  isPreciseMemoryRegion,
  sameMemoryRegionIdentity,
} from './regions-v2-core.js';

export {
  REGION_ALIAS_FLOOR_VERSION,
  __regionInternalsForTests,
  deriveMemoryRegion,
  isPreciseMemoryRegion,
  sameMemoryRegionIdentity,
};

function reloadAuthorityOptions(ir, options) {
  const memorySsa = options?.canonicalMemorySsa;
  if (memorySsa == null) return options;
  const ssa = options?.ssa;
  const semanticIrDigest = stableDigest(ir);
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
    });
  return trusted ? options : { ...options, canonicalMemorySsa: null };
}

export function classifySemanticMemoryRegion(ir, nodeOrId, options = {}) {
  return classifySemanticMemoryRegionCore(ir, nodeOrId, reloadAuthorityOptions(ir, options));
}

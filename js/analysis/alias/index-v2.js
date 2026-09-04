export {
  REGION_ALIAS_FLOOR_VERSION,
  deriveMemoryRegion,
  isPreciseMemoryRegion,
  sameMemoryRegionIdentity,
} from './regions-v2.js';

// The public classifier keeps the exact regions-v2 proof contract while
// indexing the immutable second-pass MemorySSA lookup path.
export { classifySemanticMemoryRegion } from './regions-v2-indexed.js';

export {
  CANONICAL_ADDRESS_DERIVATION_VERSION,
  GENERIC_ROOT_DESCRIPTOR_KINDS,
  canonicalAddressProofToRegionEvidence,
  deriveCanonicalAddressProof,
  deriveCanonicalRegionEvidence,
  sameCanonicalAddressProof,
} from './canonical-address-v2.js';

export {
  ALIAS_RELATIONS,
  aliasMemoryRegions,
  effectSummaryAliasRelation,
  unknownStoreAliasRelation,
  unknownStoreClobbersRegion,
} from './legacy-safety-floor.js';

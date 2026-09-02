import { stableDigest } from '../../core/identity/index.js';
import { createMemoryRegionRef } from './contract.js';
import {
  MEMORY_SSA_BUILD_VERSION,
  MEMORY_SSA_BUILD_DEFAULT_BUDGET,
  buildMemorySsa as buildMemorySsaRaw,
} from './build.js';

export {
  MEMORY_SSA_CONTRACT_VERSION,
  MEMORY_SSA_ALIAS_RELATIONS,
  MEMORY_REGION_KINDS,
  MEMORY_SSA_DEFINITION_KINDS,
  MEMORY_SSA_DEFAULT_BUDGET,
  MemorySsaBudgetError,
  createMemoryRegionRef,
  createMemorySsaContract,
} from './contract.js';
export {
  MEMORY_SSA_BUILD_VERSION,
  MEMORY_SSA_BUILD_DEFAULT_BUDGET,
};

export const MEMORY_SSA_UNKNOWN_PARTITION_VERSION = '1.0.0';

function canonicalUnknownRegion(functionId) {
  return createMemoryRegionRef({
    id: `memoryregion_unknown_partition_${stableDigest({
      version: MEMORY_SSA_UNKNOWN_PARTITION_VERSION,
      functionId,
    })}`,
    kind: 'unknown',
    functionId,
    uncertaintyIdentity: {
      source: 'memoryssa-facade-canonical-unknown-partition',
      version: MEMORY_SSA_UNKNOWN_PARTITION_VERSION,
      functionId,
    },
    metadata: {
      precision: 'conservative-unknown-state-partition',
      normalizationVersion: MEMORY_SSA_UNKNOWN_PARTITION_VERSION,
    },
  });
}

function collapseUnknownResolution(value, fallback) {
  if (Array.isArray(value)) return value.map((item) => collapseUnknownResolution(item, fallback));
  if (!value || typeof value !== 'object') return value;
  if (value.region && typeof value.region === 'object') {
    return value.region.kind === 'unknown' ? { ...value, region: fallback } : value;
  }
  return value.kind === 'unknown' ? fallback : value;
}

/**
 * Keep unresolved accesses in one conservative MemorySSA state partition.
 *
 * A per-access unknown region does not carry separation evidence: the canonical
 * alias safety floor answers any relation involving `kind: "unknown"` as
 * MayAlias. Keeping N such regions therefore makes each unknown write clobber N
 * state partitions without adding precision, producing O(N^2) definitions and
 * alias queries on large functions. Access-local uncertainty remains on the
 * source Semantic IR node/origin; only the MemorySSA state partition is
 * canonicalized here.
 */
export function buildMemorySsa(irFunction, cfg, options = {}) {
  const resolveRegion = options.resolveRegion;
  if (typeof resolveRegion !== 'function') return buildMemorySsaRaw(irFunction, cfg, options);

  const rawFunctionId = irFunction?.functionId;
  if (rawFunctionId == null || !String(rawFunctionId).trim()) {
    // Preserve build.js as the authority for malformed-input error semantics.
    return buildMemorySsaRaw(irFunction, cfg, options);
  }
  const functionId = String(rawFunctionId);
  const fallback = canonicalUnknownRegion(functionId);
  const identity = {
    ...(options.identity ?? {
      functionId,
      memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
      analyzerVersion: MEMORY_SSA_BUILD_VERSION,
    }),
    unknownPartitionNormalizationVersion: MEMORY_SSA_UNKNOWN_PARTITION_VERSION,
  };

  return buildMemorySsaRaw(irFunction, cfg, {
    ...options,
    identity,
    resolveRegion(memory, context) {
      const resolved = resolveRegion(memory, context);
      // Preserve the existing fail-closed contract: build.js rejects async
      // region resolvers. Do not await or reinterpret such a result here.
      if (resolved && typeof resolved.then === 'function') return resolved;
      return collapseUnknownResolution(resolved, fallback);
    },
  });
}

export {
  getMemoryDefinition,
  getMemoryUse,
  reachingMemoryDefinition,
  reachingConcreteStore,
  forwardMemoryValue,
  reconstructMemoryValue,
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  canonicalMemoryForwardingContext,
  canonicalMemoryForwardingContextForLoad,
  isCanonicalExactMemoryForwarding,
  isCanonicalExactMemoryOperandForwarding,
  memoryUsesOfDefinition,
  memoryDefinitionsForRegion,
  memoryAccessMetadata,
  memoryVersionAtBlock,
  explainMemoryPath,
} from './queries.js';
export { validateMemorySsa } from './validate.js';

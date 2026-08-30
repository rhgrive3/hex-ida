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
  buildMemorySsa,
} from './build.js';
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

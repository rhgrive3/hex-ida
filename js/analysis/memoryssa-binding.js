import { MEMORY_SSA_BUILD_VERSION } from '../semantics/memoryssa/build.js';
import { MEMORY_SSA_CONTRACT_VERSION } from '../semantics/memoryssa/contract.js';

const UNBOUND_SNAPSHOT_ID = 'snapshot-unbound';

/**
 * Validates the identity floor shared by the A2 boundary and public MemorySSA
 * queries.  The caller supplies the already-normalized binding so this helper
 * only decides whether the artifact can be published as current.
 */
export function validateMemorySsaBinding({ memorySsa, ir, binding, snapshotId } = {}) {
  const expectedSnapshotId = snapshotId ?? UNBOUND_SNAPSHOT_ID;
  if (!memorySsa || typeof memorySsa !== 'object' || Array.isArray(memorySsa)) {
    return { valid: false, state: 'unsupported', reason: 'memoryssa-invalid' };
  }
  if (typeof memorySsa.functionId !== 'string'
      || typeof ir?.functionId !== 'string'
      || memorySsa.functionId !== ir.functionId) {
    return { valid: false, state: 'stale', reason: 'memoryssa-stale-function' };
  }
  if (binding?.functionId != null
      && (typeof binding.functionId !== 'string'
          || typeof ir.functionId !== 'string'
          || binding.functionId !== ir.functionId)) {
    return { valid: false, state: 'stale', reason: 'memoryssa-stale-function' };
  }
  if (memorySsa.snapshotId != null
      && (typeof memorySsa.snapshotId !== 'string'
          || typeof expectedSnapshotId !== 'string'
          || memorySsa.snapshotId !== expectedSnapshotId)) {
    return { valid: false, state: 'stale', reason: 'memoryssa-stale-snapshot' };
  }
  if (typeof expectedSnapshotId !== 'string'
      || typeof binding?.snapshotId !== 'string'
      || binding.snapshotId !== expectedSnapshotId) {
    return { valid: false, state: 'stale', reason: 'memoryssa-stale-snapshot' };
  }
  if (memorySsa.contractVersion !== MEMORY_SSA_CONTRACT_VERSION) {
    return { valid: false, state: 'unsupported', reason: 'memoryssa-contract-mismatch' };
  }
  if (memorySsa.buildVersion !== MEMORY_SSA_BUILD_VERSION) {
    return { valid: false, state: 'stale', reason: 'memoryssa-build-mismatch' };
  }
  if (binding?.memorySsaBuildVersion != null
      && (typeof binding.memorySsaBuildVersion !== 'string'
          || typeof memorySsa.buildVersion !== 'string'
          || binding.memorySsaBuildVersion !== memorySsa.buildVersion)) {
    return { valid: false, state: 'stale', reason: 'memoryssa-build-mismatch' };
  }
  if (binding?.semanticIrVersion != null
      && (typeof binding.semanticIrVersion !== 'string'
          || typeof ir.contractVersion !== 'string'
          || binding.semanticIrVersion !== ir.contractVersion)) {
    return { valid: false, state: 'stale', reason: 'semantic-ir-version-mismatch' };
  }
  if (binding?.completeness !== 'complete') {
    return { valid: false, state: 'unsupported', reason: 'memoryssa-incomplete' };
  }
  return { valid: true, state: 'current', reason: null };
}

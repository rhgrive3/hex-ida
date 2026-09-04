/**
 * js/symbolic/solver/backend.js
 *
 * Base class for SolverBackend abstraction and proof-trust contract.
 */

import { stableDigest } from '../../core/identity/index.js';

export const PROOF_AUTHORITY = Object.freeze({
  NONE: 'none',
  TEST_ONLY: 'test-only',
  HEURISTIC: 'heuristic',
  EXACT: 'exact',
});

const AUTHORITY_VALUES = new Set(Object.values(PROOF_AUTHORITY));
const BACKEND_INSTANCES = new WeakSet();

export class SolverBackend {
  constructor({
    id,
    version,
    proofAuthority = PROOF_AUTHORITY.NONE,
    isRemote = false,
    isWasm = false,
    requiresCanonicalQueryIdentity = false,
  }) {
    if (typeof id !== 'string' || !id || typeof version !== 'string' || !version) {
      throw new TypeError('SolverBackend: id and version must be non-empty strings');
    }
    if (!AUTHORITY_VALUES.has(proofAuthority)) {
      throw new TypeError(`SolverBackend: invalid proof authority '${proofAuthority}'`);
    }
    this.id = id;
    this.version = version;
    this.proofAuthority = proofAuthority;
    this.isRemote = Boolean(isRemote);
    this.isWasm = Boolean(isWasm);
    this.requiresCanonicalQueryIdentity = requiresCanonicalQueryIdentity === true;
    BACKEND_INSTANCES.add(this);
  }

  /**
   * Capabilities which participate in the immutable capability fingerprint.
   * Subclasses should override this method rather than capabilities().
   */
  baseCapabilities() {
    return {
      supportedSorts: ['bool', 'bv'],
      maxBvWidth: 64,
      supportsQuantifiers: false,
      supportsIncremental: false,
      supportsCancellation: true,
      supportsModelExtraction: true,
      sessionReuseAfterTimeout: false,
      exactProofs: false,
      executionIsolation: 'provider-defined',
      memoryBudgetClass: 'measured-only',
      isRemote: this.isRemote,
      isWasm: this.isWasm,
    };
  }

  capabilityFingerprint() {
    return stableDigest({
      schemaVersion: 'solver-capability/v1',
      id: this.id,
      version: this.version,
      proofAuthority: this.proofAuthority,
      capabilities: this.baseCapabilities(),
    });
  }

  capabilities() {
    return Object.freeze({
      ...this.baseCapabilities(),
      proofAuthority: this.proofAuthority,
      capabilityFingerprint: this.capabilityFingerprint(),
    });
  }

  createSession(options = {}) {
    throw new Error('createSession must be implemented by solver backend subclass');
  }
}

export function isSolverBackendInstance(value) {
  return value != null && typeof value === 'object' && BACKEND_INSTANCES.has(value);
}

export function isExactProofBackend(backend) {
  if (!isSolverBackendInstance(backend)) return false;
  if (backend.proofAuthority !== PROOF_AUTHORITY.EXACT) return false;
  if (typeof backend.id !== 'string' || !backend.id || typeof backend.version !== 'string' || !backend.version) return false;
  if (typeof backend.capabilities !== 'function' || typeof backend.capabilityFingerprint !== 'function') return false;
  const capabilities = backend.capabilities();
  return (
    capabilities?.proofAuthority === PROOF_AUTHORITY.EXACT &&
    capabilities?.exactProofs === true &&
    capabilities?.supportsModelExtraction === true &&
    typeof capabilities?.capabilityFingerprint === 'string' &&
    capabilities.capabilityFingerprint === backend.capabilityFingerprint()
  );
}

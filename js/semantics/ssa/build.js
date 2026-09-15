import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import {
  SEMANTIC_SSA_BUILD_DEFAULT_BUDGET,
  SEMANTIC_SSA_BUILD_VERSION,
  buildSemanticSsa as buildSemanticSsaCore,
} from './build-core.js';

export { SEMANTIC_SSA_BUILD_DEFAULT_BUDGET, SEMANTIC_SSA_BUILD_VERSION };

class CanonicalSemanticSsaArtifact {
  #producerBrand = true;
  #functionId;
  #semanticIrDigest;
  #scalarSsaDigest;

  constructor(payload, binding) {
    for (const key of Object.keys(payload)) this[key] = payload[key];
    this.#functionId = String(binding.functionId);
    this.#semanticIrDigest = String(binding.semanticIrDigest);
    this.#scalarSsaDigest = String(binding.scalarSsaDigest);
    Object.setPrototypeOf(this, Object.prototype);
  }

  static matches(value, binding) {
    try {
      return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && #producerBrand in value
        && value.#functionId === String(binding.functionId)
        && value.#semanticIrDigest === String(binding.semanticIrDigest)
        && value.#scalarSsaDigest === String(binding.scalarSsaDigest);
    } catch {
      return false;
    }
  }
}

export function canonicalSemanticSsaProducerMatches(artifact, binding) {
  if (!binding || typeof binding !== 'object') return false;
  if (binding.functionId == null || binding.semanticIrDigest == null || binding.scalarSsaDigest == null) return false;
  return CanonicalSemanticSsaArtifact.matches(artifact, binding);
}

export function buildSemanticSsa(irInput, cfgInput, options = {}) {
  const artifact = buildSemanticSsaCore(irInput, cfgInput, options);
  const scalarSsaDigest = stableDigest(artifact);
  return deepFreeze(new CanonicalSemanticSsaArtifact(artifact, {
    functionId: artifact.functionId,
    semanticIrDigest: stableDigest(irInput),
    scalarSsaDigest,
  }));
}

export const buildScalarSsa = buildSemanticSsa;

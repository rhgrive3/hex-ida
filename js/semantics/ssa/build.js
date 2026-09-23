import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import {
  SEMANTIC_SSA_BUILD_DEFAULT_BUDGET,
  SEMANTIC_SSA_BUILD_VERSION,
  buildSemanticSsa as buildSemanticSsaCore,
} from './build-core.js';

export { SEMANTIC_SSA_BUILD_DEFAULT_BUDGET, SEMANTIC_SSA_BUILD_VERSION };

class CanonicalSemanticSsaRow {
  #rowBrand = true;
  #producer;

  constructor(row, producer) {
    for (const key of Object.keys(row)) this[key] = row[key];
    this.#producer = producer;
    Object.setPrototypeOf(this, Object.prototype);
  }

  static matchesProducer(row, producer) {
    try {
      return row !== null
        && typeof row === 'object'
        && #rowBrand in row
        && row.#producer === producer;
    } catch {
      return false;
    }
  }
}

class CanonicalSemanticSsaArtifact {
  #producerBrand = true;
  #functionId;
  #semanticIrDigest;
  #scalarSsaDigest;
  #snapshotId;
  #semanticIrSource;

  constructor(payload, binding) {
    for (const key of Object.keys(payload)) {
      if (key === 'uses' && Array.isArray(payload.uses)) {
        this.uses = payload.uses.map((use) => new CanonicalSemanticSsaRow(use, this));
      } else if (key === 'definitions' && Array.isArray(payload.definitions)) {
        this.definitions = payload.definitions.map((def) => new CanonicalSemanticSsaRow(def, this));
      } else {
        this[key] = payload[key];
      }
    }
    this.#functionId = String(binding.functionId);
    this.#semanticIrDigest = String(binding.semanticIrDigest);
    this.#scalarSsaDigest = String(binding.scalarSsaDigest);
    this.#snapshotId = binding.snapshotId != null ? String(binding.snapshotId) : null;
    this.#semanticIrSource = binding.semanticIrSource ?? null;
    Object.setPrototypeOf(this, Object.prototype);
  }

  static has(value) {
    try {
      return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && #producerBrand in value;
    } catch {
      return false;
    }
  }

  static matches(value, binding) {
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || !(#producerBrand in value)) {
        return false;
      }
      if (value.#functionId !== String(binding.functionId)) return false;
      if (value.#semanticIrDigest !== String(binding.semanticIrDigest)) return false;
      if (binding.scalarSsaDigest != null && value.#scalarSsaDigest !== String(binding.scalarSsaDigest)) return false;
      if (value.#snapshotId != null && binding.snapshotId != null && value.#snapshotId !== String(binding.snapshotId)) return false;
      return true;
    } catch {
      return false;
    }
  }

  static matchesRow(row, producer) {
    return CanonicalSemanticSsaRow.matchesProducer(row, producer);
  }

  static binding(value) {
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || !(#producerBrand in value)) {
        return null;
      }
      return Object.freeze({
        functionId: value.#functionId,
        semanticIrDigest: value.#semanticIrDigest,
        scalarSsaDigest: value.#scalarSsaDigest,
        snapshotId: value.#snapshotId,
      });
    } catch {
      return null;
    }
  }

  static bindingForIr(value, ir) {
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || !(#producerBrand in value)
          || value.#semanticIrSource !== ir) return null;
      return CanonicalSemanticSsaArtifact.binding(value);
    } catch {
      return null;
    }
  }
}

export function isCanonicalSemanticSsaProducerArtifact(artifact) {
  return CanonicalSemanticSsaArtifact.has(artifact);
}

export function canonicalSemanticSsaProducerMatches(artifact, binding) {
  if (!binding || typeof binding !== 'object') return false;
  if (binding.functionId == null || binding.semanticIrDigest == null) return false;
  return CanonicalSemanticSsaArtifact.matches(artifact, binding);
}

export function canonicalSemanticSsaProducerBinding(artifact) {
  return CanonicalSemanticSsaArtifact.binding(artifact);
}

export function canonicalSemanticSsaProducerBindingForIr(artifact, ir) {
  return CanonicalSemanticSsaArtifact.bindingForIr(artifact, ir);
}

export function canonicalSemanticSsaRowMatches(row, artifact) {
  return CanonicalSemanticSsaArtifact.matchesRow(row, artifact);
}

export function buildSemanticSsa(irInput, cfgInput, options = {}) {
  const artifact = buildSemanticSsaCore(irInput, cfgInput, options);
  const scalarSsaDigest = stableDigest(artifact);
  const snapshotId = options.snapshotId ?? options.identity?.snapshotId ?? null;
  return deepFreeze(new CanonicalSemanticSsaArtifact(artifact, {
    functionId: artifact.functionId,
    semanticIrDigest: stableDigest(irInput),
    scalarSsaDigest,
    snapshotId,
    semanticIrSource: irInput,
  }));
}

export const buildScalarSsa = buildSemanticSsa;

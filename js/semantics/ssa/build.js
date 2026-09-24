import { deepFreeze, stableDigest, stableStringify } from '../../core/identity/index.js';
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


function canonicalSemanticSsaDigest(artifact) {
  let aLow = 0x84222325; let aHigh = 0xcbf29ce4;
  let bLow = 0xcbf29ce4; let bHigh = 0x84222325;
  const feed = (text) => {
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      aLow ^= code;
      let carry = ((aLow >>> 16) * 0x1b3 + (((aLow & 0xffff) * 0x1b3) >>> 16)) >>> 16;
      aHigh = (Math.imul(aHigh, 0x1b3) + (aLow << 8) + carry) | 0;
      aLow = Math.imul(aLow, 0x1b3);
      bLow ^= code;
      carry = ((bLow >>> 16) * 0x1b3 + (((bLow & 0xffff) * 0x1b3) >>> 16)) >>> 16;
      bHigh = (Math.imul(bHigh, 0x1b3) + (bLow << 8) + carry) | 0;
      bLow = Math.imul(bLow, 0x1b3);
    }
  };
  const cachedCanonical = new WeakMap();
  const canonicalText = (value) => {
    if (value !== null && typeof value === 'object') {
      const cached = cachedCanonical.get(value);
      if (cached !== undefined) return cached;
      const text = stableStringify(value);
      cachedCanonical.set(value, text);
      return text;
    }
    return stableStringify(value);
  };
  const string = (value) => feed(JSON.stringify(value));
  const nullableString = (value) => value == null ? feed('null') : string(value);
  const array = (values, emit) => {
    feed('[');
    for (let index = 0; index < values.length; index += 1) {
      if (index > 0) feed(',');
      emit(values[index]);
    }
    feed(']');
  };
  const incoming = (entry) => {
    feed('{"predecessorBlockId":'); string(entry.predecessorBlockId);
    feed(',"valueId":'); string(entry.valueId); feed('}');
  };
  const definition = (entry) => {
    feed('{"blockId":'); nullableString(entry.blockId);
    feed(',"definitionId":'); string(entry.definitionId);
    feed(',"incoming":'); array(entry.incoming, incoming);
    feed(',"kind":'); string(entry.kind);
    feed(',"origin":'); feed(canonicalText(entry.origin));
    if (Object.hasOwn(entry, 'proof')) { feed(',"proof":'); feed(canonicalText(entry.proof)); }
    feed(',"sourceEntityId":'); nullableString(entry.sourceEntityId);
    feed(',"valueId":'); string(entry.valueId);
    feed(',"variableKey":'); nullableString(entry.variableKey);
    feed('}');
  };
  const use = (entry) => {
    feed('{"blockId":'); nullableString(entry.blockId);
    feed(',"origin":'); feed(canonicalText(entry.origin));
    if (Object.hasOwn(entry, 'proof')) { feed(',"proof":'); feed(canonicalText(entry.proof)); }
    feed(',"sourceEntityId":'); string(entry.sourceEntityId);
    feed(',"useId":'); string(entry.useId);
    feed(',"valueId":'); string(entry.valueId);
    feed('}');
  };
  const useDefLink = (entry) => {
    feed('{"definitionId":'); string(entry.definitionId);
    feed(',"useId":'); string(entry.useId);
    feed(',"valueId":'); string(entry.valueId);
    feed('}');
  };
  const defUseLink = (entry) => {
    feed('{"definitionId":'); string(entry.definitionId);
    feed(',"useIds":'); array(entry.useIds, string);
    feed(',"valueId":'); string(entry.valueId);
    feed('}');
  };

  feed('{"contractVersion":'); string(artifact.contractVersion);
  feed(',"defUseLinks":'); array(artifact.defUseLinks, defUseLink);
  feed(',"definitions":'); array(artifact.definitions, definition);
  feed(',"functionId":'); string(artifact.functionId);
  feed(',"useDefLinks":'); array(artifact.useDefLinks, useDefLink);
  feed(',"uses":'); array(artifact.uses, use);
  feed('}');

  const hex = (high, low) => (high >>> 0).toString(16).padStart(8, '0')
    + (low >>> 0).toString(16).padStart(8, '0');
  return hex(aHigh, aLow) + hex(bHigh, bLow);
}

export function buildSemanticSsa(irInput, cfgInput, options = {}) {
  const artifact = buildSemanticSsaCore(irInput, cfgInput, options);
  const scalarSsaDigest = canonicalSemanticSsaDigest(artifact);
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

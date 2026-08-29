import {
  CANONICAL_ADDRESS_DERIVATION_VERSION,
  GENERIC_ROOT_DESCRIPTOR_KINDS,
  canonicalAddressProofToRegionEvidence,
  deriveCanonicalAddressProof as deriveCanonicalAddressProofCore,
  sameCanonicalAddressProof,
} from './canonical-address-v2-core.js';

export {
  CANONICAL_ADDRESS_DERIVATION_VERSION,
  GENERIC_ROOT_DESCRIPTOR_KINDS,
  canonicalAddressProofToRegionEvidence,
  sameCanonicalAddressProof,
};

/*
 * Generic SSA represents an unseeded incoming physical state with an explicit
 * `undef` definition carrying proof.kind === `implicit-undef`. For address
 * derivation that sentinel means "no reaching semantic write exists on this
 * path", not "a prior clobber may have happened". Treat only that proven seed as
 * a symbolic entry definition while deriving addresses.
 *
 * This does not manufacture a concrete pointer or value: root identity still
 * comes from the state variable / architecture-neutral root descriptor, and
 * unknown definitions, unknown calls, clobbers, and non-exact PHIs remain
 * unknown. The normalization is local to canonical-address proof construction;
 * the canonical SSA contract itself is left untouched.
 */

const PROVEN_SEPARATION_DESCRIPTOR_KINDS = new Set(['global-like', 'heap-like', 'tls-like']);

function rootDescriptorForProof(proof, options = {}) {
  if (!proof || !['rooted', 'root-only'].includes(proof.kind)) return null;
  const table = options.rootDescriptors;
  if (table == null) return null;
  const variableKey = proof.rootIdentity?.variable?.key;
  const keys = variableKey == null ? [] : [`variable:${String(variableKey)}`, String(variableKey)];
  if (table instanceof Map) {
    for (const key of keys) if (table.has(key)) return table.get(key);
    return null;
  }
  if (typeof table !== 'object' || Array.isArray(table)) return null;
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  return null;
}

function attachSeparationAuthority(proof, options = {}) {
  const descriptor = rootDescriptorForProof(proof, options);
  const kind = descriptor == null ? null : String(descriptor.kind ?? '');
  if (!PROVEN_SEPARATION_DESCRIPTOR_KINDS.has(kind)) return proof;
  return Object.freeze({ ...proof, separationClass: kind, separationAuthority: 'root-descriptor' });
}

// The rewrite below is a pure function of the incoming SSA. Cache it by SSA
// identity so repeated queries in one pass keep the same normalized SSA
// reference, which the core proof cache keys on.
const normalizedSsaMemo = new WeakMap();
function normalizedImplicitUndefSsa(ssa) {
  let normalized = normalizedSsaMemo.get(ssa);
  if (normalized === undefined) {
    const definitions = ssa?.definitions;
    normalized = definitions.some((definition) =>
      definition?.kind === 'undef' && definition?.proof?.kind === 'implicit-undef')
      ? {
        ...ssa,
        definitions: definitions.map((definition) =>
          definition?.kind === 'undef' && definition?.proof?.kind === 'implicit-undef'
            ? { ...definition, kind: 'entry' }
            : definition),
      }
      : ssa;
    normalizedSsaMemo.set(ssa, normalized);
  }
  return normalized;
}

function addressProofOptions(options = {}) {
  const definitions = options?.ssa?.definitions;
  if (!Array.isArray(definitions)) return options;
  const ssa = normalizedImplicitUndefSsa(options.ssa);
  if (ssa === options.ssa) return options;
  return { ...options, ssa };
}

export {
  defaultRootEntityId,
  normalizeRootIdentity,
} from './canonical-address-v2-core.js';

export function deriveCanonicalAddressProof(ir, addressValueId, options = {}) {
  const normalizedOptions = addressProofOptions(options);
  return attachSeparationAuthority(deriveCanonicalAddressProofCore(ir, addressValueId, normalizedOptions), normalizedOptions);
}

export function deriveCanonicalRegionEvidence(ir, addressValueId, options = {}) {
  return canonicalAddressProofToRegionEvidence(deriveCanonicalAddressProof(ir, addressValueId, options));
}

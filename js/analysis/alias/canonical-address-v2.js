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

// A proof object is valid only when it came through this canonical producer.
// The WeakSet is intentionally private: matching fields alone are not a minting capability.
const CANONICAL_ROOT_DESCRIPTOR_PROOFS = new WeakSet();

function rootDescriptorForProof(proof) {
  if (!proof || !['rooted', 'root-only'].includes(proof.kind)) return null;
  // The core has already normalized and validated this provenance. This
  // projection is intentionally proof-local: it never re-reads either the
  // descriptor table or the provider.
  return {
    kind: proof.separationClass,
    authority: proof.separationAuthority,
  };
}

function attachSeparationAuthority(proof) {
  const descriptor = rootDescriptorForProof(proof);
  const kind = typeof descriptor?.kind === 'string' ? descriptor.kind : null;
  if (PROVEN_SEPARATION_DESCRIPTOR_KINDS.has(kind)
      && descriptor.authority === 'root-descriptor') {
    CANONICAL_ROOT_DESCRIPTOR_PROOFS.add(proof);
  }
  // `proof` is frozen by the core, and the metadata above is its validated
  // provenance. Returning it directly avoids a provider/table re-invocation.
  return proof;
}

export function isCanonicalRootDescriptorProof(proof) {
  return proof != null
    && (typeof proof === 'object' || typeof proof === 'function')
    && CANONICAL_ROOT_DESCRIPTOR_PROOFS.has(proof);
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
  return attachSeparationAuthority(deriveCanonicalAddressProofCore(ir, addressValueId, normalizedOptions));
}

export function deriveCanonicalRegionEvidence(ir, addressValueId, options = {}) {
  return canonicalAddressProofToRegionEvidence(deriveCanonicalAddressProof(ir, addressValueId, options));
}

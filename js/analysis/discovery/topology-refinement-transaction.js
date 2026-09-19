/**
 * B1a — function-topology refinement transaction (the only writer).
 *
 * Accepts only a *complete* proposal from `noreturn-refinement.js` and performs
 * one compare-and-swap commit against the captured T0 binding:
 *
 *   - the binding must still be current (same symbols object, generation,
 *     topology revision, start-set digest, backend epoch, discovery key,
 *     ProgramIndex object/evidence digest and query snapshot);
 *   - the whole candidate batch is validated before the first write;
 *   - the commit is append-only through `SymbolIndex.applyFunctionTopologyRefinement`;
 *   - exactly one completed wave is recorded per bootstrap discovery key, so
 *     rebuilding E/S under T1 never schedules an implicit second wave;
 *   - a zero-candidate or already-applied transaction is a complete no-op.
 *
 * It deliberately does not own binary bytes, loader reparsing, source hashes or
 * `rebuild/transaction-v2.js`. `rebuild/transaction-v2.js` must not be imported.
 *
 * Any mismatch returns `stale` and performs zero mutation.
 */

export const TOPOLOGY_REFINEMENT_TRANSACTION_VERSION = 'function-topology-refinement/v1';

// Guardrail: this module must never depend on the byte-rewrite transaction.
export const TOPOLOGY_REFINEMENT_FORBIDDEN_DEPENDENCY = 'js/rebuild/transaction-v2.js';

function proposalDigest(proposal) {
  const rows = [];
  for (const candidate of proposal?.candidates || []) {
    rows.push(`${candidate?.start?.toString?.() ?? ''}>${candidate?.callSite?.toString?.() ?? ''}`);
  }
  rows.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return rows.join(',');
}

function waveKey(proposal) {
  const binding = proposal?.binding ?? {};
  return [
    proposal?.producer?.id ?? 'unknown',
    proposal?.producer?.version ?? '0',
    binding.binaryId ?? '',
    binding.analysisEpoch ?? '',
    binding.discoveryKey ?? '',
    binding.functionTopologyRevision ?? '',
    binding.startSetDigest ?? '',
    binding.programEvidenceDigest ?? '',
    proposalDigest(proposal),
  ].join('|');
}

/**
 * @param {object} input
 * @param {object} input.proposal
 * @param {object} input.symbols                      SymbolIndex to mutate
 * @param {(binding:object)=>boolean} input.bindingIsCurrent
 * @param {{has:(key:string)=>boolean, mark:(key:string)=>void}} input.wave
 * @param {(candidate:object)=>boolean} [input.validateCandidate]
 * @param {()=>void} [input.invalidate]
 */
export function commitFunctionTopologyRefinement({
  proposal, symbols, bindingIsCurrent, wave, validateCandidate = null, invalidate = null,
} = {}) {
  if (!proposal || typeof proposal !== 'object' || proposal.status?.completeness !== 'complete') {
    return Object.freeze({ status: 'incomplete', added: 0, revision: null });
  }
  if (!symbols || typeof symbols.applyFunctionTopologyRefinement !== 'function' || typeof bindingIsCurrent !== 'function') {
    return Object.freeze({ status: 'stale', added: 0, revision: null });
  }
  // The completed-wave marker is checked before the binding CAS so that
  // re-applying the *same* proposal after its own commit is `already-applied`
  // rather than a misleading `stale` (the commit itself moved the generation).
  const key = waveKey(proposal);
  if (wave && typeof wave.has === 'function' && wave.has(key) === true) {
    return Object.freeze({ status: 'already-applied', added: 0, revision: symbols.functionTopologyRevision ?? 0 });
  }
  // Re-check identity immediately before the first mutation.
  if (bindingIsCurrent(proposal.binding) !== true) {
    return Object.freeze({ status: 'stale', added: 0, revision: null });
  }

  const candidates = Array.isArray(proposal.candidates) ? proposal.candidates : [];
  const accepted = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      return Object.freeze({ status: 'stale', added: 0, revision: null });
    }
    if (typeof validateCandidate === 'function' && validateCandidate(candidate) !== true) {
      return Object.freeze({ status: 'stale', added: 0, revision: null });
    }
    accepted.push(candidate);
  }
  if (!accepted.length) {
    if (wave && typeof wave.mark === 'function') wave.mark(key);
    return Object.freeze({ status: 'no-op', added: 0, revision: symbols.functionTopologyRevision ?? 0 });
  }

  // Validate the entire batch before the first write; after this point there is
  // no await and no throwing analysis work.
  const result = symbols.applyFunctionTopologyRefinement(accepted);
  if (!result || result.added === 0) {
    if (wave && typeof wave.mark === 'function') wave.mark(key);
    return Object.freeze({ status: 'no-op', added: 0, revision: result?.revision ?? (symbols.functionTopologyRevision ?? 0) });
  }
  if (wave && typeof wave.mark === 'function') wave.mark(key);
  if (typeof invalidate === 'function') invalidate();
  return Object.freeze({ status: 'committed', added: result.added, revision: result.revision });
}
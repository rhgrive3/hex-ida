/**
 * C4-04B pass-local rewrite denominator.
 *
 * These rows classify which semantic proof scope may authorize each non-scalar
 * rewrite family.  They do not issue authority: the query receipt and the
 * Phase 8 transaction both still have to be current.  Unknown kinds are not an
 * extensibility escape hatch; they are outside the accepted C4-04 denominator.
 */
export const C4_EQUIVALENCE_REWRITE_REGISTRY_VERSION = 'hex.phase8.c4-equivalence-registry/1';

const rows = [
  ['memory-byte-rewrite', 'hex.symbolic.query.memory-equivalence', 'finite-byte-execution',
    ['terminal-return','all-terminal-memory-bytes','terminal-control-target']],
  ['cfg-rewrite', 'hex.symbolic.query.memory-equivalence', 'finite-byte-execution',
    ['path-coverage','terminal-return','all-terminal-memory-bytes','terminal-control-target']],
  ['bounded-loop-rewrite', 'hex.symbolic.query.memory-equivalence', 'finite-byte-execution',
    ['bounded-path-coverage','terminal-return','all-terminal-memory-bytes','terminal-control-target']],
  ['terminal-control-effect-rewrite', 'hex.symbolic.query.terminal-effect-equivalence', 'terminal-control-effects',
    ['terminal-control-target','terminal-control-normal-completion','terminal-fault-predicates']],
];

export const C4_EQUIVALENCE_REWRITE_REGISTRY = Object.freeze(rows.map(([kind, verifier, proofScope, observables]) => Object.freeze({
  kind, verifier, proofScope, observables:Object.freeze(observables),
})));

const BY_KIND = new Map(C4_EQUIVALENCE_REWRITE_REGISTRY.map(row => [row.kind,row]));

export function c4EquivalenceRewriteRule(kind) {
  return typeof kind === 'string' ? BY_KIND.get(kind) ?? null : null;
}

export function c4EquivalenceRewriteRegistryFailure(kind, verifier) {
  const row = c4EquivalenceRewriteRule(kind);
  if (!row) return 'phase8-c4-rewrite-kind-unregistered';
  if (row.verifier !== verifier) return 'phase8-c4-rewrite-verifier-mismatch';
  return null;
}

/** Registered Phase 8 transaction coverage. Policies restrict publication;
 * names, these rows and their digests never issue a semantic proof capability.
 */
export const REWRITE_REGISTRY_VERSION = 'hex.phase8.rewrite-registry/1';
const facts = (...families) => Object.freeze({mode:'analysis-only',families:Object.freeze(families),kinds:Object.freeze([])});
const POLICIES = Object.freeze({
  'phase8.identity':facts('canonical-identity'),
  'phase8.sccp':facts('scalar-constants-and-ranges','branch-feasibility'),
  'phase8.gvn':facts('scalar-congruence-candidates','memory-reuse-candidates'),
  'phase8.dce':facts('dead-value-candidates'),
  'phase8.induction':facts('induction-and-loop-candidates'),
  'phase8.aggregates':facts('aggregate-layout-candidates'),
  'phase8.structuring':facts('structured-region-candidates'),
  'phase8.providers':facts('optional-refinement-hints'),
  'phase8.solver-constants':Object.freeze({mode:'proof-gated-value-projection',
    families:Object.freeze(['total-pure-bv-value']),kinds:Object.freeze(['solver-constant','solver-scalar'])}),
});

export function passRewritePolicy(descriptor) {
  const id = Object.getOwnPropertyDescriptor(descriptor ?? {},'id')?.value;
  return typeof id === 'string' && Object.hasOwn(POLICIES,id) ? POLICIES[id] : null;
}

/** Exact union check, not a top-N search or a list detached from execution. */
export function buildRewriteRegistry(passes) {
  const seen = new Set();
  const rows = passes.map(({descriptor}) => {
    const policy = passRewritePolicy(descriptor);
    if (!policy || seen.has(descriptor.id)) throw new TypeError('phase8-rewrite-registry-unclassified-or-duplicate');
    seen.add(descriptor.id);
    return Object.freeze({passId:descriptor.id,passVersion:descriptor.version,stage:descriptor.stage,...policy});
  });
  if (seen.size !== Object.keys(POLICIES).length) throw new TypeError('phase8-rewrite-registry-incomplete');
  return Object.freeze(rows);
}

/** Only called after the ordinary owned PassResult snapshot. Proof identity is
 * checked independently by the existing private admission path, never by ID. */
export function rewritePolicyFailure(descriptor, result, {required=false, proofPass=false} = {}) {
  const policy = passRewritePolicy(descriptor);
  if (!policy) return required ? 'rewrite-policy-unclassified' : null;
  if (policy.mode === 'analysis-only') return result.transforms.length ? 'analysis-only-pass-reported-transform' : null;
  if (!proofPass) return 'rewrite-policy-proof-pass-identity';
  return result.transforms.some(transform => !policy.kinds.includes(transform.kind)) ? 'rewrite-policy-undeclared-kind' : null;
}

/** Audit of transaction coverage, NOT rendered adoption or proof authority.
 * A withheld vertical cannot preserve earlier private pass successes as commits.
 */
export function rewriteCoverage(registry, passes, results, published, reason = null) {
  const selected = new Set(passes.map(pass => pass.descriptor.id));
  const byId = new Map(results.map(result => [result.passId,result]));
  const rows = registry.map(row => {
    const enabled = selected.has(row.passId), result = published && enabled ? byId.get(row.passId) : null;
    const disposition = !enabled ? 'not-requested' : !result ? 'unknown'
      : result.status === 'unsupported' ? 'unsupported'
      : row.mode === 'analysis-only' ? 'analysis-only'
      : result.transforms.length ? 'proof-committed' : 'unchanged';
    return Object.freeze({...row,selected:enabled,disposition,
      resultStatus:result?.status ?? null,completeness:result?.completeness ?? 'unknown',
      proofTransformCount:result && row.mode === 'proof-gated-value-projection' ? result.transforms.length : 0,
      reason:!enabled ? 'stage-or-proof-not-requested' : result?.stopReason ?? (result ? null : reason ?? 'missing-pass-result')});
  });
  return Object.freeze({version:REWRITE_REGISTRY_VERSION,scope:'registered-phase8-transactions-not-render-adoption',
    registered:registry.length,selected:selected.size,accounted:rows.length,rows:Object.freeze(rows)});
}

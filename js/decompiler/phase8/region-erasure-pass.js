/** Dedicated canonical region proof candidates through the existing atomic
 * transaction. Admission is not rendered erasure or permission to delete C. */
import { createPassDescriptor, createPassResult, ANALYSIS_KEYS } from './contract.js';
import { configurePhase8RegionProofApi, committedRegionOverlay } from './transaction.js';
import { readConditionalRegionErasure } from './conditional-region-erasure.js';

const artifacts = new WeakMap(), results = new WeakMap();
export const REGION_ERASURE_PASS = createPassDescriptor({
  id:'phase8.proved-regions', version:'1.0.0', stage:'rendering',
  consumes:['ssa','origins'], produces:['provedRegions'],
  preserves:ANALYSIS_KEYS.filter(key => key !== 'provedRegions'),
  description:'Admit canonical unreachable-arm candidates; rendered condition/PHI/provenance validation remains required.',
});
const identityOf = context => context.proofIdentity ?? context.opts?.phase8ProofIdentity;
const planOf = context => context.regionErasurePlan ?? context.opts?.phase8RegionErasurePlan;
const current = (plan, context) => readConditionalRegionErasure(plan, context.ir, identityOf(context));

export function runRegionErasurePass(context, budget, area) {
  const plan = planOf(context);
  if (budget.shouldAbort?.() || !current(plan, context)) throw new TypeError('stale-or-forged-region-plan');
  const artifact = Object.freeze({ version:1, completeness:'complete', planId:plan.planId,
    identity:plan.identity, scope:plan.scope, removedRole:plan.removedRole, queryHash:plan.queryHash,
    transformAuthorization:false, renderValidation:'required', pendingValidation:plan.pendingValidation });
  artifacts.set(artifact, plan);
  const transform = { kind:'proved-unreachable-arm-candidate', targets:[plan.planId],
    proof:plan.proofRule, originRefs:[String(plan.region.branch.id)],
    rewrite:Object.freeze({ beforeHash:plan.beforeHash, afterHash:plan.afterHash }),
    validation:Object.freeze({ schemaVersion:'hex-phase8-region-validation/v1',
      verifier:'hex.phase8.excluded-path-body-erasure', planId:plan.planId, queryHash:plan.queryHash }) };
  const result = createPassResult({ descriptor:REGION_ERASURE_PASS, status:'changed',
    produced:['provedRegions'], transforms:[transform] });
  results.set(result, { artifact, plan });
  area.stage('provedRegions', artifact);
  return result;
}

export function regionAdmissionReason(result, staged, descriptor, context) {
  try {
    const binding = results.get(result);
    if (descriptor !== REGION_ERASURE_PASS || !binding || !current(binding.plan, context)
      || planOf(context) !== binding.plan || staged.size !== 1 || staged.get('provedRegions') !== binding.artifact
      || artifacts.get(binding.artifact) !== binding.plan) return 'region-proof-admission-invalid';
    return null;
  } catch { return 'region-proof-admission-invalid'; }
}

export function regionPublicationResult(result) {
  return results.has(result) ? result : null;
}

export function readProvedRegionErasure(analysis, context) {
  const artifact = committedRegionOverlay(analysis), plan = artifacts.get(artifact);
  try { return plan && planOf(context) === plan && current(plan, context) ? plan : null; } catch { return null; }
}

configurePhase8RegionProofApi({ REGION_ERASURE_PASS, regionAdmissionReason, regionPublicationResult });

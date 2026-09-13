/** Read-only conditional model checks. Models come ONLY from a private current
 * owner, never an AI/tool payload. A model result cannot qualify native facts.
 */
import { recordFields, exactString, exactEnum, snapshotContractData, contractFail } from '../../../core/identity/structured.js';
import { deepFreeze, stableStringify } from '../../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../../core/identity/world.js';
import { assertScopedAnalysisWork } from '../../../core/budgets/scoped-work.js';
import { checkScalableVectorModel } from '../../../core/evidence/scalable-vector.js';
import { checkSmeCallFrame } from '../../../core/evidence/sme-call-frame.js';
import { checkMemoryEventModel } from '../../../core/evidence/memory-event-model.js';
export const CONDITIONAL_FAMILIES = Object.freeze(['scalable-vector', 'sme-call-frame', 'memory-events']);
export async function queryConditionalModel(input, {world,assumptions,snapshotId,work,getContext,isCurrent} = {}) {
  assertWorldScope(world);assertAssumptionSet(assumptions,world);assertScopedAnalysisWork(work);work.checkpoint();
  const q=snapshotContractData(input,{maxBytes:131072,maxNodes:8192});
  work.charge('residentBytes',stableStringify(q).length*2);
  recordFields(q,['functionId','modelId','family','claim'],'conditional-query-fields');
  exactString(q.functionId,'conditional-function');exactString(q.modelId,'conditional-model');exactEnum(q.family,CONDITIONAL_FAMILIES,'conditional-family');
  if(q.family==='sme-call-frame'&&q.claim!==undefined)contractFail('conditional-SME-claim-not-supported');
  if(typeof getContext!=='function')return {status:'unsupported',reason:'current-conditional-model-owner-required',exact:false};
  const context=await work.await(signal=>getContext(q.functionId,q.modelId,q.family,{world,assumptions,snapshotId,signal}));
  work.checkpoint();if(!context)return {status:'unsupported',reason:'conditional-model-unavailable',exact:false};
  const current=()=>isCurrent?.()===true&&context.isCurrent?.()===true;
  if(!current())contractFail('conditional-model-stale');
  const binding=snapshotContractData(context.binding,{maxBytes:16384,maxNodes:256});
  recordFields(binding,['worldId','assumptionsId','snapshotId','functionLocator','modelId','family','modelRevision','artifactId','sourceReferences'],'conditional-binding-fields');
  if(binding.worldId!==world.id||binding.assumptionsId!==assumptions.id||binding.snapshotId!==snapshotId||binding.functionLocator!==q.functionId
    ||binding.modelId!==q.modelId||binding.family!==q.family)contractFail('conditional-owner-binding');
  exactString(binding.modelRevision,'conditional-revision');exactString(binding.artifactId,'conditional-artifact');
  if(!Array.isArray(binding.sourceReferences)||!binding.sourceReferences.length||binding.sourceReferences.length>32)contractFail('conditional-source-references');
  binding.sourceReferences.forEach(v=>exactString(v,'conditional-source-reference'));
  work.charge('residentBytes',stableStringify(binding).length*2);
  const checked=q.family==='scalable-vector'?checkScalableVectorModel(context.model,q.claim??null,{work})
    :q.family==='sme-call-frame'?checkSmeCallFrame(context.model,{work}):checkMemoryEventModel(context.model,q.claim,{work});
  work.checkpoint();if(!current())contractFail('conditional-model-stale-before-publication');
  return deepFreeze({schema:'scpa-conditional-model-evidence/v1',status:'completed',binding,checked,
    exact:false,semanticClosure:'unknown',semanticProof:false,rewriteAuthorized:false,canonicalTruthChanged:false,defaultActivation:false,releaseQualified:false,
    sourceBinding:'current-host-model-references; native-model-correspondence-unproved'});
}

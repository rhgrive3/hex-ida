/** Core-only model capsule. Current-source binding is a separate live check. */
import {snapshotContractData,recordFields,exactString,contractFail} from '../identity/structured.js';
import {deepFreeze,stableStringify} from '../identity/index.js';
import {assertScopedAnalysisWork} from '../budgets/scoped-work.js';
import {checkScalarLoopInvariant,LOOP_CHECKER_VERSION} from './loop-invariant.js';
export const PORTABLE_LOOP_SCHEMA='scpa-portable-loop-check/v1';
export function normalizePortableLoop(input) {
  const c=snapshotContractData(input,{maxBytes:32768,maxNodes:1024});
  recordFields(c,['schema','checkerVersion','binding','model','candidate','remaining'],'portable-loop-fields');
  if(c.schema!==PORTABLE_LOOP_SCHEMA)contractFail('portable-loop-schema');exactString(c.checkerVersion,'portable-loop-version');
  const fields=['worldId','assumptionsId','snapshotId','functionLocator','loopId','modelRevision','artifactId'];
  recordFields(c.binding,[...fields,'sourceReferences'],'portable-loop-binding-fields');fields.forEach(k=>exactString(c.binding[k],'portable-loop-binding-required',512));
  if(!Array.isArray(c.binding.sourceReferences)||!c.binding.sourceReferences.length||c.binding.sourceReferences.length>32)contractFail('portable-loop-source-refs');
  c.binding.sourceReferences.forEach(v=>exactString(v,'portable-loop-source-ref',512));
  if(!Array.isArray(c.remaining)||c.remaining.length>128)contractFail('portable-loop-remaining');c.remaining.forEach(v=>exactString(v,'portable-loop-remaining',512));
  return deepFreeze(c);
}
export async function replayPortableLoop(input,{work}={}) {
  assertScopedAnalysisWork(work);work.checkpoint();const c=normalizePortableLoop(input);work.charge('residentBytes',stableStringify(c).length*2);
  const checked=c.checkerVersion===LOOP_CHECKER_VERSION?checkScalarLoopInvariant(c.model,c.candidate,{work}):{status:'unknown',reason:'portable-loop-checker-version-unavailable'};
  const verified=checked.status==='verified-model'?1:0,rejected=checked.status==='rejected'?1:0;
  return deepFreeze({schema:'scpa-portable-loop-replay/v1',status:'completed',checkerVersion:LOOP_CHECKER_VERSION,binding:c.binding,checks:[checked],
    counts:{requested:1,verified,rejected,unknown:1-verified-rejected},allListedDerivationsChecked:verified===1,
    sourceBinding:'detached-unverified',exact:false,semanticProof:false,wholeQueryProof:false,executableCodeAccepted:false,
    remaining:[...c.remaining,'current-host-model-and-source-reference-rebinding-required','native-machine-and-closed-loop-proof-unproved']});
}

/** Core-only model capsule. Current-source binding is a separate live check. */
import {snapshotContractData,recordFields,exactString,contractFail} from '../identity/structured.js';
import {deepFreeze,stableStringify} from '../identity/index.js';
import {assertScopedAnalysisWork} from '../budgets/scoped-work.js';
import {checkScalarLoopInvariant,LOOP_CHECKER_VERSION} from './loop-invariant.js';
import {checkArm64ScalarLoop,ARM64_LOOP_CHECKER_VERSION} from './arm64-loop-fragment.js';
export const PORTABLE_LOOP_SCHEMA='scpa-portable-loop-check/v1';
export function normalizePortableLoop(input) {
  const c=snapshotContractData(input,{maxBytes:32768,maxNodes:1024});
  recordFields(c,['schema','checkerVersion','binding','model','candidate','remaining','nativeFragment'],'portable-loop-fields');
  if(c.schema!==PORTABLE_LOOP_SCHEMA)contractFail('portable-loop-schema');exactString(c.checkerVersion,'portable-loop-version');
  const fields=['worldId','assumptionsId','snapshotId','functionLocator','loopId','modelRevision','artifactId'];
  recordFields(c.binding,[...fields,'sourceReferences'],'portable-loop-binding-fields');fields.forEach(k=>exactString(c.binding[k],'portable-loop-binding-required',512));
  if(!Array.isArray(c.binding.sourceReferences)||!c.binding.sourceReferences.length||c.binding.sourceReferences.length>32)contractFail('portable-loop-source-refs');
  c.binding.sourceReferences.forEach(v=>exactString(v,'portable-loop-source-ref',512));
  if(!Array.isArray(c.remaining)||c.remaining.length>128)contractFail('portable-loop-remaining');c.remaining.forEach(v=>exactString(v,'portable-loop-remaining',512));
  if(c.nativeFragment!==undefined){
    const n=c.nativeFragment;recordFields(n,['checkerVersion','profile','source','bytesHex'],'portable-loop-native-fields');
    exactString(n.checkerVersion,'portable-loop-native-version');
    recordFields(n.source,['binaryId','offset','virtualStart','length'],'portable-loop-native-source-fields');
    exactString(n.source.binaryId,'portable-loop-native-binary');
    for(const key of ['offset','virtualStart'])if(typeof n.source[key]!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(n.source[key]))contractFail('portable-loop-native-address');
    if(BigInt(n.source.virtualStart)%4n||BigInt(n.source.offset)+24n>(1n<<64n)||BigInt(n.source.virtualStart)+24n>(1n<<64n))contractFail('portable-loop-native-address-range');
    if(n.source.length!==24||typeof n.bytesHex!=='string'||!/^[a-f0-9]{48}$/.test(n.bytesHex))contractFail('portable-loop-native-byte-shape');
  }
  return deepFreeze(c);
}
export async function replayPortableLoop(input,{work}={}) {
  assertScopedAnalysisWork(work);work.checkpoint();const c=normalizePortableLoop(input);work.charge('residentBytes',stableStringify(c).length*2);
  let checked=c.checkerVersion===LOOP_CHECKER_VERSION?checkScalarLoopInvariant(c.model,c.candidate,{work}):{status:'unknown',reason:'portable-loop-checker-version-unavailable'};
  if(c.nativeFragment&&checked.status==='verified-model'){
    const n=c.nativeFragment;
    checked=n.checkerVersion===ARM64_LOOP_CHECKER_VERSION?checkArm64ScalarLoop(Uint8Array.from(n.bytesHex.match(/../g),s=>parseInt(s,16)),c.model,c.candidate,{profile:n.profile,work}):{status:'unknown',reason:'portable-native-loop-checker-version-unavailable'};
  }
  const verified=['verified-model','verified-fragment'].includes(checked.status)?1:0,rejected=checked.status==='rejected'?1:0;
  return deepFreeze({schema:'scpa-portable-loop-replay/v1',status:'completed',checkerVersion:LOOP_CHECKER_VERSION,binding:c.binding,checks:[checked],
    counts:{requested:1,verified,rejected,unknown:1-verified-rejected},allListedDerivationsChecked:verified===1,
    sourceBinding:'detached-unverified',exact:false,semanticProof:false,wholeQueryProof:false,executableCodeAccepted:false,
    remaining:[...c.remaining,'current-host-model-and-source-reference-rebinding-required',
      ...(checked.status==='verified-fragment'?['whole-function-and-external-entry-proof-outside-native-fragment-domain']:['native-machine-and-closed-loop-proof-unproved'])]});
}

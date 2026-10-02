#!/usr/bin/env node
// Development collector: previously judged plain queries; never a new final judge.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {openProduct} from '../tools/validation/public-benchmark/product-host.mjs';
import {recoverCxxMembersForQuery,recoverCxxMembersForSemanticQuery,recoverCxxMemberWithJev,cxxMemberIndexForApp} from '../js/analysis/query/app-adapter.js';
import {CxxMemberIndex} from '../js/analysis/cxx/member-index.js';
import {isCanonicalCppMemberEvidence,isCanonicalCppReceiverEvidence} from '../js/analysis/cxx/object-evidence.js';
import {pinpointField,jevShortlist} from '../js/pinpoint.js';
import {cxxSemanticViews,withCxxSemanticPreference} from '../js/analysis/query/cxx-semantic-preference.js';
import {parseGoal} from '../js/goals.js';
import {recoverySnapshot} from './jev-realgame-recovery-contract.mjs';
import {persistentWrite,sha256} from './jev-realgame-final-contract.mjs';

const [binaryPath,queriesFile,destination,planningPolicy='value-accessor-v3',operation='collect',selectionFile]=process.argv.slice(2);
const arm="hex-value";
if(!binaryPath||!queriesFile||!destination||!['value-accessor-v3','object-context-v4','staged-object-v4','semantic-retrieval-v5'].includes(planningPolicy)
  ||!['collect','metadata-only','selected-replay','baseline-and-metadata','interactive-replay'].includes(operation))
  throw new Error('usage: RELEASE_BINARY PLAIN_QUERIES OUTPUT PLANNING_POLICY [collect|metadata-only|selected-replay|baseline-and-metadata|interactive-replay] [DEVELOPMENT_SELECTION]');
// A development replay decompiles the single function selected by a previously
// recorded real API response. It neither reads a gold file nor makes another
// API call. Exact production request bytes must agree before replaying it.
const selectionBytes=['selected-replay','interactive-replay'].includes(operation)?fs.readFileSync(selectionFile):null;
const selection=selectionBytes?JSON.parse(selectionBytes):null;
if(selection&&(!selection.complete||selection.developmentOnly!==true
  ||selection.authorizesDefaultActivation!==false||planningPolicy!=='semantic-retrieval-v5'
  ||!Array.isArray(selection.records)))throw new Error('development selection binding failure');
const initialPlanningPolicy=planningPolicy==='staged-object-v4'?'value-accessor-v3':planningPolicy;
const queryBytes=fs.readFileSync(queriesFile),manifest=JSON.parse(queryBytes),bytes=fs.readFileSync(binaryPath);
const binarySha256=sha256(bytes);
if(manifest.binarySha256!==binarySha256||!manifest.binaryKey||!Array.isArray(manifest.cases)||!manifest.cases.length
  ||manifest.cases.some(c=>Object.keys(c).some(k=>!['id','query','mode'].includes(k))||!c.id||typeof c.query!=='string')
  ||new Set(manifest.cases.map(c=>c.id)).size!==manifest.cases.length)throw new Error('blind query binding failure');
const policyBytes=fs.readFileSync(new URL('../reports/investigations/jev-realgame-final/default-v3/policy-freeze.json',import.meta.url));
const policy=JSON.parse(policyBytes);
const product=await openProduct(binaryPath);
if(product.unsupported)throw new Error(product.reason);
const rawRecovered=[];const originalPublish=CxxMemberIndex.prototype.publish;
try {
  CxxMemberIndex.prototype.publish=function(projection) {
    const receiver=projection?.receiver;
    if(isCanonicalCppReceiverEvidence(receiver)&&receiver.classIdentity?.className)for(const member of projection.members??[]) {
      if(!isCanonicalCppMemberEvidence(member)||member.receiverDigest!==receiver.digest||member.snapshotId!==receiver.snapshotId
        ||member.functionId!==receiver.functionId||member.mixedWidths||member.indexed||!member.sizeBytes)continue;
      rawRecovered.push({binarySha256,className:receiver.classIdentity.className,offset:Number(member.offsetBytes),size:member.sizeBytes,
        conflict:false,recoveredType:{category:member.category,proven:member.typeProven},receiverDigest:receiver.digest,memberDigest:member.digest});
    }
    return originalPublish.call(this,projection);
  };
  const rows=[],metadataRows=[];
  for(const c of manifest.cases) {
    const replay=selection?.records.find(row=>row.id===c.id&&row.repeat===0);
    if(selection&&(!replay||replay.query!==c.query||replay.binarySha256!==binarySha256))
      throw new Error('development selection query/binary binding failure');
    if(arm==='hex-value') {
      let choices=[],body=null;
      const recovery=await recoverCxxMembersForQuery(product.app,c.query,{enabled:true,planOnly:true,
        planningPolicy:initialPlanningPolicy,jevRetrieval:true,
        jevClient:{call:async input=>{choices=input.choices;body=input.body;return null;}}});
      metadataRows.push({id:c.id,query:c.query,recovery,choices,body});
      if(replay&&sha256(JSON.stringify(body))!==replay.bodySha256)
        throw new Error('development request projection drift');
    }
    if(operation==='metadata-only')continue;
    const beforeCount=cxxMemberIndexForApp(product.app)?.fieldCount??0;
    const recover=planningPolicy==='staged-object-v4'?recoverCxxMembersForSemanticQuery:recoverCxxMembersForQuery;
    let recovery=await recover(product.app,c.query,{enabled:true,
      jevRetrieval:operation==='selected-replay',
      jevClient:replay?{call:async input=>{
        if(sha256(JSON.stringify(input.body))!==replay.bodySha256)
          throw new Error('development request projection drift');
        return replay.call?.error?null:replay.call?.response;
      }}:undefined,
      planningPolicy:['baseline-and-metadata','interactive-replay'].includes(operation)?'value-accessor-v3':initialPlanningPolicy,
      captureBaseline:async()=>{
        const initialHex=await pinpointField({goal:parseGoal(c.query),fields:product.app.fields,cxxFields:cxxMemberIndexForApp(product.app),limit:400});
        return {verdict:initialHex.verdict,topKey:initialHex.top?.key??null};
      },
      maxFunctions:operation==='selected-replay'?1:policy.collection.maxFunctionsPerQuery,
      maxElapsedMs:policy.collection.maxElapsedMs});
    let retrieval=null;
    const capture=()=>pinpointField({goal:parseGoal(c.query),fields:product.app.fields,cxxFields:cxxMemberIndexForApp(product.app),limit:400});
    const primaryHex=await capture(),primaryRecovery=recovery;
    if(operation==='interactive-replay') {
      retrieval=await recoverCxxMemberWithJev(product.app,c.query,{enabled:true,mode:c.mode,
        captureBaseline:async()=>primaryHex,captureCurrent:capture,
        jevClient:{call:async input=>{
          if(sha256(JSON.stringify(input.body))!==replay.bodySha256)throw new Error('development request projection drift');
          return replay.call?.error?null:replay.call?.response;
        }},maxElapsedMs:policy.collection.maxElapsedMs});
      recovery={...primaryRecovery,attempted:[...primaryRecovery.attempted,...(retrieval.recovery?.attempted??[])],
        elapsedMs:primaryRecovery.elapsedMs+(retrieval.recovery?.elapsedMs??0),primary:primaryRecovery,extension:retrieval.recovery};
    }
    const index=cxxMemberIndexForApp(product.app),start=performance.now();
    const hex=await capture();
    const hexLatencyMs=performance.now()-start;
    const preferenceStart=performance.now(),stable=withCxxSemanticPreference(c.query,hex,product.app.symbols);
    const preferenceLatencyMs=performance.now()-preferenceStart;
    const trustedViews=cxxSemanticViews(hex.candidates,product.app.symbols);
    if(!trustedViews||trustedViews.some(v=>!v))throw new Error('unbound production context');
    const candidates=hex.candidates.map((s,index)=>({...recoverySnapshot(s,product.app.symbols,binarySha256),functionContexts:trustedViews[index].functionContexts})),byKey=new Map(candidates.map(s=>[s.key,s]));
    const published=[...(index?.classes.values()??[])].flatMap(cls=>cls.ivars.map(field=>({key:field.key,source:'cxx',
      binarySha256,className:cls.name,offset:field.offset,size:field.size,recoveredType:field.recoveredType,conflict:field.conflict})));
    rows.push({id:c.id,binary:manifest.binaryKey,query:c.query,binarySha256,beforeCount,recovery,candidateCount:candidates.length,
      verdict:hex.verdict,topKey:hex.top?.key??null,stableTopKey:stable.top?.key??null,semanticPreference:stable.semanticPreference??null,trustedViews,preferenceLatencyMs,candidates,shortlist:jevShortlist(hex.candidates,{max:255}).map(s=>byKey.get(s.key)),
      primaryTopKey:primaryHex.top?.key??null,primaryVerdict:primaryHex.verdict,
      interactiveTopKey:retrieval?.result?.top?.key??null,interactiveVerdict:retrieval?.result?.verdict??null,
      interactivePreference:retrieval?.result?.semanticPreference??null,interactiveReason:retrieval?.reason??null,
      baselineIdentityInvalidated:retrieval?.baselineIdentityInvalidated??false,
      recovered:rawRecovered.slice(),published,hexLatencyMs,
      routed:c.mode==='partial'&&candidates.length>=2&&!['confirmed','likely'].includes(hex.verdict)});
    persistentWrite(`${destination}.checkpoint`,{complete:false,rows});
    console.log(JSON.stringify({id:c.id,attempted:recovery.attempted.length,candidates:candidates.length,elapsedMs:recovery.elapsedMs,status:recovery.status}));
  }
  const index=cxxMemberIndexForApp(product.app),fields=[...(index?.classes.values()??[])].flatMap(c=>c.ivars);
  const collection={beforeCount:0,afterCount:fields.length,named:fields.filter(f=>!f.anonymous).length,unnamed:fields.filter(f=>f.anonymous).length,
    classCount:index?.classCount??0,keyCollisions:fields.length-new Set(fields.map(f=>f.key)).size,
    analyzedFunctions:new Set(rows.flatMap(r=>r.recovery.attempted.map(a=>a.address))).size,profile:product.profile};
  if(collection.keyCollisions||(operation!=='metadata-only'&&rows.length!==manifest.cases.length)
    ||(operation==='metadata-only'&&(rows.length||metadataRows.length!==manifest.cases.length)))throw new Error('invalid recovery collection');
  const root=new URL('../',import.meta.url);
  persistentWrite(destination,{schema:'hex-jev-context-development/v4',complete:true,developmentOnly:true,authorizesDefaultActivation:false,
    arm,planningPolicy,operation,
    remoteRetrievalExecution:selection?`recorded real API response, primary repeat 0; ${operation==='interactive-replay'?'unchanged primary recovery followed by at most one selected small Fast function':'one existing Fast function per query'}, no live API in collector`:'none; deterministic modern recovery only',
    selectionSha256:selectionBytes?sha256(selectionBytes):null,
    selectionMetadataProductSha:selection?.metadataProductSha??null,
    productSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),binaryKey:manifest.binaryKey,binarySha256,
    queriesSha256:sha256(queryBytes),policySha256:sha256(policyBytes),sourceHashes:Object.fromEntries(
      ['scripts/collect-jev-context-development.mjs','js/rtti.js','js/analysis/cxx/member-index.js','js/analysis/query/jev-advisory.js','js/analysis/cxx/class-type.js','js/analysis/cxx/typed-argument.js','js/analysis/query/jev-recovery.js','js/analysis/cxx/primary-owner.js','scripts/jev-realgame-stability-contract.mjs','js/pinpoint.js','js/analysis/query/cxx-semantic-preference.js','scripts/jev-realgame-recovery-contract.mjs','js/analysis/cxx/query-recovery.js',
        'js/analysis/cxx/member-types.js','js/analysis/cxx/object-evidence.js','js/analysis/cxx/project.js','js/analysis/query/app-adapter.js',
        'js/decompiler/pipeline-core.js','js/decompiler/value-dependency.js']
        .map(f=>[f,sha256(fs.readFileSync(new URL(f,root)))])),collection,rows});
  if(metadataRows.length)persistentWrite(`${destination}.metadata.json`,{
    schema:'hex-jev-recovery-metadata-audit/v3',complete:true,developmentOnly:true,authorizesDefaultActivation:false,
    planningPolicy,productSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    binarySha256,queriesSha256:sha256(queryBytes),profile:product.profile,
    sourceHashes:Object.fromEntries(['js/analysis/cxx/class-type.js','js/analysis/cxx/typed-argument.js','js/analysis/cxx/primary-owner.js','js/analysis/cxx/project.js',
      'js/analysis/cxx/member-types.js','js/analysis/cxx/object-evidence.js','js/analysis/query/cxx-semantic-preference.js',
      'js/analysis/cxx/query-recovery.js','js/analysis/query/app-adapter.js','js/analysis/query/jev-recovery.js',
      'scripts/collect-jev-context-development.mjs','js/rtti.js','js/analysis/cxx/member-index.js','js/analysis/query/jev-advisory.js'].map(f=>[f,sha256(fs.readFileSync(new URL(f,root)))])),rows:metadataRows});
} finally {CxxMemberIndex.prototype.publish=originalPublish;await product.close();}

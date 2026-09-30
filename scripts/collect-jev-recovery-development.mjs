#!/usr/bin/env node
// Blind collector: release binary + immutable plain user queries only.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {openProduct} from '../tools/validation/public-benchmark/product-host.mjs';
import {recoverCxxMembersForQuery,cxxMemberIndexForApp} from '../js/analysis/query/app-adapter.js';
import {CxxMemberIndex} from '../js/analysis/cxx/member-index.js';
import {isCanonicalCppMemberEvidence,isCanonicalCppReceiverEvidence} from '../js/analysis/cxx/object-evidence.js';
import {pinpointField,jevShortlist} from '../js/pinpoint.js';
import {cxxSemanticViews,withCxxSemanticPreference} from '../js/analysis/query/cxx-semantic-preference.js';
import {parseGoal} from '../js/goals.js';
import {recoverySnapshot} from './jev-realgame-recovery-contract.mjs';
import {persistentWrite,sha256} from './jev-realgame-final-contract.mjs';

const [binaryPath,queriesFile,selectionFile,destination,arm]=process.argv.slice(2);
if(!binaryPath||!queriesFile||!selectionFile||!destination||!['hex','hex-value','jev-retrieval'].includes(arm))throw new Error('usage: BINARY PLAIN_QUERIES SELECTION OUTPUT ARM');
const queryBytes=fs.readFileSync(queriesFile),manifest=JSON.parse(queryBytes),bytes=fs.readFileSync(binaryPath);
const binarySha256=sha256(bytes);
if(manifest.binarySha256!==binarySha256||!manifest.binaryKey||!Array.isArray(manifest.cases)||!manifest.cases.length
  ||manifest.cases.some(c=>Object.keys(c).some(k=>!['id','query','mode'].includes(k))||!c.id||typeof c.query!=='string')
  ||new Set(manifest.cases.map(c=>c.id)).size!==manifest.cases.length)throw new Error('blind query binding failure');
const policyBytes=fs.readFileSync(new URL('../reports/investigations/jev-realgame-final/stability-v2/policy-freeze.json',import.meta.url));
const policy=JSON.parse(policyBytes);
const selection=JSON.parse(fs.readFileSync(selectionFile));
if(!selection.complete||selection.developmentOnly!==true)throw new Error('development selection receipt required');
const selected=new Map(selection.records.filter(r=>r.repeat===0).map(r=>[r.id,r]));
if(manifest.cases.some(c=>selected.get(c.id)?.query!==c.query||selected.get(c.id)?.binarySha256!==binarySha256))throw new Error('selection query/binary mismatch');
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
  const rows=[];
  for(const c of manifest.cases) {
    const beforeCount=cxxMemberIndexForApp(product.app)?.fieldCount??0;
    const receipt=selected.get(c.id);
    const replayClient={call:async input=>{
      if(sha256(JSON.stringify(input.body))!==receipt.bodySha256)throw new Error('release retrieval shortlist changed');
      return receipt.call?.error?null:receipt.call?.response??null;
    }};
    const recovery=await recoverCxxMembersForQuery(product.app,c.query,{enabled:true,
      jevRetrieval:arm==='jev-retrieval',jevClient:replayClient,
      planningPolicy:arm==='hex-value'?'value-accessor-v3':'legacy',
      maxFunctions:policy.collection.maxFunctionsPerQuery,maxElapsedMs:policy.collection.maxElapsedMs});
    const index=cxxMemberIndexForApp(product.app),start=performance.now();
    const hex=await pinpointField({goal:parseGoal(c.query),fields:product.app.fields,cxxFields:index,limit:400});
    const hexLatencyMs=performance.now()-start;
    const preferenceStart=performance.now(),stable=withCxxSemanticPreference(c.query,hex,product.app.symbols);
    const preferenceLatencyMs=performance.now()-preferenceStart;
    const trustedViews=cxxSemanticViews(hex.candidates,product.app.symbols);
    if(!trustedViews||trustedViews.some(v=>!v))throw new Error('unbound production context');
    const candidates=hex.candidates.map(s=>recoverySnapshot(s,product.app.symbols,binarySha256)),byKey=new Map(candidates.map(s=>[s.key,s]));
    const published=[...(index?.classes.values()??[])].flatMap(cls=>cls.ivars.map(field=>({key:field.key,source:'cxx',
      binarySha256,className:cls.name,offset:field.offset,size:field.size,recoveredType:field.recoveredType,conflict:field.conflict})));
    rows.push({retrievalReceiptSha256:sha256(JSON.stringify(receipt)),retrievalApiAddedLatencyMs:arm==='jev-retrieval'?receipt.call?.latencyMs??0:0,id:c.id,binary:manifest.binaryKey,query:c.query,binarySha256,beforeCount,recovery,candidateCount:candidates.length,
      verdict:hex.verdict,topKey:hex.top?.key??null,stableTopKey:stable.top?.key??null,semanticPreference:stable.semanticPreference??null,trustedViews,preferenceLatencyMs,candidates,shortlist:jevShortlist(hex.candidates,{max:255}).map(s=>byKey.get(s.key)),
      recovered:rawRecovered.slice(),published,hexLatencyMs,
      routed:c.mode==='partial'&&candidates.length>=2&&!['confirmed','likely'].includes(hex.verdict)});
    persistentWrite(`${destination}.checkpoint`,{complete:false,rows});
    console.log(JSON.stringify({id:c.id,attempted:recovery.attempted.length,candidates:candidates.length,elapsedMs:recovery.elapsedMs,status:recovery.status}));
  }
  const index=cxxMemberIndexForApp(product.app),fields=[...(index?.classes.values()??[])].flatMap(c=>c.ivars);
  const collection={beforeCount:0,afterCount:fields.length,named:fields.filter(f=>!f.anonymous).length,unnamed:fields.filter(f=>f.anonymous).length,
    classCount:index?.classCount??0,keyCollisions:fields.length-new Set(fields.map(f=>f.key)).size,
    analyzedFunctions:new Set(rows.flatMap(r=>r.recovery.attempted.map(a=>a.address))).size,profile:product.profile};
  if(collection.keyCollisions||rows.length!==manifest.cases.length)throw new Error('invalid recovery collection');
  const root=new URL('../',import.meta.url);
  persistentWrite(destination,{schema:'hex-jev-recovery-development-snapshot/v3',complete:true,developmentOnly:true,authorizesDefaultActivation:false,
    arm,selectionSha256:sha256(fs.readFileSync(selectionFile)),remoteRetrievalExecution:'validated-live-response-replay',
    productSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),binaryKey:manifest.binaryKey,binarySha256,
    queriesSha256:sha256(queryBytes),policySha256:sha256(policyBytes),sourceHashes:Object.fromEntries(
      ['scripts/collect-jev-recovery-development.mjs','js/analysis/query/jev-recovery.js','js/analysis/cxx/primary-owner.js','scripts/jev-realgame-stability-contract.mjs','js/pinpoint.js','js/analysis/query/cxx-semantic-preference.js','scripts/jev-realgame-recovery-contract.mjs','js/analysis/cxx/query-recovery.js',
        'js/analysis/cxx/member-types.js','js/analysis/cxx/object-evidence.js','js/analysis/cxx/project.js','js/analysis/query/app-adapter.js',
        'js/decompiler/pipeline-core.js','js/decompiler/value-dependency.js']
        .map(f=>[f,sha256(fs.readFileSync(new URL(f,root)))])),collection,rows});
} finally {CxxMemberIndex.prototype.publish=originalPublish;await product.close();}

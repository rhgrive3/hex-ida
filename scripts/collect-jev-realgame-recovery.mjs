#!/usr/bin/env node
// Blind collector: release binary + immutable plain user queries only.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {openProduct} from '../tools/validation/public-benchmark/product-host.mjs';
import {recoverCxxMembersForQuery,cxxMemberIndexForApp} from '../js/analysis/query/app-adapter.js';
import {CxxMemberIndex} from '../js/analysis/cxx/member-index.js';
import {isCanonicalCppMemberEvidence,isCanonicalCppReceiverEvidence} from '../js/analysis/cxx/object-evidence.js';
import {pinpointField,jevShortlist} from '../js/pinpoint.js';
import {parseGoal} from '../js/goals.js';
import {recoverySnapshot} from './jev-realgame-recovery-contract.mjs';
import {persistentWrite,sha256} from './jev-realgame-final-contract.mjs';

const [binaryPath,queriesFile,destination]=process.argv.slice(2);
if(!binaryPath||!queriesFile||!destination)throw new Error('usage: BINARY PLAIN_QUERIES OUTPUT');
const queryBytes=fs.readFileSync(queriesFile),manifest=JSON.parse(queryBytes),bytes=fs.readFileSync(binaryPath);
const binarySha256=sha256(bytes);
if(manifest.binarySha256!==binarySha256||!manifest.binaryKey||!Array.isArray(manifest.cases)||!manifest.cases.length
  ||manifest.cases.some(c=>Object.keys(c).some(k=>!['id','query','mode'].includes(k))||!c.id||typeof c.query!=='string')
  ||new Set(manifest.cases.map(c=>c.id)).size!==manifest.cases.length)throw new Error('blind query binding failure');
const policyBytes=fs.readFileSync(new URL('../reports/investigations/jev-realgame-final/recovery-policy-freeze.json',import.meta.url));
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
  const rows=[];
  for(const c of manifest.cases) {
    const beforeCount=cxxMemberIndexForApp(product.app)?.fieldCount??0;
    const recovery=await recoverCxxMembersForQuery(product.app,c.query,{enabled:true,
      maxFunctions:policy.collection.maxFunctionsPerQuery,maxElapsedMs:policy.collection.maxElapsedMs});
    const index=cxxMemberIndexForApp(product.app),start=performance.now();
    const hex=await pinpointField({goal:parseGoal(c.query),fields:product.app.fields,cxxFields:index,limit:400});
    const hexLatencyMs=performance.now()-start;
    const candidates=hex.candidates.map(s=>recoverySnapshot(s,product.app.symbols,binarySha256)),byKey=new Map(candidates.map(s=>[s.key,s]));
    const published=[...(index?.classes.values()??[])].flatMap(cls=>cls.ivars.map(field=>({key:field.key,source:'cxx',
      binarySha256,className:cls.name,offset:field.offset,size:field.size,recoveredType:field.recoveredType,conflict:field.conflict})));
    rows.push({id:c.id,binary:manifest.binaryKey,query:c.query,binarySha256,beforeCount,recovery,candidateCount:candidates.length,
      verdict:hex.verdict,topKey:hex.top?.key??null,candidates,shortlist:jevShortlist(hex.candidates,{max:255}).map(s=>byKey.get(s.key)),
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
  persistentWrite(destination,{schema:'hex-jev-recovery-production-snapshot/v1',complete:true,
    productSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),binaryKey:manifest.binaryKey,binarySha256,
    queriesSha256:sha256(queryBytes),policySha256:sha256(policyBytes),sourceHashes:Object.fromEntries(
      ['scripts/collect-jev-realgame-recovery.mjs','scripts/jev-realgame-recovery-contract.mjs','js/analysis/cxx/query-recovery.js',
        'js/analysis/cxx/member-types.js','js/analysis/cxx/object-evidence.js','js/analysis/cxx/project.js','js/analysis/query/app-adapter.js']
        .map(f=>[f,sha256(fs.readFileSync(new URL(f,root)))])),collection,rows});
} finally {CxxMemberIndex.prototype.publish=originalPublish;await product.close();}

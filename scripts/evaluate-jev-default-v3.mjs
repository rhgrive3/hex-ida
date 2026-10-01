#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {rerankWithJev,jevShortlist} from '../js/pinpoint.js';
import {jevValueFlowRequest,jevSemanticRoute,jevMemberContextSignature} from '../js/analysis/query/jev-advisory.js';
import {RealGameJevClient} from './jev-realgame-final-client.mjs';
import {stabilityRequestBody} from './jev-realgame-stability-contract.mjs';
import {structuralMatch,funnel,persistentWrite,sha256,percentiles} from './jev-realgame-final-contract.mjs';
import {summarize} from './evaluate-jev-realgame-final.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const report=path.join(root,'reports/investigations/jev-realgame-final/default-v3');
export const DEFAULT_V3_ARMS=['A','R1','current','B','C','E2','V3','S'];
export function assertDefaultExecution(snapshots,freezeFile) {
  const policyBytes=fs.readFileSync(path.join(report,'policy-freeze.json')),policy=JSON.parse(policyBytes);
  const freeze=JSON.parse(fs.readFileSync(freezeFile));
  if(freeze.policySha256!==sha256(policyBytes)
    ||policy.holdoutSha256!==sha256(fs.readFileSync(path.join(report,'holdout.json')))
    ||freeze.structuralCasesSha256!==sha256(fs.readFileSync(path.join(report,'structural-cases.json'))))throw new Error('V3 policy/gold binding failure');
  for(const [file,hash] of Object.entries({...policy.sourceHashes,...freeze.sourceHashes}))
    if(sha256(fs.readFileSync(path.join(root,file)))!==hash)throw new Error(`V3 execution source drift: ${file}`);
  if(snapshots.length!==2||new Set(snapshots.map(snapshot=>snapshot.productSha)).size!==1)throw new Error('V3 collection revision mismatch');
  for(const snapshot of snapshots) {
    if(snapshot.schema!=='hex-jev-default-candidate-snapshot/v3'||!snapshot.complete||snapshot.rows.length!==25
      ||snapshot.collection.keyCollisions!==0||snapshot.policySha256!==sha256(policyBytes))throw new Error('V3 incomplete collection');
    const manifestBytes=fs.readFileSync(path.join(report,`queries-${snapshot.binaryKey}.json`));
    if(snapshot.queriesSha256!==sha256(manifestBytes))throw new Error('V3 frozen query binding failure');
    const manifest=JSON.parse(manifestBytes);
    if(snapshot.binarySha256!==manifest.binarySha256||snapshot.rows.some((row,index)=>row.id!==manifest.cases[index].id||row.query!==manifest.cases[index].query))throw new Error('V3 binary/query order mismatch');
    for(const [file,hash] of Object.entries(snapshot.sourceHashes)) {
      if(sha256(fs.readFileSync(path.join(root,file)))!==hash)throw new Error(`V3 measured source drift: ${file}`);
      if(sha256(execFileSync('git',['show',`${snapshot.productSha}:${file}`],{cwd:root,maxBuffer:32*1024*1024}))!==hash)throw new Error(`V3 collection source revision mismatch: ${file}`);
    }
  }
  return policy;
}

export async function main() {
  const [snapshotsDir,outputDir,freezeFile]=process.argv.slice(2);
  if(!snapshotsDir||!outputDir||!freezeFile||!process.env.OPENJEV_API_KEY)throw new Error('usage: SNAPSHOTS OUTPUT EXECUTION_FREEZE; API key required');
  const snapshots=['openttd','openmw'].map(game=>JSON.parse(fs.readFileSync(path.join(snapshotsDir,`${game}.json`))));
  // Every assertion runs before a remote client can make a request.
  const policy=assertDefaultExecution(snapshots,freezeFile);
  const cases=JSON.parse(fs.readFileSync(path.join(report,'structural-cases.json'))),inputs=new Map(snapshots.flatMap(snapshot=>snapshot.rows.map(row=>[row.id,row])));
  if(cases.length!==50||inputs.size!==50)throw new Error('V3 full holdout denominator required');
  const clients=Object.fromEntries(['current','B','C','E2','V3','S'].map(arm=>[arm,new RealGameJevClient({
    apiKey:process.env.OPENJEV_API_KEY,arm:arm==='S'?'V3':arm,timeoutMs:15000,maxAttempts:1,
    requestBuilder:arm==='V3'||arm==='S'?jevValueFlowRequest:stabilityRequestBody})]));
  const rows=[];
  for(const gold of cases) {
    const input=inputs.get(gold.id);
    if(!input||input.query!==gold.query)throw new Error('V3 case binding failure');
    const candidates=input.candidates,byKey=new Map(candidates.map(candidate=>[candidate.key,candidate]));
    if(byKey.size!==candidates.length||candidates.some(candidate=>candidate.binarySha256!==input.binarySha256
      ||candidate.source!=='cxx'||candidate.anonymous!==true||candidate.fieldName))throw new Error('V3 untrusted/named candidate collection');
    const hex=byKey.get(input.topKey)??null,local=byKey.get(input.stableTopKey)??null;
    const correct=key=>gold.status==='verified'?structuralMatch(byKey.get(key),gold):null;
    const row={id:gold.id,binary:gold.binary,query:gold.query,status:gold.status,gold,verdict:input.verdict,
      funnel:funnel({...input,candidates:input.published},gold),hexLatencyMs:input.hexLatencyMs,
      preferenceLatencyMs:input.preferenceLatencyMs,recovery:input.recovery,arms:{},failureCauses:[]};
    for(const [arm,candidate] of [['A',hex],['R1',local]])row.arms[arm]={key:candidate?.key??null,
      correct:correct(candidate?.key),repeatedKeys:[candidate?.key??null],repeatedCorrect:[correct(candidate?.key)],calls:[]};
    // Independent representations use the same actual lattice. Bounded fanout
    // changes neither candidates nor the untouched query/scoring denominator.
    for(const batch of [['current','B','C'],['E2','V3','S']])await Promise.all(batch.map(async arm=>{
      const selective=arm==='S',pool=selective?candidates.filter(candidate=>!candidate.conflict):candidates;
      const route=selective?jevSemanticRoute(gold.query,pool,{verdict:input.verdict,topKey:local?.key}):{call:input.routed,reason:'unrestricted-weak-comparison'};
      const base={top:selective?local:hex,candidates:pool,verdict:input.verdict},keys=[],answers=[],calls=[];
      for(let repeat=0;repeat<policy.repeats;repeat++) {
        const client=clients[arm],before=client.calls.length;
        const productionClient=arm==='V3'||arm==='S'?{call:async request=>{
          const response=await client.call(request);
          return response&&request.candidates[response.choiceIndex]?.conflict?null:response;
        }}:client;
        const result=await rerankWithJev(gold.query,base,{enabled:route.call&&input.routed,mode:gold.mode,client:productionClient,maxChoices:255});
        let selected=result.top1;
        if(selective&&result.source==='jev'&&pool.some(candidate=>candidate.key!==selected.key
          &&jevMemberContextSignature(candidate)===jevMemberContextSignature(selected)))selected=local;
        keys.push(selected?.key??null);answers.push(correct(selected?.key));
        if(client.calls.length!==before)calls.push({...client.calls.at(-1),repeat,policyArm:arm,committedKey:selected?.key??null});
      }
      row.arms[arm]={key:keys[0],correct:answers[0],repeatedKeys:keys,repeatedCorrect:answers,calls,route,
        goldInShortlist:gold.status==='verified'?jevShortlist(pool,{max:255}).some(candidate=>structuralMatch(candidate,gold)):null};
    }));
    if(row.funnel.unreachableBecauseNotRecovered)row.failureCauses.push('candidate recovery failure');
    if(row.funnel.recoveredButNotPublished)row.failureCauses.push('recovered but not published');
    if(row.funnel.publishedButOutsideShortlist)row.failureCauses.push('published but outside shortlist');
    if(row.funnel.shortlist&&!row.arms.V3.correct)row.failureCauses.push('insufficient member semantics or reranking failure');
    if(new Set(row.arms.V3.repeatedKeys).size>1)row.failureCauses.push('stochastic instability');
    rows.push(row);persistentWrite(path.join(outputDir,'raw-results.jsonl'),rows.map(result=>JSON.stringify(result)).join('\n')+'\n');
    console.log(JSON.stringify({evaluated:rows.length,total:50}));
  }
  const summaries=Object.fromEntries(DEFAULT_V3_ARMS.map(arm=>[arm,summarize(rows,arm)]));
  const againstLocal=rows.map(row=>({...row,arms:{...row.arms,A:row.arms.R1}}));
  const vsR1=Object.fromEntries(DEFAULT_V3_ARMS.map(arm=>[arm,summarize(againstLocal,arm)]));
  const perGame=Object.fromEntries(['openttd','openmw'].map(game=>[game,Object.fromEntries(DEFAULT_V3_ARMS.map(arm=>[arm,summarize(againstLocal.filter(row=>row.binary===game),arm)]))]));
  const summary={schema:'hex-jev-default-quality-results/v3',complete:true,policySha256:sha256(fs.readFileSync(path.join(report,'policy-freeze.json'))),
    executionFreezeSha256:sha256(fs.readFileSync(freezeFile)),collectionRevision:snapshots[0].productSha,
    summaries,vsR1,perGame,collection:snapshots.map(snapshot=>({binary:snapshot.binaryKey,...snapshot.collection})),
    coldRecoveryLatency:percentiles(rows.map(row=>row.recovery.elapsedMs)),
    rawRemoteHighConfidenceErrors:rows.reduce((count,row)=>count+row.arms.V3.calls.filter(call=>row.status==='verified'
      &&!correctCall(row,call)&&call.response?.answers?.pick?.confidence>=0.9&&call.response?.answers?.unique?.noul>=0.9).length,0),
    finalPolicy:'PENDING_PRESERVATION_AND_EXACT_HEAD_GATES',limitations:['Optional J function retrieval is a separate development experiment, not default S evidence']};
  persistentWrite(path.join(outputDir,'summary.json'),summary);
  console.log(JSON.stringify({top1:Object.fromEntries(DEFAULT_V3_ARMS.map(arm=>[arm,summaries[arm].top1])),vsR1:Object.fromEntries(['V3','S'].map(arm=>[arm,{rescue:vsR1[arm].rescue,regression:vsR1[arm].regression}]))}));
}
function correctCall(row,call){return call.selectedKey===row.arms.V3.key&&row.arms.V3.correct
  ||row.arms.V3.repeatedKeys.some((key,index)=>key===call.selectedKey&&row.arms.V3.repeatedCorrect[index]);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.stack);process.exitCode=1;});

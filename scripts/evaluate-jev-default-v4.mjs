#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rerankWithJev,jevShortlist} from '../js/pinpoint.js';
import {cxxObjectSemanticScores,compareCxxSemanticScores} from '../js/analysis/query/cxx-semantic-preference.js';
import {jevArgumentFlowRequest,jevSemanticRoute,jevVisibleArgumentContextSignature} from '../js/analysis/query/jev-advisory.js';
import {RealGameJevClient} from './jev-realgame-final-client.mjs';
import {stabilityRequestBody} from './jev-realgame-stability-contract.mjs';
import {structuralMatch,funnel,persistentWrite,percentiles,sha256} from './jev-realgame-final-contract.mjs';
import {summarize} from './evaluate-jev-realgame-final.mjs';
import {assertV4Execution,V4_ARMS,V4_REPORT} from './jev-default-v4-contract.mjs';

export function v4Summaries(rows) {
  const against=baseline=>Object.fromEntries(V4_ARMS.map(arm=>[arm,summarize(rows.map(row=>
    ({...row,hexCorrect:row.arms[baseline].correct})),arm)]));
  return {summaries:against('A'),vsBeforeExtension:against('A0'),vsBestDeterministic:against('O4'),
    perGame:Object.fromEntries(['openttd','openmw'].map(game=>[game,v4GameSummary(rows.filter(row=>row.binary===game))]))};
}
function v4GameSummary(rows) {
  return Object.fromEntries(['A0','A','O4'].map(baseline=>[baseline,Object.fromEntries(V4_ARMS.map(arm=>
    [arm,summarize(rows.map(row=>({...row,hexCorrect:row.arms[baseline].correct})),arm)]))]));
}
export function v4SelectionAllowed(query,selected,pool,selective) {
  if(!selected||selected.conflict||selected.functionContexts?.some(c=>c.writtenArgumentBitsTruncated===true))return false;
  const signature=selective?jevVisibleArgumentContextSignature(query,selected):null;
  return !selective||!pool.some(peer=>peer.key!==selected.key
    &&jevVisibleArgumentContextSignature(query,peer)===signature);
}

export async function main() {
  const [snapshotDir,outputDir,freezeFile]=process.argv.slice(2);
  if(!snapshotDir||!outputDir||!freezeFile||!process.env.OPENJEV_API_KEY)
    throw new Error('usage: SNAPSHOTS RESULTS EXECUTION_FREEZE; API key required');
  // All source, artifact, query and scoring identity guards precede any call.
  const {policy,snapshots,cases}=assertV4Execution(snapshotDir,freezeFile);
  const inputs=new Map(snapshots.flatMap(s=>s.rows.map(row=>[row.id,row])));
  if(inputs.size!==50)throw new Error('V4 complete unique actual collection required');
  const clients=Object.fromEntries(['current','B','C','V4','S4'].map(arm=>[arm,new RealGameJevClient({
    apiKey:process.env.OPENJEV_API_KEY,arm,timeoutMs:policy.timeoutMs,maxAttempts:1,
    requestBuilder:['V4','S4'].includes(arm)?jevArgumentFlowRequest:stabilityRequestBody})]));
  const rows=[];
  for(const gold of cases) {
    const input=inputs.get(gold.id);
    if(!input||input.query!==gold.query||input.binary!==gold.binary)throw new Error('V4 case binding failure');
    const candidates=input.candidates,byKey=new Map(candidates.map(c=>[c.key,c]));
    if(byKey.size!==candidates.length||candidates.some(c=>c.source!=='cxx'||c.anonymous!==true
      ||c.fieldName!=null||c.binarySha256!==input.binarySha256))throw new Error('V4 actual anonymous lattice boundary failed');
    const correct=key=>gold.status==='verified'?structuralMatch(byKey.get(key),gold):null;
    const beforeKey=input.recovery.baseline?.topKey??null;
    if(beforeKey&&!byKey.has(beforeKey))throw new Error('V4 pre-extension field identity was not preserved');
    const scored=cxxObjectSemanticScores(input.query,candidates).sort(compareCxxSemanticScores);
    const objectTop=scored[0]?.score>0||scored[0]?.objectMatches>0?scored[0].key:input.topKey;
    const row={id:gold.id,binary:gold.binary,query:gold.query,status:gold.status,gold,verdict:input.verdict,
      topKey:input.topKey,hexCorrect:correct(input.topKey),hexLatencyMs:input.hexLatencyMs,
      recovery:input.recovery,funnel:funnel({...input,candidates:input.published},gold),arms:{},failureCauses:[]};
    for(const [arm,key] of [['A0',beforeKey],['A',input.topKey],['R1',input.stableTopKey],['O4',objectTop]])
      row.arms[arm]={key,correct:correct(key),repeatedKeys:[key],repeatedCorrect:[correct(key)],calls:[]};
    for(const batch of [['current','B'],['C','V4'],['S4']])await Promise.all(batch.map(async arm=>{
      const selective=arm==='S4',pool=selective?candidates.filter(c=>!c.conflict):candidates;
      const route=selective?jevSemanticRoute(input.query,pool,{topKey:input.topKey,verdict:input.verdict,policy:'object-context-v4'})
        :{call:input.routed,reason:'unrestricted-weak-comparison'};
      const client=clients[arm],keys=[],answers=[],calls=[];
      const safeClient=['V4','S4'].includes(arm)?{call:async request=>{
        const response=await client.call(request);
        return response&&v4SelectionAllowed(input.query,request.candidates[response.choiceIndex],pool,selective)?response:null;
      }}:client;
      for(let repeat=0;repeat<policy.repeats;repeat++) {
        const before=client.calls.length;
        const base={top:byKey.get(input.topKey)??null,candidates:pool,verdict:input.verdict};
        const result=await rerankWithJev(input.query,base,{enabled:route.call&&input.routed,mode:gold.mode,
          client:safeClient,maxChoices:255});
        const key=result.top1?.key??input.topKey;keys.push(key);answers.push(correct(key));
        if(client.calls.length!==before) {
          const audit=client.calls.at(-1);
          calls.push({...audit,repeat,policyArm:arm,committedKey:key,rawCorrect:correct(audit.selectedKey)});
        }
      }
      row.arms[arm]={key:keys[0],correct:answers[0],repeatedKeys:keys,repeatedCorrect:answers,calls,route,
        goldInShortlist:gold.status==='verified'?jevShortlist(pool,{max:255}).some(c=>structuralMatch(c,gold)):null};
    }));
    if(row.funnel.unreachableBecauseNotRecovered)row.failureCauses.push('candidate recovery failure');
    if(row.funnel.recoveredButNotPublished)row.failureCauses.push('recovered but not published');
    if(row.funnel.publishedButOutsideShortlist)row.failureCauses.push('published but outside shortlist');
    if(row.funnel.shortlist&&!row.arms.V4.correct)row.failureCauses.push('insufficient member semantics or reranking failure');
    if(new Set(row.arms.V4.repeatedKeys).size>1)row.failureCauses.push('stochastic instability');
    rows.push(row);persistentWrite(path.join(outputDir,'raw-results.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
    console.log(JSON.stringify({evaluated:rows.length,total:50}));
  }
  persistentWrite(path.join(outputDir,'summary.json'),{schema:'hex-jev-default-quality-results/v4',complete:true,
    policySha256:sha256(fs.readFileSync(path.join(V4_REPORT,'policy-freeze.json'))),
    executionFreezeSha256:sha256(fs.readFileSync(freezeFile)),
    collectionRevision:snapshots[0].productSha,...v4Summaries(rows),
    collection:snapshots.map(s=>({binary:s.binaryKey,...s.collection})),
    coldRecoveryLatency:percentiles(rows.map(row=>row.recovery.elapsedMs)),
    rawRemoteHighConfidenceErrors:rows.reduce((count,row)=>count+row.arms.V4.calls.filter(call=>row.status==='verified'
      &&call.rawCorrect===false
      &&call.response?.answers?.pick?.confidence>=0.9&&call.response?.answers?.unique?.noul>=0.9).length,0),
    finalPolicy:'PENDING_PRESERVATION_AND_EXACT_HEAD_GATES',
    primaryRepeat:0,majorityVoting:false,repeats:policy.repeats});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(error.stack);process.exitCode=1;});

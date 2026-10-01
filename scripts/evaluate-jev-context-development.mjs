#!/usr/bin/env node
// Existing judged queries only. These observations cannot authorize default
// activation or replace a subsequent untouched, pre-frozen final judge.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {rerankWithJev,jevShortlist} from '../js/pinpoint.js';
import {cxxObjectSemanticScores,compareCxxSemanticScores} from '../js/analysis/query/cxx-semantic-preference.js';
import {jevArgumentFlowRequest,jevSemanticRoute,jevArgumentContextSignature} from '../js/analysis/query/jev-advisory.js';
import {RealGameJevClient} from './jev-realgame-final-client.mjs';
import {structuralMatch,funnel,persistentWrite,sha256} from './jev-realgame-final-contract.mjs';
import {summarize} from './evaluate-jev-realgame-final.mjs';

const [snapshotDir,outputDir]=process.argv.slice(2);
if(!snapshotDir||!outputDir||!process.env.OPENJEV_API_KEY)throw new Error('usage: SNAPSHOTS OUTPUT; API key required');
const root=new URL('../',import.meta.url);
const golds=JSON.parse(fs.readFileSync(new URL('reports/investigations/jev-realgame-final/default-v3/structural-cases.json',root)));
const byId=new Map(golds.map(gold=>[gold.id,gold]));
const snapshots=['openttd','openmw'].map(game=>JSON.parse(fs.readFileSync(path.join(snapshotDir,`${game}.json`))));
const receipt=JSON.parse(fs.readFileSync(path.join(snapshotDir,'collection-receipt.json')));
if(receipt.complete!==true||receipt.developmentOnly!==true||receipt.files?.length!==2)
  throw new Error('actual Actions artifact receipt required before remote inference');
for(const snapshot of snapshots) {
  const item=receipt.files.find(item=>item.file===`${snapshot.binaryKey}.json`);
  if(!item||item.productSha!==snapshot.productSha||!Number.isSafeInteger(item.run)||item.run<=0
    ||sha256(fs.readFileSync(path.join(snapshotDir,item.file)))!==item.sha256)
    throw new Error('development artifact byte/revision binding failure');
}
if(new Set(snapshots.map(snapshot=>snapshot.productSha)).size!==1)throw new Error('mixed collection source revisions');
for(const snapshot of snapshots) {
  if(!snapshot.complete||snapshot.developmentOnly!==true||snapshot.authorizesDefaultActivation!==false
    ||snapshot.schema!=='hex-jev-context-development/v4'||snapshot.rows.length!==3||snapshot.collection.keyCollisions!==0)
    throw new Error('complete six-case actual development collection required');
  const manifestBytes=fs.readFileSync(new URL(`reports/investigations/jev-realgame-final/development-v4/queries-${snapshot.binaryKey}.json`,root));
  const manifest=JSON.parse(manifestBytes);
  if(snapshot.queriesSha256!==sha256(manifestBytes)||snapshot.binarySha256!==manifest.binarySha256
    ||snapshot.rows.some((row,index)=>row.id!==manifest.cases[index].id||row.query!==manifest.cases[index].query))
    throw new Error('development query/binary/order binding failure');
  for(const [file,hash] of Object.entries(snapshot.sourceHashes)) {
    if(sha256(fs.readFileSync(new URL(file,root)))!==hash
      ||sha256(execFileSync('git',['show',`${snapshot.productSha}:${file}`],{maxBuffer:32*1024*1024}))!==hash)
      throw new Error(`development measured source drift: ${file}`);
  }
}
const rows=[];
for(const input of snapshots.flatMap(snapshot=>snapshot.rows)) {
  const gold=byId.get(input.id),candidates=input.candidates,byKey=new Map(candidates.map(candidate=>[candidate.key,candidate]));
  if(gold?.status!=='verified'||gold.query!==input.query||byKey.size!==candidates.length
    ||candidates.some(candidate=>candidate.source!=='cxx'||candidate.anonymous!==true
      ||candidate.fieldName!=null||candidate.binarySha256!==input.binarySha256))throw new Error('actual anonymous member/query boundary failed');
  const correct=key=>structuralMatch(byKey.get(key),gold);
  const scores=cxxObjectSemanticScores(input.query,candidates).sort(compareCxxSemanticScores);
  const objectTop=scores[0]?.score>0||scores[0]?.objectMatches>0?scores[0].key:input.topKey;
  const row={id:input.id,binary:input.binary,query:input.query,status:gold.status,gold,hexCorrect:correct(input.topKey),
    hexLatencyMs:input.hexLatencyMs,funnel:funnel(input,gold),arms:{}};
  for(const [arm,key] of [['A',input.topKey],['R1',input.stableTopKey],['O4',objectTop]])
    row.arms[arm]={key,correct:correct(key),repeatedKeys:[key],repeatedCorrect:[correct(key)],calls:[]};
  await Promise.all(['V4','S4'].map(async arm=>{
    const selective=arm==='S4',pool=selective?candidates.filter(candidate=>!candidate.conflict):candidates;
    const route=selective?jevSemanticRoute(input.query,pool,{topKey:input.topKey,verdict:input.verdict,policy:'object-context-v4'})
      :{call:true,reason:'unrestricted-development-comparison'};
    const client=new RealGameJevClient({apiKey:process.env.OPENJEV_API_KEY,arm,requestBuilder:jevArgumentFlowRequest,maxAttempts:1});
    const repeatedKeys=[],repeatedCorrect=[],calls=[];
    for(let repeat=0;repeat<3;repeat++) {
      const before=client.calls.length;
      const proxy={call:async request=>{
        const response=await client.call(request);if(!response)return null;
        const selected=request.candidates[response.choiceIndex];
        if(!selected||selected.conflict)return null;
        if(selective&&pool.some(peer=>peer.key!==selected.key
          &&jevArgumentContextSignature(peer)===jevArgumentContextSignature(selected)))return null;
        return response;
      }};
      // Both fallbacks retain original Hex; the comparator's preferences are
      // measured separately and cannot redefine the preservation denominator.
      const base={verdict:input.verdict,top:byKey.get(input.topKey)??null,candidates:pool};
      const result=await rerankWithJev(input.query,base,{enabled:route.call&&input.routed,mode:'partial',client:proxy,maxChoices:255});
      const key=result.top1?.key??input.topKey;
      repeatedKeys.push(key);repeatedCorrect.push(correct(key));
      if(client.calls.length!==before)calls.push({...client.calls.at(-1),repeat,committedKey:key});
    }
    row.arms[arm]={key:repeatedKeys[0],correct:repeatedCorrect[0],repeatedKeys,repeatedCorrect,calls,route,
      goldInShortlist:jevShortlist(pool,{max:255}).some(candidate=>structuralMatch(candidate,gold))};
  }));
  rows.push(row);persistentWrite(path.join(outputDir,'raw-results.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  console.log(JSON.stringify({id:row.id,recovered:row.funnel.recovered,top1:Object.fromEntries(Object.entries(row.arms).map(([arm,result])=>[arm,result.correct]))}));
}
const arms=['A','R1','O4','V4','S4'];
const summary={schema:'hex-jev-context-development-results/v4',complete:true,developmentOnly:true,authorizesDefaultActivation:false,
  collectionRevision:snapshots[0].productSha,queries:rows.length,repeats:3,
  sourceHashes:Object.fromEntries(['scripts/evaluate-jev-context-development.mjs','js/analysis/query/jev-advisory.js','js/analysis/query/cxx-semantic-preference.js']
    .map(file=>[file,sha256(fs.readFileSync(new URL(file,root)))])),
  summaries:Object.fromEntries(arms.map(arm=>[arm,summarize(rows,arm)])),
  perGame:Object.fromEntries(['openttd','openmw'].map(game=>[game,Object.fromEntries(arms.map(arm=>[arm,summarize(rows.filter(row=>row.binary===game),arm)]))]))};
persistentWrite(path.join(outputDir,'summary.json'),summary);
console.log(JSON.stringify({developmentOnly:true,top1:Object.fromEntries(arms.map(arm=>[arm,summary.summaries[arm].top1]))}));

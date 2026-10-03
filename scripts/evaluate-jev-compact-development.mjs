#!/usr/bin/env node
// Development only: new request representation over exact-SHA real release
// metadata. This measures remote retrieval, never member accuracy or a judge.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createJevRecoveryClient,selectJevRecoveryPlan} from '../js/analysis/query/jev-recovery.js';
import {persistentWrite,sha256,percentiles} from './jev-realgame-final-contract.mjs';

const [directory,output,idsArgument]=process.argv.slice(2);
if(!directory||!output||!idsArgument||!process.env.OPENJEV_API_KEY)throw new Error('metadata directory, persistent output, dev IDs and API credential required');
const root=new URL('../',import.meta.url);
const snapshots=['openttd','openmw'].map(game=>JSON.parse(fs.readFileSync(`${directory}/${game}.json`)));
const sourceDeltas=[];
for(const snapshot of snapshots){
 if(snapshot.complete!==true||snapshot.developmentOnly!==true||snapshot.authorizesDefaultActivation!==false
  ||snapshot.planningPolicy!=='semantic-retrieval-v5'||snapshot.productSha!==snapshots[0].productSha)
  throw new Error('not bound real-game development metadata');
 for(const [file,recorded]of Object.entries(snapshot.sourceHashes)){
  const current=sha256(fs.readFileSync(new URL(file,root)));
  if(current===recorded)continue;
  // These are the explicit prospective transport/routing edits. Recovery,
  // symbol proofs and choice planning must remain exact, not silently re-run.
  if(!['js/analysis/query/jev-recovery.js','js/analysis/query/app-adapter.js'].includes(file))
   throw new Error(`metadata source drift: ${file}`);
  sourceDeltas.push({file,metadataSha256:recorded,executionSha256:current});
 }
}
const inputs=new Map(snapshots.flatMap(s=>s.rows.map(row=>[row.id,{...row,binarySha256:s.binarySha256}])));
const ids=idsArgument.split(',');
if(new Set(ids).size!==ids.length||ids.some(id=>!inputs.has(id)))throw new Error('development inventory mismatch');
const records=[];
for(const id of ids){
 const input=inputs.get(id),choices=input.choices.map(row=>({...row,address:BigInt(row.address),
  declaredSizeBytes:row.declaredSizeBytes==null?null:BigInt(row.declaredSizeBytes)}));
 for(let repeat=0;repeat<2;repeat++){
  let call=null,request=null,actualChoices=null;
  const http=createJevRecoveryClient({apiKey:process.env.OPENJEV_API_KEY,fetchImpl:async(url,options)=>{
   if(sha256(options.body)!==sha256(JSON.stringify(request)))throw new Error('compact production request drift');
   const start=performance.now();let status=null;
   try{
    const response=await fetch(url,options);status=response.status;const body=await response.json();
    call={response:body,status,latencyMs:performance.now()-start,error:response.ok?null:`http-${status}`};
    return {ok:response.ok,json:async()=>body};
   }catch(error){call={response:null,status,latencyMs:performance.now()-start,
    error:error?.name==='AbortError'?'timeout':'network'};throw error;}
  }});
  const planner={choices:(_query,{maxChoices})=>choices.slice(0,maxChoices),plan:()=>[],
   planOwner:(_query,owner,{firstAddress})=>choices.filter(row=>row.className===owner&&row.address===firstAddress)};
  const selection=await selectJevRecoveryPlan(input.query,planner,{enabled:true,isCurrent:()=>true,maxFunctions:1,
   requestPolicy:'compact-accessor-v5',maxDeclaredSizeBytes:256,client:{call:async captured=>{
    request=captured.body;actualChoices=captured.choices;return http.call(captured);
   }}});
  records.push({id,repeat,query:input.query,binarySha256:input.binarySha256,source:selection.source,
   selectedClass:selection.selectedClass,selectedAddress:selection.selectedAddress,
   requestPolicy:'compact-accessor-v5',choices:actualChoices,body:request,
   bodySha256:request?sha256(JSON.stringify(request)):null,call});
  persistentWrite(`${output}.checkpoint`,{complete:false,developmentOnly:true,records});
  console.log(JSON.stringify({id,repeat,source:selection.source,selectedClass:selection.selectedClass,
   selectedAddress:selection.selectedAddress,error:call?.error??null},(_key,value)=>typeof value==='bigint'?String(value):value));
 }
}
persistentWrite(output,{schema:'hex-jev-compact-retrieval-development/v1',complete:true,developmentOnly:true,
 authorizesDefaultActivation:false,metadataProductSha:snapshots[0].productSha,
 executionSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 executionDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,
 sourceDeltas,sourceHashes:Object.fromEntries(['scripts/evaluate-jev-compact-development.mjs',
  'js/analysis/query/jev-recovery.js','js/analysis/query/app-adapter.js'].map(file=>[file,sha256(fs.readFileSync(new URL(file,root)))])),
 metadataSha256:Object.fromEntries(['openttd','openmw'].map(game=>[game,sha256(fs.readFileSync(`${directory}/${game}.json`))])),
 records,latency:percentiles(records.flatMap(record=>record.call?[record.call.latencyMs]:[])),
 scope:'Eight live calls over actual bound release function choices; consumed four dev queries; retrieval only, no member/gold scoring, no final judge'});

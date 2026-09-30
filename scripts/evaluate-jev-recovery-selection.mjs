#!/usr/bin/env node
// Development only: measure actual remote retrieval on release metadata.
// This is not a member accuracy test and cannot authorize default activation.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { selectJevRecoveryPlan, createJevRecoveryClient } from '../js/analysis/query/jev-recovery.js';
import { persistentWrite, sha256, percentiles } from './jev-realgame-final-contract.mjs';

const [metadataDir, outputFile, idsArgument = ''] = process.argv.slice(2);
if (!metadataDir || !outputFile || !process.env.OPENJEV_API_KEY || !idsArgument) throw new Error('usage: METADATA OUTPUT DEVELOPMENT_IDS; API key required');
const snapshots = ['openttd','openmw'].map(game => JSON.parse(fs.readFileSync(`${metadataDir}/${game}.json`)));
if (new Set(snapshots.map(s=>s.productSha)).size !== 1 || snapshots.some(s=>!s.complete)) throw new Error('metadata product binding');
const root = new URL('../', import.meta.url);
for (const snapshot of snapshots) for (const [file, hash] of Object.entries(snapshot.sourceHashes)) {
  // The HTTP transport addition does not alter retrieval projection/selection.
  // Any development delta must be disclosed in the output below, not silently
  // presented as an exact historical source replay.
  if (file !== 'js/analysis/query/jev-recovery.js' && sha256(fs.readFileSync(new URL(file, root))) !== hash)
    throw new Error(`metadata source drift: ${file}`);
}
const ids = idsArgument.split(','), inputs = new Map(snapshots.flatMap(s=>s.rows.map(row=>[row.id,{...row,binarySha256:s.binarySha256}])));
if (ids.some(id=>!inputs.has(id)) || new Set(ids).size !== ids.length) throw new Error('development inventory mismatch');
const records=[];
for (const id of ids) {
  const input=inputs.get(id), choices=input.choices.map(row=>({...row,address:BigInt(row.address)}));
  for (let repeat=0;repeat<2;repeat++) {
    let call=null;
    const client=createJevRecoveryClient({apiKey:process.env.OPENJEV_API_KEY,fetchImpl:async(url,options)=>{
      if(sha256(options.body)!==sha256(JSON.stringify(input.body)))throw new Error('production request projection drift');
      const start=performance.now();let response=null,error=null,status=null;
      try{response=await fetch(url,options);status=response.status;const body=await response.json();
        call={response:body,status,latencyMs:performance.now()-start,error:response.ok?null:`http-${status}`};
        return {ok:response.ok,json:async()=>body};
      }catch(e){error=e?.name==='AbortError'?'timeout':'network';call={response:null,status,latencyMs:performance.now()-start,error};throw e;}
    }});
    // Read-only replay of the actual, bound release-function shortlist. No
    // decompilation or field evidence is produced by this metadata experiment.
    const planner={choices:()=>choices,plan:()=>input.recovery.plan,
      planOwner:(_query,owner,{firstAddress})=>choices.filter(row=>row.className===owner&&row.address===firstAddress)};
    const selection=await selectJevRecoveryPlan(input.query,planner,{enabled:true,client,isCurrent:()=>true});
    records.push({id,repeat,query:input.query,binarySha256:input.binarySha256,source:selection.source,
      selectedClass:selection.selectedClass,selectedAddress:selection.selectedAddress,call,bodySha256:sha256(JSON.stringify(input.body))});
    persistentWrite(`${outputFile}.checkpoint`,{complete:false,developmentOnly:true,records});
    console.log(JSON.stringify({id,repeat,source:selection.source,selectedClass:selection.selectedClass,error:call?.error??null}));
  }
}
persistentWrite(outputFile,{schema:'hex-jev-recovery-selection-development/v3',complete:true,developmentOnly:true,
  authorizesDefaultActivation:false,metadataProductSha:snapshots[0].productSha,
  executionSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  metadataSha256:Object.fromEntries(['openttd','openmw'].map(game=>[game,sha256(fs.readFileSync(`${metadataDir}/${game}.json`))])),
  retrievalSourceSha256:sha256(fs.readFileSync(new URL('../js/analysis/query/jev-recovery.js',import.meta.url))),records,
  latency:percentiles(records.flatMap(record=>record.call?[record.call.latencyMs]:[]))});

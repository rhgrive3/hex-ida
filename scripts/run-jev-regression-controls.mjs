#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rerankWithJev } from '../js/pinpoint.js';
import { RealGameJevClient } from './jev-realgame-final-client.mjs';
import { recoveryRequestBody } from './jev-realgame-recovery-contract.mjs';
import { ARMS, persistentWrite, sha256, percentiles } from './jev-realgame-final-contract.mjs';

async function main() {
  const [inputFile,outputFile,armList]=process.argv.slice(2);
  const arms=armList?armList.split(','):ARMS;
  if(!arms.length||arms.some(a=>![...ARMS,'E'].includes(a)))throw new Error('invalid control arms');
  if (!inputFile || !outputFile || !process.env.OPENJEV_API_KEY) throw new Error('usage: CONTROLS_JSON OUTPUT_JSON; API key required');
  const controls = JSON.parse(fs.readFileSync(inputFile));
  const rows = [];
  for (const c of controls.controls) {
    if (sha256(fs.readFileSync(c.binary.path))!==c.binary.sha256
      || sha256(fs.readFileSync(c.retainedSnapshot.path))!==c.retainedSnapshot.sha256
      || sha256(fs.readFileSync(c.corpus.caseFile))!==c.corpus.caseSha256) throw new Error('control provenance mismatch');
    const candidates=c.shortlist.candidates.map(s=>({ key:s.key,className:s.className,fieldName:s.fieldName,
      offset:s.offset,size:s.type?.bytes ?? null,type:s.type,recoveredType:null,functionContexts:[],score:s.fusionLogOdds,
      fusion:{logOdds:s.fusionLogOdds},source:'objc',anonymous:false }));
    const base={ candidates,top:candidates[0],verdict:c.candidateLattice.verdict ?? 'ambiguous' };
    const row={id:c.caseId,query:c.query,target:c.target,baselineKey:base.top.key,baselineCorrect:
      base.top.className===c.target.className && base.top.fieldName===c.target.fieldName,arms:{}};
    for (const arm of arms) {
      const client=new RealGameJevClient({apiKey:process.env.OPENJEV_API_KEY,arm,requestBuilder:recoveryRequestBody});
      const calls=[];
      for(let repeat=0;repeat<5;repeat++) {
        const result=await rerankWithJev(c.query,base,{enabled:true,mode:'partial',client,maxChoices:255});
        const chosen=result.top1;
        calls.push({repeat,selectedKey:chosen?.key,correct:chosen?.className===c.target.className && chosen?.fieldName===c.target.fieldName,
          source:result.source,call:client.calls.at(-1)});
      }
      row.arms[arm]={correct:calls.filter(c=>c.correct).length,total:calls.length,
        unstable:new Set(calls.map(c=>c.selectedKey)).size>1,calls};
    }
    rows.push(row);persistentWrite(outputFile,{schema:'hex-jev-final-regression-results/v1',controlsSha256:sha256(fs.readFileSync(inputFile)),
      role:'diagnostic regression controls, no prompt tuning or majority replacement',repeats:5,rows,
      latency:percentiles(rows.flatMap(r=>arms.flatMap(a=>r.arms[a].calls.map(c=>c.call?.addedLatencyMs))))});
    console.log(`${c.caseId} controls evaluated`);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.stack);process.exitCode=1;});

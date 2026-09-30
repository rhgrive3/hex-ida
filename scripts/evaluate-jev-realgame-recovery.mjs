#!/usr/bin/env node
// Separated final holdout or explicitly labelled development re-evaluation.
import fs from 'node:fs';
import path from 'node:path';
import {rerankWithJev} from '../js/pinpoint.js';
import {RealGameJevClient} from './jev-realgame-final-client.mjs';
import {recoveryRequestBody,deterministicRecoveryPick} from './jev-realgame-recovery-contract.mjs';
import {structuralMatch,funnel,persistentWrite,sha256,percentiles} from './jev-realgame-final-contract.mjs';
import {summarize} from './evaluate-jev-realgame-final.mjs';

const [casesFile,snapshotsDir,outputDir,role,controlsFile]=process.argv.slice(2);
if(!casesFile||!snapshotsDir||!outputDir||!['untouched-final','development-original70'].includes(role)
  ||!process.env.OPENJEV_API_KEY)throw new Error('usage: CASES SNAPSHOTS OUTPUT untouched-final|development-original70; API key required');
const caseBytes=fs.readFileSync(casesFile),cases=JSON.parse(caseBytes);
const policyBytes=fs.readFileSync(new URL('../reports/investigations/jev-realgame-final/'+(role==='development-original70'?'recovery-policy-freeze-development.json':'recovery-policy-freeze.json'),import.meta.url));
const policy=JSON.parse(policyBytes);
const experiment=JSON.parse(fs.readFileSync(new URL('../reports/investigations/jev-realgame-final/recovery-experiment-freeze.json',import.meta.url)));
if(experiment.corpora[role].caseSha256!==sha256(caseBytes)||experiment.corpora[role].policySha256!==sha256(policyBytes))throw new Error('pre-run experiment freeze binding');
const snapshots=['openttd','openmw'].map(k=>JSON.parse(fs.readFileSync(path.join(snapshotsDir,`${k}.json`))));
const inputs=new Map(snapshots.flatMap(s=>s.rows.map(r=>[r.id,r])));
if(inputs.size!==cases.length||new Set(snapshots.map(s=>s.productSha)).size!==1)throw new Error('recovery snapshot case/product binding');
for(const s of snapshots) {
  if(!s.complete||s.policySha256!==sha256(policyBytes))throw new Error('policy binding');
  for(const [file,hash] of Object.entries(s.sourceHashes))if(sha256(fs.readFileSync(new URL(`../${file}`,import.meta.url)))!==hash)throw new Error('source hash binding');
}
const callArms=policy.arms.filter(a=>['current','B','E'].includes(a));
const clients=Object.fromEntries(callArms.map(arm=>[arm,new RealGameJevClient({apiKey:process.env.OPENJEV_API_KEY,arm,requestBuilder:recoveryRequestBody})]));
const rows=[];
for(const c of cases) {
  const input=inputs.get(c.id);if(!input||input.query!==c.query||input.binary!==c.binary)throw new Error('query binding');
  if(c.status==='verified'&&c.identities.some(g=>g.binarySha256!==input.binarySha256))throw new Error('gold binary binding');
  const hex=input.candidates.find(s=>s.key===input.topKey)??null;
  const base={top:hex,candidates:input.candidates,verdict:input.verdict};
  const f=funnel({...input,candidates:input.published},c),verified=c.status==='verified';
  const det=input.routed?deterministicRecoveryPick(c.query,input.candidates):hex;
  const row={id:c.id,binary:c.binary,query:c.query,status:c.status,gold:c,funnel:f,verdict:input.verdict,
    topKey:input.topKey,hexCorrect:verified?structuralMatch(hex,c):null,hexLatencyMs:input.hexLatencyMs,
    recoveryLatencyMs:input.recovery.elapsedMs,recovery:input.recovery,candidateCount:input.candidates.length,
    failureCauses:f.unreachableBecauseNotRecovered?['candidate recovery failure']:[],
    arms:{A:{key:hex?.key??null,correct:verified?structuralMatch(hex,c):null},
      DET:{key:det?.key??null,correct:verified?structuralMatch(det,c):null}}};
  await Promise.all(callArms.map(async arm=>{
    const keys=[],correct=[],calls=[];
    for(let repeat=0;repeat<policy.repeats;repeat++) {
      const client=clients[arm],before=client.calls.length;
      const result=await rerankWithJev(c.query,base,{enabled:true,mode:c.mode??'partial',client,maxChoices:255});
      keys.push(result.top1?.key??null);correct.push(verified?structuralMatch(result.top1,c):null);
      if(client.calls.length>before)calls.push({...client.calls.at(-1),repeat});
    }
    row.arms[arm]={key:keys[0],correct:correct[0],repeatedKeys:keys,repeatedCorrect:correct,calls};
  }));
  if(callArms.some(a=>new Set(row.arms[a].repeatedKeys).size>1))row.failureCauses.push('stochastic instability');
  if(f.shortlist&&!row.arms.E.correct)row.failureCauses.push('insufficient member semantics or reranking failure');
  rows.push(row);persistentWrite(path.join(outputDir,'raw-results.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  if(rows.length%10===0)console.log(`evaluated recovery ${role} ${rows.length}/${cases.length}`);
}
const arms=['A','DET',...callArms],summaries=Object.fromEntries(arms.map(a=>[a,summarize(rows,a)]));
const perGame=Object.fromEntries(['openttd','openmw'].map(k=>[k,Object.fromEntries(arms.map(a=>[a,summarize(rows.filter(r=>r.binary===k),a)]))]));
const primary=summaries.E;
const controls=controlsFile?JSON.parse(fs.readFileSync(controlsFile)):null;
const finalPolicy=role!=='untouched-final'?'DEVELOPMENT_ONLY':!controls?'NOT_DECIDED':
  ['openttd','openmw'].every(k=>perGame[k].E.net>0)&&primary.net>0&&primary.regression===0
  &&primary.unsafeConfident===0&&primary.apiErrorRate!=null&&primary.apiErrorRate<=.05
  &&controls.rows.every(r=>!r.baselineCorrect||r.arms.E.correct===r.arms.E.total)?'OPTIONAL_ADVISORY':'NO_GO';
persistentWrite(path.join(outputDir,'summary.json'),{schema:'hex-jev-recovery-results/v1',role,caseSha256:sha256(caseBytes),policySha256:sha256(policyBytes),
  productSha:snapshots[0].productSha,sourceHashes:snapshots[0].sourceHashes,
  snapshotHashes:Object.fromEntries(['openttd','openmw'].map(k=>[k,sha256(fs.readFileSync(path.join(snapshotsDir,`${k}.json`)))])),
  collection:Object.fromEntries(snapshots.map(s=>[s.binaryKey,s.collection])),summaries,perGame,
  coldRecoveryLatency:percentiles(rows.map(r=>r.recoveryLatencyMs)),finalPolicy,
  controlsSha256:controlsFile?sha256(fs.readFileSync(controlsFile)):null,
  reason:'Automatic promotion additionally requires all pre-frozen bars, independent routing evidence, controls and fail-closed verification; none is inferred from a development corpus.'});
console.log(JSON.stringify({role,finalPolicy,verified:primary.answerable,primary}));

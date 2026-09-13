#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {loadManifest,verifyInputs} from './manifest.mjs';import {compareCase,aggregateComparisons} from './compare.mjs';
const a=process.argv.slice(2),get=(k,d=null)=>{const i=a.indexOf(k);return i<0?d:a[i+1]};
const suite=get('--suite','codefuse-arm64'),manifestFile=path.resolve(get('--manifest',`benchmarks/public/${suite}/manifest.json`)),out=path.resolve(get('--output',`reports/public-benchmark/${suite}`)),timeout=Number(get('--timeout-ms','120000')),limit=Number(get('--limit','0'));
if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>900000)throw new Error('benchmark-timeout-invalid');if(!Number.isSafeInteger(limit)||limit<0)throw new Error('benchmark-limit-invalid');
const manifest=loadManifest(manifestFile),root=path.dirname(manifestFile),inputs=verifyInputs(manifest,root),selected=limit>0?inputs.slice(0,limit):inputs;fs.mkdirSync(out,{recursive:true});const states={},comparisons=[],results=[];
for(const c of selected){
  if(c.state!=='READY'){states[c.state]=(states[c.state]||0)+1;results.push({id:c.id,state:c.state});continue}
  const result=path.join(out,Buffer.from(c.id).toString('hex')+'.json'),r=spawnSync(process.execPath,['tools/validation/public-benchmark/run-case.mjs',c.path,result,String(timeout)],{encoding:'utf8',timeout:timeout+5000});
  let subject={state:'ERROR',reason:'result-missing',functions:[]};if(fs.existsSync(result))try{subject=JSON.parse(fs.readFileSync(result,'utf8'))}catch{subject={state:'ERROR',reason:'result-invalid-json',functions:[]}}
  if(r.error?.code==='ETIMEDOUT')subject={state:'TIMEOUT',reason:'outer-runner-timeout',functions:[]};
  states[subject.state]=(states[subject.state]||0)+1;results.push({id:c.id,state:subject.state,reason:subject.reason??null});comparisons.push(compareCase({caseEntry:c,hexResult:subject,suiteRoot:root}));console.log(`${c.id}: ${subject.state} (${subject.functions?.length??0} functions)`);
}
const summary={schema:'hex-public-benchmark-report/v1',suite:manifest.suite,total:selected.length,denominatorFrozen:manifest.denominatorFrozen===true,states,reference:manifest.reference,comparison:{scope:'published-artifact-quality-only',aggregate:aggregateComparisons(comparisons),cases:comparisons},claims:{nativeCompetitorRun:false,scpaNativeCellsConsumed:0,semantic:'UNMEASURED',recompilability:'UNMEASURED',competitorLatency:'UNMEASURED'},results};fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(`summary -> ${path.join(out,'summary.json')}`);
const hard=['MISSING','MISSING_REFERENCE','HASH_MISMATCH','REFERENCE_HASH_MISMATCH','ERROR','CRASH','TIMEOUT'];process.exit(results.some(x=>hard.includes(x.state))?1:0);

// Local subprocess/worker tests; no real model, binary tool, network or account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { protocolInput } from './benchmark-fixture.mjs';
import { executeAstraTrialFile } from '../../tools/competitive-arm64/trials.mjs';
const cli = fileURLToPath(new URL('../../tools/competitive-arm64/trials.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scpa-trial-cli-')); t.after(() => fs.rmSync(root, { recursive:true,force:true }));
  const protocols = Object.fromEntries(['T0','T1','T2','T3'].map(mode => { const raw=protocolInput();raw.track={T0:'scripted-substrate',T1:'native-best',T2:'knowledge-equalized',T3:'native-best'}[mode];return [mode,raw]; }));
  const input={protocols,config:{seed:71,cacheStates:['cold'],tasks:protocols.T0.cases.map(row=>({caseId:row.caseId,request:{kind:'demand',request:{query:{scope:{functionIds:['0x1000']},resultLimit:4}}}})),resources:{deadlineMs:100,cleanupMs:25}}};
  const file=path.join(root,'input.json');fs.writeFileSync(file,JSON.stringify(input));
  const host=code=>{const target=path.join(root,'host.mjs');fs.writeFileSync(target,code);return target;};
  return {root,file,input,host};
}
test('CLI defaults to a full-denominator plan without loading any host', async t => {
  const f=fixture(t),r=await executeAstraTrialFile(f.file);assert.equal(r.status,'planned-only');assert.equal(r.modelsCalled,false);assert.equal(r.plan.denominator,24);assert.equal(r.releaseQualified,false);
});
test('explicit local host may report unavailable, never measurement or rollout admission', {timeout:10000}, async t => {
  const f=fixture(t),r=await executeAstraTrialFile(f.file,{hostPath:f.host('export function createTrialHost(){return {getAdapter:()=>null}}'),timeoutMs:5000});
  assert.equal(r.status,'executed-not-admitted');assert.equal(r.result.denominator,24);assert.equal(r.result.measurements.length,0);assert.ok(r.result.trials.every(row=>row.state==='UNAVAILABLE'));
  assert.equal(r.review.releaseQualified,false);assert.equal(r.defaultRolloutEligible,false);assert.equal(r.victoryEstablished,false);
});
test('synchronous infinite host execution is terminated by parent deadline', {timeout:10000}, async t => {
  const f=fixture(t),start=Date.now(),r=await executeAstraTrialFile(f.file,{hostPath:f.host('export function createTrialHost(){while(true){}}'),timeoutMs:250});
  assert.equal(r.status,'failed');assert.equal(r.reason,'trial-worker-timeout');assert.equal(r.retainedUnmeasuredCells,24);assert.ok(Date.now()-start<6000);
});
test('missing factory is a bounded failure with no disappearing cells', {timeout:10000}, async t => {
  const f=fixture(t),r=await executeAstraTrialFile(f.file,{hostPath:f.host('export const fixtureOnly=true;'),timeoutMs:5000});assert.equal(r.status,'failed');assert.equal(r.reason,'trial-host-factory-required');assert.equal(r.retainedUnmeasuredCells,24);
});
test('local host log flood is bounded and not included in reports', {timeout:10000}, async t => {
  const f=fixture(t),r=await executeAstraTrialFile(f.file,{hostPath:f.host('export async function createTrialHost(){console.log("DO_NOT_PUBLISH".repeat(4000));await new Promise(()=>{});}'),timeoutMs:5000});
  assert.equal(r.status,'failed');assert.equal(r.reason,'trial-host-log-budget');assert.ok(!JSON.stringify(r).includes('DO_NOT_PUBLISH'));
});
test('local host cannot transport a release-qualified result', {timeout:10000}, async t => {
  const f=fixture(t),r=await executeAstraTrialFile(f.file,{hostPath:f.host('import {parentPort} from "node:worker_threads"; export async function createTrialHost({plan}) {parentPort.postMessage({planId:plan.id,status:"executed-not-admitted",releaseQualified:true}); await new Promise(()=>{});}'),timeoutMs:5000});
  assert.equal(r.status,'failed');assert.equal(r.reason,'trial-worker-result-contract');assert.equal(r.releaseQualified,false);
});
test('CLI rejects invalid resource/input bounds and nonmodule hosts', async t => {
  const f=fixture(t);for(const options of [{timeoutMs:Infinity},{timeoutMs:99},{maximumTrials:257},{maximumTrials:1.1}])await assert.rejects(executeAstraTrialFile(f.file,options));
  fs.writeFileSync(path.join(f.root,'oversize.json'),' '.repeat(1048577));await assert.rejects(executeAstraTrialFile(path.join(f.root,'oversize.json')),/bound/);
  await assert.rejects(executeAstraTrialFile(f.file,{hostPath:f.file}),/extension/);
  fs.writeFileSync(f.file,JSON.stringify({...f.input,unexpected:true}));await assert.rejects(executeAstraTrialFile(f.file),/fields/);
});
test('CLI process writes a private report without overwriting existing files', {timeout:10000}, t => {
  const f=fixture(t),out=path.join(f.root,'report.json'),options={timeout:5000,encoding:'utf8',maxBuffer:262144};
  const first=spawnSync(process.execPath,[cli,'--plan',f.file,'--out',out],options);assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(fs.readFileSync(out)).status,'planned-only');assert.equal(fs.statSync(out).mode&0o777,0o600);
  const before=fs.readFileSync(out);const second=spawnSync(process.execPath,[cli,'--plan',f.file,'--out',out],options);assert.equal(second.status,1);assert.deepEqual(fs.readFileSync(out),before);
  const inputBefore=fs.readFileSync(f.file);const overwrite=spawnSync(process.execPath,[cli,'--plan',f.file,'--out',f.file],options);assert.equal(overwrite.status,1);assert.deepEqual(fs.readFileSync(f.file),inputBefore);
});
test('CLI process requires explicit host opt-in and finite flags', {timeout:10000}, t => {
  const f=fixture(t),options={timeout:5000,encoding:'utf8',maxBuffer:262144};
  for (const argv of [['--run',f.file],['--plan',f.file,'--host',f.file],['--plan',f.file,'--bogus','1'],['--plan',f.file,'--timeout-ms','Infinity'],['--plan',f.file,'--maximum-trials','1','--maximum-trials','2']]) {
    const r=spawnSync(process.execPath,[cli,...argv],options);assert.equal(r.status,1,r.stdout);assert.match(r.stderr,/failed/);
  }
});

function resumableHost(f) {
  const trace=path.join(f.root,'calls.jsonl');
  const hostPath=f.host(`import fs from 'node:fs';
    export function createTrialHost({protocols}) { return {getAdapter(binding,{trial,limits}) {
      fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({id:trial.id,ordinal:trial.ordinal})+'\\n');
      let current=true;return {binding,isCurrent:()=>current,
        prepare:()=>({schema:'same-astra-trial-preparation/v1',binding,cacheState:trial.cacheState,
          cachePolicySha256:protocols[trial.mode].warmStatePolicySha256,cacheGeneration:'generation-'+trial.ordinal,
          namespaceId:'namespace-'+trial.ordinal,evidenceId:'TEST-only-'+trial.ordinal,limits,
          boundedExecution:true,cancellationSupported:true,modelCallsDisabled:trial.mode==='T0',
          knowledge:{manifestSha256:'a'.repeat(64),availability:'AVAILABLE',licenseEvidenceId:'TEST-license',
            networkPolicy:'deny',costPolicySha256:'b'.repeat(64),runtimeObservationBudget:0}}),
        adapter:{capabilities:()=>({fixtureOnly:true}),query:()=>({mode:trial.mode==='T0'?'T0-model-free':trial.mode}),
          explain:()=>({}),cancel:()=>{}},close:()=>{current=false}};
    }}}`);
  return {hostPath,trace};
}
test('CLI persists and resumes in separate workers without rerunning any consumed cell', {timeout:15000}, async t=>{
  const f=fixture(t),h=resumableHost(f),resumePath=path.join(f.root,'first.json');
  const first=await executeAstraTrialFile(f.file,{...h,maximumTrials:7,timeoutMs:5000});
  assert.equal(first.status,'executed-not-admitted');assert.equal(first.result.progress.nextOrdinal,7);
  fs.writeFileSync(resumePath,JSON.stringify(first));
  const last=await executeAstraTrialFile(f.file,{...h,resumePath,maximumTrials:17,timeoutMs:5000});
  assert.equal(last.status,'executed-not-admitted');assert.equal(last.result.progress.nextOrdinal,24);
  assert.equal(last.result.progress.attemptedTotal,24);assert.equal(last.result.attempted,17);
  const calls=fs.readFileSync(h.trace,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(r=>r.ordinal),Array.from({length:24},(_,i)=>i));assert.equal(new Set(calls.map(r=>r.id)).size,24);
  assert.equal(last.result.progress.historyProvenance,'imported-unadmitted');assert.equal(last.releaseQualified,false);
});
for(const changed of ['host','input','checkpoint','failed-report'])test(`resume rejects changed ${changed} before the host module runs`,{timeout:10000},async t=>{
  const f=fixture(t),h=resumableHost(f),resumePath=path.join(f.root,'first.json');
  const first=await executeAstraTrialFile(f.file,{...h,maximumTrials:1,timeoutMs:5000});assert.equal(first.status,'executed-not-admitted');
  const trace=fs.readFileSync(h.trace);
  if(changed==='host')fs.appendFileSync(h.hostPath,'\n// changed source');
  if(changed==='input')fs.appendFileSync(f.file,'\n');
  if(changed==='checkpoint'){first.result=JSON.parse(JSON.stringify(first.result));first.result.trials[0].responseDigest='changed';}
  if(changed==='failed-report')first.status='failed';
  fs.writeFileSync(resumePath,JSON.stringify(first));
  await assert.rejects(executeAstraTrialFile(f.file,{...h,resumePath,timeoutMs:5000}));
  assert.deepEqual(fs.readFileSync(h.trace),trace);
});
test('CLI resume is explicit and refuses checkpoint overwrite', {timeout:15000},async t=>{
  const f=fixture(t),h=resumableHost(f),resumePath=path.join(f.root,'first.json'),out=path.join(f.root,'last.json');
  const first=await executeAstraTrialFile(f.file,{...h,maximumTrials:1,timeoutMs:5000});fs.writeFileSync(resumePath,JSON.stringify(first));
  await assert.rejects(executeAstraTrialFile(f.file,{resumePath}),/explicit-host/);
  const options={timeout:5000,encoding:'utf8',maxBuffer:262144};
  const bad=spawnSync(process.execPath,[cli,'--plan',f.file,'--resume',resumePath],options);assert.equal(bad.status,1);
  const before=fs.readFileSync(resumePath);
  const result=spawnSync(process.execPath,[cli,'--run',f.file,'--host',h.hostPath,'--resume',resumePath,'--maximum-trials','2','--out',out],options);
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(fs.readFileSync(out)).result.progress.nextOrdinal,3);
  const traceBefore=fs.readFileSync(h.trace);
  const overwrite=spawnSync(process.execPath,[cli,'--run',f.file,'--host',h.hostPath,'--resume',resumePath,'--out',resumePath],options);
  assert.equal(overwrite.status,1);assert.deepEqual(fs.readFileSync(resumePath),before);assert.deepEqual(fs.readFileSync(h.trace),traceBefore);
});
test('parent rejects a fabricated partial result even when release flags are false', {timeout:10000}, async t=>{
  const f=fixture(t),hostPath=f.host(`import {parentPort} from 'node:worker_threads';
    export async function createTrialHost({plan}) {parentPort.postMessage({planId:plan.id,status:'executed-not-admitted',
      result:{planId:plan.id,denominator:0,trials:[],releaseQualified:false},releaseQualified:false});await new Promise(()=>{});}`);
  const result=await executeAstraTrialFile(f.file,{hostPath,timeoutMs:5000});
  assert.equal(result.status,'failed');assert.equal(result.reason,'trial-worker-result-contract');assert.equal(result.retainedUnmeasuredCells,24);
});

test('non-regular input, host and resume paths fail promptly instead of blocking on open', {timeout:12000,skip:process.platform==='win32'},t=>{
  const f=fixture(t),fifo=path.join(f.root,'input.fifo'),h=resumableHost(f);
  const created=spawnSync('mkfifo',[fifo],{timeout:2000,encoding:'utf8'});assert.equal(created.status,0,created.stderr);
  const runs=[['--plan',fifo],['--run',f.file,'--host',fifo],['--run',f.file,'--host',h.hostPath,'--resume',fifo]];
  for(const args of runs){
    const result=spawnSync(process.execPath,[cli,...args],{timeout:2000,encoding:'utf8',maxBuffer:262144});
    assert.equal(result.error,undefined,`blocked while opening ${args.join(' ')}`);
    assert.equal(result.status,1);assert.match(result.stderr,/trial-input-file-bound/);
  }
  assert.equal(fs.existsSync(h.trace),false);
});

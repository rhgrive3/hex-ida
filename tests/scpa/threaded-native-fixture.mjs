// Local source-backed acceptance harness. Actual ELF parser, deployed Capstone
// WASM, actual thread, canonical owners, public QueryAPI, real ArtifactStore.
// Only the host/transport is adapted for Node; this is NOT browser/iPad evidence.
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCapstoneArm64Session } from '../machine-effects/helpers/arm64-capstone-session.mjs';
import { SymbolIndex } from '../../js/symbols.js';
import { ArtifactStore } from '../../js/core/artifacts/store.js';
import { MemoryArtifactBackend } from '../../js/core/artifacts/backends.js';
import { ArtifactAnalysisOrchestrator } from '../../js/cache/artifact-orchestration.js';
import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../js/analysis/query/index.js';
import { configureScopedAnalysisHost, disableScopedAnalysisHost } from '../../js/analysis/query/scoped-host.js';
export async function threadedNativeFixture(t, { fixture = 'threaded-integer' } = {}) {
  assert.ok(['threaded-integer', 'threaded-call-memory', 'dispatch-table'].includes(fixture), 'owned fixture required');
  const worker=new Worker(new URL('./platform-thread.mjs',import.meta.url),{resourceLimits:{maxOldGenerationSizeMb:256}});
  const pending=new Map();let serial=0,readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const fail=error=>{readyReject(error);for(const {reject} of pending.values())reject(error);pending.clear();};
  worker.on('error',fail);worker.on('exit',()=>fail(new Error('platform-test-thread-exited')));
  worker.on('message',message=>{
    if(message.t==='test-ready')return readyResolve();
    const entry=pending.get(message.id);if(!entry)return;
    if(message.t==='err')entry.reject(new Error(message.error));else if(message.t==='ok')entry.resolve(message.result);
  });
  t.after(async()=>{for(const {reject} of pending.values())reject(new Error('platform-test-closed'));pending.clear();
    let timer;try{await Promise.race([worker.terminate(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('platform-test-close-timeout')),2000);})]);}finally{clearTimeout(timer);}});
  let readyTimer;try{await Promise.race([ready,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(new Error('platform-test-ready-timeout')),10000);})]);}finally{clearTimeout(readyTimer);}
  const counters={requests:0,decodes:0,semantic:0};
  const call=(method,payload={})=>{
    const id=++serial;let timer;
    const promise=new Promise((resolve,reject)=>{
      timer=setTimeout(()=>{pending.delete(id);worker.postMessage({t:'cancel',requestId:id,epoch:1});reject(new Error('platform-test-request-timeout'));},10000);
      pending.set(id,{resolve,reject});counters.requests++;if(method==='semanticFunction')counters.semantic++;
      worker.postMessage({t:method,id,epoch:1,...payload});
    }).finally(()=>{clearTimeout(timer);pending.delete(id);});
    promise.cancel=()=>worker.postMessage({t:'cancel',requestId:id,epoch:1});return promise;
  };
  const manifest = JSON.parse(fs.readFileSync(new URL(`./fixtures/${fixture}.json`, import.meta.url)));
  assert.equal(manifest.source, `${fixture}.s`);assert.equal(manifest.binary, `${fixture}.elf`);
  const source = fs.readFileSync(new URL(`./fixtures/${fixture}.s`, import.meta.url));
  const bytes = fs.readFileSync(new URL(`./fixtures/${fixture}.elf`, import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), manifest.sourceSha256, 'owned assembly source drift');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.binarySha256, 'owned ELF fixture drift');
  const file = new Blob([bytes]);
  const info=await call('open',{file}),regions=info.slices[0].regions,analysis=await call('analyze',{sliceIndex:0});
  const symbols=new SymbolIndex({...analysis,regions}),capstone=await createCapstoneArm64Session();t.after(()=>capstone.close());
  const store=new ArtifactStore({backend:new MemoryArtifactBackend()}),runtime=new ArtifactAnalysisOrchestrator({store});t.after(()=>runtime.close());
  const capability=info.slices[0].capability??info.capability;
  const backend={file,gen:1,transportEpoch:1,formatId:info.formatId,platformInfo:info,
    binaryId:'bin_sha256_'+createHash('sha256').update(bytes).digest('hex'),_artifactRuntime:()=>runtime,
    readAt:(addr,len,text)=>call('readAt',{addr,len,text}),_callTo:(_route,method,data)=>call(method,data),
    fetchChunk:async(regionId,chunk)=>{
      const result=await call('chunk',{regionId,chunk}),region=regions.find(r=>r.id===regionId);
      const instructions=capstone.decode(result.bytes,BigInt(region.vmAddr)+BigInt(chunk*4096));counters.decodes++;
      return {...result,mn:instructions.map(i=>i.mnemonic),ops:instructions.map(i=>i.opStr)};
    }};
  const values={file,fileInfo:info,sliceIndex:0,regions,capability,architecture:capability.architecture,canDisassemble:true,instructionAlignment:4};
  const app={backend,symbols,store:{get:key=>values[key]},projectRevision:0};
  configureScopedAnalysisHost(app,{enabled:true});t.after(()=>disableScopedAnalysisHost(app));
  const api=new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  const snapshot=await api.scopedSnapshot();
  return {app,backend,info,symbols,counters,api,snapshot,manifest,capstoneVersion:capstone.version,workerThreadId:worker.threadId,
    invoke:async(method,request={},options={})=>(await api[method](snapshot,request,{limits:{deadlineMs:10000,calls:256},...options})).value};
}

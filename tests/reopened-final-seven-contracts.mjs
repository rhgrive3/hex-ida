import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvestigationService, __investigationInternalsForTests as inv } from '../js/analysis/investigation-service.js';
import { __demandDrivenInternalsForTests as demand } from '../js/analysis/demand-driven-runtime.js';
import { installSharedWorkerBinaryIdentity } from '../js/analysis/shared-binary-identity.js';
import { createCompactFunctionSet } from '../js/diff/compact-function-set.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=(name)=>fs.readFileSync(path.join(root,name),'utf8');
const tick=()=>new Promise((resolve)=>queueMicrotask(resolve));
function abortError(){const e=new Error('aborted');e.name='AbortError';return e;}

// #2504: ordinary open must not even invoke recognition; explicit consumers still can.
{
  const app=source('js/app.js');
  const apply=app.slice(app.indexOf('  applySlice(sliceIndex, infoArg)'),app.indexOf('  /**\n   * Objective-C',app.indexOf('  applySlice(sliceIndex, infoArg)')));
  assert.doesNotMatch(apply,/ensureRecognition\s*\(/,'ordinary applySlice must not trigger whole-binary recognition');
  assert.match(app,/async ensureRecognition\(options=\{\}\)/,'recognition producer remains available on demand');
}

// #2502: local first-page planning stays O(local regions), while incoming absence remains partial.
{
  const regions=Array.from({length:256},(_,i)=>({id:`r${i}`,exec:true,vmAddr:BigInt(i)*0x1000n,size:0x1000n}));
  const store=new Map([['regions',regions],['currentRegion',regions[1]]]);
  const app={store:{get:(k)=>store.get(k)},programRegions:()=>regions,executableRegionFor:(a)=>regions.find((r)=>a>=r.vmAddr&&a<r.vmAddr+r.size)};
  const callee=demand.localRegionPlan(app,regions[200].vmAddr+8n,'callees');
  const incoming=demand.localRegionPlan(app,regions[200].vmAddr+8n,'callers');
  assert.equal(callee.local.length,1);
  assert.equal(incoming.local.length,2);
  assert.equal(incoming.unscanned.length,254);
  const runtime=source('js/analysis/demand-driven-runtime.js');
  assert.match(runtime,/scannedRegionIds, unscannedRegionIds/);
  assert.match(runtime,/scope:'active-neighborhood', scannedRegionIds, unscannedRegionIds/);
  assert.match(runtime,/const profile = `\$\{limits\.callLimit\}:\$\{limits\.refLimit\}:\$\{limits\.kindLimit\}`/,'cache key must preserve scan budget profile');
}

// #2522: independent Strings/Shapes start beside metadata, Program starts only after metadata.
{
  const region={id:'text',exec:true,vmAddr:0n,size:16n};
  const app={backend:{gen:1},symbols:{gen:1},fields:{},program:null,shapes:null,store:{get:(k)=>k==='sliceIndex'?0:k==='regions'?[region]:k==='currentRegion'?region:null},codeRegion:()=>region,programRegions:()=>[region],analysisQueries:{snapshot:async()=>({snapshotId:'snap-1'})}};
  const service=new InvestigationService(app);
  const started=[]; let resolveStrings,resolveShapes,resolveMetadata,resolveProgram;
  service.collectStrings=()=>{started.push('strings');return new Promise(r=>resolveStrings=r);};
  service.collectShapes=()=>{started.push('shapes');return new Promise(r=>resolveShapes=r);};
  service.ensureMetadata=()=>{started.push('metadata');return new Promise(r=>resolveMetadata=r);};
  service.buildProgram=()=>{started.push('program');return new Promise(r=>resolveProgram=r);};
  const pending=service.prepareGoal({id:'hp',expects:{numeric:true,store:true}});
  await tick();
  assert.deepEqual(started,['strings','shapes','metadata']);
  resolveStrings(Object.assign([], {complete:true})); const shapeValue=Object.assign(new Map(),{complete:true}); app.shapes=shapeValue; resolveShapes(shapeValue);
  await tick(); assert.equal(started.includes('program'),false);
  const fields={}; app.fields=fields; resolveMetadata({fields}); await tick();
  assert.equal(started.at(-1),'program');
  const program={graphCompleteness:{complete:true,supported:true},statsComplete:true}; app.program=program; resolveProgram(program);
  const context=await pending;
  assert.equal(context.snapshotId,'snap-1');
}

// #2507: metadata is a ref-counted shared producer; one consumer leaving does not kill it,
// last consumer leaving aborts the producer signal passed into ObjC/Swift.
{
  const region={id:'text',exec:true,vmAddr:0n,size:16n};
  let producerSignal=null;
  const wait=(options)=>new Promise((resolve,reject)=>{producerSignal=options.signal;options.signal.addEventListener('abort',()=>reject(abortError()),{once:true});});
  const app={backend:{gen:1},symbols:{gen:1},fields:{},store:{get:(k)=>k==='sliceIndex'?0:k==='regions'?[region]:k==='currentRegion'?region:null},programRegions:()=>[region],codeRegion:()=>region,ensureObjc:(_slice,options)=>wait(options),ensureSwift:(options)=>wait(options)};
  const service=new InvestigationService(app); const a=new AbortController(),b=new AbortController();
  const p1=service.ensureMetadata({signal:a.signal}); const p2=service.ensureMetadata({signal:b.signal}); await tick();await tick();
  assert.ok(producerSignal && !producerSignal.aborted);
  a.abort('first-left'); await assert.rejects(p1,(e)=>e?.name==='AbortError'); assert.equal(producerSignal.aborted,false);
  b.abort('last-left'); await assert.rejects(p2,(e)=>e?.name==='AbortError'); await tick(); assert.equal(producerSignal.aborted,true);
}

// #2515: captured artifact generations are checked before publication; typed candidates retain snapshot identity.
{
  const region={id:'text',exec:true,vmAddr:0n,size:16n}; const symbols={gen:4}; const fields={}; const program={}; const shapes=new Map();
  const app={backend:{gen:9},symbols,fields,program,shapes,store:{get:(k)=>k==='sliceIndex'?2:k==='regions'?[region]:k==='currentRegion'?region:null},codeRegion:()=>region,programRegions:()=>[region]};
  const binding=inv.captureAnalysisBinding(app,{program,shapes,fields}); assert.equal(inv.analysisBindingCurrent(app,binding),true);
  symbols.gen++; assert.equal(inv.analysisBindingCurrent(app,binding),false,'in-place symbol enrichment must stale the run'); symbols.gen--;
  const context={snapshotId:'snap',completeness:{complete:false,reasons:['program-partial']}};
  const typed=inv.typedRankedCandidates({candidates:[{addr:0x1234n,score:77,reasons:[{code:'string-match',evidenceId:'ev-1'}]}]},context);
  assert.equal(typed.candidates[0].candidateId,'snap:candidate:1234');
  assert.equal(typed.candidates[0].entityId,'function:1234');
  assert.deepEqual(typed.candidates[0].evidenceIds,['ev-1']);
  assert.equal(typed.candidates[0].completeness,'partial');
  const service=source('js/analysis/investigation-service.js');
  assert.match(service,/assertAnalysisBinding\(this\.app, context\.binding\)/);
  const panels=source('js/panels.js'); assert.match(panels,/showCandidates, showOverview.*ui\/panels\/investigation\.js/s);
}

// #2518: verified BinaryId is worker-backed/background and shared; scheduling precedes full-content work for all large-size classes.
{
  const prior=globalThis.scheduler; let release=null;
  globalThis.scheduler={postTask(fn,options){assert.equal(options.priority,'background');return new Promise((resolve)=>{release=()=>Promise.resolve(fn()).then(resolve);});}};
  try{
    for(const size of [100,500,1024].map((m)=>m*1024*1024)){
      let hashes=0; const backend={file:{size},gen:1,binaryId:null,async ensureContentHash(){hashes++;return '00'.repeat(32);}}; const app={backend}; installSharedWorkerBinaryIdentity(app);
      const p=backend.ensureBinaryId(); await tick(); assert.equal(hashes,0,`hash must not start before background slot (${size})`); await release(); await p; assert.equal(hashes,1);
    }
  }finally{if(prior===undefined)delete globalThis.scheduler;else globalThis.scheduler=prior;}
  const backendSource=source('js/backend.js');
  assert.match(source('js/analysis/shared-binary-identity.js'),/ensureContentHash\(options\.onProgress, controller\.signal\)/);
  assert.doesNotMatch(source('js/analysis/shared-binary-identity.js'),/sha256BlobHex/);
  assert.ok(backendSource.includes('ensureContentHash'));
}

// #2540: route cancellation owns baseline task; App bridge carries options; compact set is O(1) wrt per-function objects on main realm.
{
  const product=source('js/ui/product.js'); const workspace=source('js/workspace.js'); const app=source('js/app.js');
  assert.match(product,/createChildTaskScope\(routeSignal\)/); assert.match(product,/compareScope\.spawn\('diff-baseline-replaced'\)/); assert.match(product,/compareScope\.abort\('diff-route-disposed'\)/);
  assert.match(workspace,/signal\?\.addEventListener\('abort',onAbort/); assert.match(workspace,/if\(ownedBackend\)other\?\.dispose\?\.\(\)/);
  assert.match(app,/async loadDiffBaseline\(file, options=\{\}\)\{return this\.workspace\.loadBaseline\(file, options\);\}/);
  const funcs=Array.from({length:350000},(_,i)=>BigInt(i*4)); const symbols={funcs,addrs:funcs,names:[],functionStartsComplete:true};
  const set=createCompactFunctionSet(symbols,'arm64',350000); assert.equal(set.functionAddresses,funcs); assert.equal(set.count,350000); assert.equal(Object.prototype.hasOwnProperty.call(set,'functions'),false,'main realm must not allocate 350k function objects');
}

console.log('reopened final seven contracts: PASS');

import assert from 'node:assert/strict';

const workers=[];
class ControlledWorker {
  constructor(url){this.url=String(url);this.sent=[];this.onmessage=null;this.onerror=null;this.terminated=false;workers.push(this);}
  postMessage(message){this.sent.push(message);}
  terminate(){this.terminated=true;}
  reply(request,result,{ok=true,error=null}={}){assert.ok(request,'reply requires an observed request');this.onmessage?.({data:ok?{t:'ok',id:request.id,epoch:request.epoch,result}:{t:'err',id:request.id,epoch:request.epoch,error:error||'failed'}});}
}
globalThis.Worker=ControlledWorker;

const { Backend, BACKEND_DEFAULT_ANALYSIS_ROUTE }=await import('../../../js/backend.js');
assert.equal(BACKEND_DEFAULT_ANALYSIS_ROUTE,'artifact');
const backend=new Backend();
const getLegacy=()=>workers.find((w)=>/worker\.js/.test(w.url)&&!/platform/.test(w.url));
const getPlatform=()=>workers.find((w)=>/platform\/worker\.js/.test(w.url));
const tick=()=>new Promise((resolve)=>setTimeout(resolve,0));
const find=(worker,predicate)=>worker?.sent?.find((m)=>predicate(m));

const fileA={name:'A.bin',size:4096};
const fileB={name:'B.bin',size:4096};
let staleA=null;
const openA=backend.open(fileA);
const openAObserved=openA.catch((error)=>{staleA=error;return null;});
await tick();
const platformA=getPlatform();
assert.ok(platformA);
// #2516: the source-backed platform open is now also the format detector.  A
// normal open transaction must not parse the same source once for `detect` and
// again for `open`.
assert.equal(platformA.sent.some((m)=>m.t==='detect'&&m.file===fileA),false);
const platformOpenA=find(platformA,(m)=>m.t==='open'&&m.file===fileA);
platformA.reply(platformOpenA,{formatId:'macho',detection:{formatId:'macho'},capability:{architecture:'arm64'},slices:[],raw:{id:'platform-raw-a'}});
await tick();
const legacyA=getLegacy();
assert.ok(legacyA);
const legacyOpenA=find(legacyA,(m)=>m.t==='open'&&m.file===fileA);
assert.ok(legacyOpenA);
assert.equal(platformA.sent.filter((m)=>m.t==='open'&&m.file===fileA).length,1);

const openB=backend.open(fileB);
await tick();
const platformB=getPlatform();
assert.equal(platformB.sent.some((m)=>m.t==='detect'&&m.file===fileB),false);
const platformOpenB=find(platformB,(m)=>m.t==='open'&&m.file===fileB);
platformB.reply(platformOpenB,{formatId:'pe',detection:{formatId:'pe'},capability:{architecture:'x86_64'},slices:[],raw:{id:'raw-b'}});
await openB;

// Completing A after B has replaced the transport epoch must never publish A.
legacyA.reply(legacyOpenA,{format:'Mach-O 64-bit',slices:[],raw:{id:'legacy-raw-a'}});
await openAObserved;
assert.equal(staleA?.stale,true);
assert.equal(platformB.sent.filter((m)=>m.t==='open'&&m.file===fileA).length,1);
assert.equal(backend.file,fileB);

// This half explicitly verifies the retained current compatibility oracle.
// Production default remains artifact; there is no automatic fallback.
{
  const analysisBackend=new Backend();
  let releaseRead=null;
  const fakeFile={size:8,slice(){return {arrayBuffer(){return new Promise((resolve)=>{releaseRead=()=>resolve(new ArrayBuffer(8));});}};}};
  analysisBackend.formatId='macho';
  analysisBackend.file=fakeFile;
  analysisBackend.platformInfo={normalizedDyldTruth:false};
  analysisBackend.legacyInfo={platform:{}};
  let staleAnalysis=null;
  const analysis=analysisBackend.analyze(0,{route:'current'});
  const observed=analysis.catch((error)=>{staleAnalysis=error;return null;});
  await tick();
  const legacyAnalysisWorker=analysisBackend.legacyWorker;
  assert.ok(legacyAnalysisWorker);
  const request=find(legacyAnalysisWorker,(m)=>m.t==='analyze'&&m.sliceIndex===0);
  assert.ok(request);
  legacyAnalysisWorker.reply(request,{addrs:new BigUint64Array(0),kinds:new Uint8Array(0),flags:new Uint8Array(0),names:[],funcs:new BigUint64Array(0)});
  for(let i=0;i<10&&!releaseRead;i++)await tick();
  assert.ok(releaseRead);
  analysisBackend.advanceEpoch(); releaseRead(); await observed;
  assert.equal(staleAnalysis?.stale,true);
}

console.log('phase4 backend open-race/current compatibility oracle: PASS');

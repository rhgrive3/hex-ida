import assert from 'node:assert/strict';
import { recoverSchemas } from '../js/schema.js';
import { InvestigationService } from '../js/analysis/investigation-service.js';
import { recoverSchemasForUi, clearSchemaRecoveryTasks } from '../js/analysis/schema-recovery-task.js';
import { __demandDrivenInternalsForTests } from '../js/analysis/demand-driven-runtime.js';

function schemaFixture() {
  const strings=[{addr:1n,text:'a.csv'},{addr:2n,text:'b.json'}];
  Object.defineProperty(strings,'complete',{value:true,configurable:true});
  const program={
    complete:true, unsupported:false, graphCompleteness:{callsComplete:true,refsComplete:true},
    functionsReferencing(addr){ return [{addr:addr===1n?0x1000n:0x2000n}]; },
    functionRange(addr){ return {start:addr,end:addr+32n}; },
  };
  return {strings,program};
}

// #2810: limit truncation is observable even when no candidate decodes to a schema.
{
  const {strings,program}=schemaFixture();
  const out=await recoverSchemas({strings,program,architecture:'arm64',limit:1,read:async()=>null});
  assert.equal(out.complete,false);
  assert.match(out.incompleteReason,/schema-recovery-limit/);
  const full=await recoverSchemas({strings,program,architecture:'arm64',limit:300,read:async()=>null});
  assert.equal(full.complete,true);
}

// #2811: a tiny partial string budget cannot poison the canonical string cache.
{
  let calls=0;
  const region={id:'r',size:100n,section:'__cstring',cstrings:true};
  const app={
    backend:{gen:1,strings:async({maxBytes})=>{calls++; return {complete:maxBytes>=100,scannedBytes:maxBytes,results:[{addr:1n,text:'abc'}]};}},
    store:{get(key){if(key==='regions')return [region]; if(key==='currentRegion')return region; return null;}},
  };
  const service=new InvestigationService(app);
  const partial=await service.collectStrings({budget:{strings:{inputBytes:1,resultLimit:10,estimatedHeapBytes:10000}}});
  assert.equal(partial.complete,false);
  assert.equal(app.stringIndex,undefined,'partial budget result must not become global cache');
  const complete=await service.collectStrings();
  assert.equal(complete.complete,true);
  assert.equal(calls,2,'stronger/default budget must run after partial budget');
  assert.equal(app.stringIndex,complete);
}

// #2814: one BinaryId consumer abort detaches only that waiter; the shared hash survives.
{
  let resolveHash, producerSignal;
  const backend={
    file:{name:'x'}, gen:1,
    ensureContentHash(_progress,signal){producerSignal=signal; return new Promise((resolve,reject)=>{
      resolveHash=resolve;
      signal.addEventListener('abort',()=>reject(Object.assign(new Error('hash aborted'),{name:'AbortError'})),{once:true});
    });},
  };
  __demandDrivenInternalsForTests.installWorkerBackedIdentity({backend});
  const a=new AbortController(), b=new AbortController();
  const first=backend.ensureBinaryId({signal:a.signal});
  const second=backend.ensureBinaryId({signal:b.signal});
  await new Promise((resolve)=>setTimeout(resolve,0));
  a.abort('consumer-a-left');
  await assert.rejects(first,(error)=>error?.name==='AbortError');
  assert.equal(producerSignal.aborted,false,'remaining waiter keeps producer alive');
  resolveHash('a'.repeat(64));
  const binaryId=await second;
  assert.equal(typeof binaryId,'string');
  assert.ok(binaryId.length>10);
}
{
  let producerSignal;
  const backend={
    file:{name:'x'}, gen:1,
    ensureContentHash(_progress,signal){producerSignal=signal; return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('hash aborted'),{name:'AbortError'})),{once:true}));},
  };
  __demandDrivenInternalsForTests.installWorkerBackedIdentity({backend});
  const a=new AbortController(), b=new AbortController();
  const first=backend.ensureBinaryId({signal:a.signal});
  const second=backend.ensureBinaryId({signal:b.signal});
  await new Promise((resolve)=>setTimeout(resolve,0));
  a.abort('a'); b.abort('b');
  await Promise.allSettled([first,second]);
  await new Promise((resolve)=>setTimeout(resolve,0));
  assert.equal(producerSignal.aborted,true,'last waiter abort cancels producer');
}

// #2819: a maxSchemas=1 partial task is budget-local; the default task reruns and can publish complete.
{
  const {strings,program}=schemaFixture();
  let stringsCalls=0, programCalls=0, reads=0;
  const app={
    backend:{gen:1,readAt:async()=>{reads++;return {found:false};}},
    ensureStrings:async()=>{stringsCalls++;return strings;},
    ensureProgram:async()=>{programCalls++;return program;},
    store:{get(key){return key==='architecture'?'arm64':null;}},
    currentSlice:()=>({capability:{architecture:'arm64'}}),
  };
  const partial=await recoverSchemasForUi(app,{budget:{maxSchemas:1}});
  assert.equal(partial.complete,false);
  assert.match(partial.incompleteReason,/schema-recovery-limit/);
  assert.equal(app.schemas,undefined);
  const complete=await recoverSchemasForUi(app);
  assert.equal(complete.complete,true);
  assert.equal(app.schemas,complete);
  assert.equal(stringsCalls,2);
  assert.equal(programCalls,2);
  assert.ok(reads>=2);
  clearSchemaRecoveryTasks(app);
}
console.log('unlinked cache/completeness: PASS');

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runFreshSubject } from '../../tools/validation/public-benchmark/fresh-subject.mjs';
import { runFreshBenchmark, runPool } from '../../tools/validation/public-benchmark/run-fresh.mjs';
import { runFreshCase } from '../../tools/validation/public-benchmark/run-fresh-case.mjs';
import {
  atomicWriteJson,
  configDigest,
  loadReceipt,
  receiptIdentity,
  semanticSubjectDigest,
  sha256,
  stableJson,
  shouldReuseReceipt,
  writeReceipt,
} from '../../tools/validation/public-benchmark/fresh-state.mjs';
import { SUBJECT_RESULT_SCHEMA } from '../../tools/validation/public-benchmark/outcome.mjs';

function fakeProduct({ calls, architecture='arm64', endianness='little' } = {}) {
  const functions = [
    { address:'4096', name:'a', end:'4112' },
    { address:'8192', name:'b', end:'8208' },
  ];
  return {
    sha:'a'.repeat(64), architecture, endianness, profile:{ totalSetupMs:5 },
    app:{ backend:{ analysisRouteInfo:()=>({ route:'fixture' }) }, symbols:{ functionStartsComplete:true } },
    query:{
      snapshot:async()=>({ id:'s' }),
      functions:async(_snapshot,_query,page)=>({ value:page.offset ? [] : functions, page:{ next:null } }),
      decompile:async(_snapshot,address)=>{
        calls?.push(String(address));
        return { value:{ pseudocode:`fn_${address}()` }, status:{ completeness:'complete' } };
      },
    },
    close:async()=>{},
  };
}

function identity(overrides={}) {
  return receiptIdentity({
    caseId:'case', binarySha256:'a'.repeat(64), sourceIdentity:'source', configHash:'config', architecture:'arm64', endianness:'little', ...overrides,
  });
}

function functionResult(address='4096', state='PASS') {
  return { address:String(address), name:'a', end:'4112', state, completeness:state==='PASS'?'complete':null, pseudocode:state==='PASS'?`fn_${address}()`:null };
}

function putReceipt(dir, id, address='4096', state='PASS') {
  const result = functionResult(address,state);
  return writeReceipt(dir,id,{address,index:0,name:'a',end:'4112'}, {
    state, completeness:result.completeness, reason:null, elapsedMs:1,
    resultDigest:sha256(stableJson(result)), functionResult:result,
  });
}

test('shared fresh session preserves isolated semantic subject digest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-semantic-'));
  try {
    const calls=[];
    const result = await runFreshSubject({ binary:'unused', caseId:'case', receiptDir:dir, sourceIdentity:'source', configHash:'config', functionTimeoutMs:1000, openProductFn:async()=>fakeProduct({calls}) });
    const isolated = {
      schema:SUBJECT_RESULT_SCHEMA, state:'PASS', inputSha256:'a'.repeat(64), productRoute:{route:'fixture'}, functionDiscoveryComplete:true,
      functions:[
        { address:'4096', name:'a', end:'4112', state:'PASS', completeness:'complete', pseudocode:'fn_4096()' },
        { address:'8192', name:'b', end:'8208', state:'PASS', completeness:'complete', pseudocode:'fn_8192()' },
      ],
    };
    assert.equal(semanticSubjectDigest(result), semanticSubjectDigest(isolated));
    assert.deepEqual(calls,['4096','8192']);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('valid receipts are semantic-equivalent cache hits and skip completed functions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-resume-'));
  try {
    const firstCalls=[];
    const first = await runFreshSubject({ binary:'unused', caseId:'case', receiptDir:dir, sourceIdentity:'source', configHash:'config', functionTimeoutMs:1000, openProductFn:async()=>fakeProduct({calls:firstCalls}) });
    const secondCalls=[];
    const second = await runFreshSubject({ binary:'unused', caseId:'case', receiptDir:dir, sourceIdentity:'source', configHash:'config', functionTimeoutMs:1000, openProductFn:async()=>fakeProduct({calls:secondCalls}) });
    assert.equal(semanticSubjectDigest(first),semanticSubjectDigest(second));
    assert.deepEqual(secondCalls,[]);
    assert.equal(second.performance.reusedFunctions,2);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('receipt cache never crosses binary identity', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-bin-'));
  try { putReceipt(dir,identity()); assert.equal(loadReceipt(dir,identity({binarySha256:'b'.repeat(64)}),'4096'),null); }
  finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('receipt cache never crosses architecture or endianness', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-arch-'));
  try {
    putReceipt(dir,identity());
    assert.equal(loadReceipt(dir,identity({architecture:'x86_64'}),'4096'),null);
    assert.equal(loadReceipt(dir,identity({endianness:'big'}),'4096'),null);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('interrupted case can resume from durable completed receipt', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-interrupt-'));
  try { const row=putReceipt(dir,identity()); assert.equal(loadReceipt(dir,identity(),'4096').resultDigest,row.resultDigest); }
  finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('TIMEOUT is terminal by default and becomes retryable only when requested', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-timeout-'));
  try {
    putReceipt(dir,identity(),'4096','TIMEOUT');
    const row=loadReceipt(dir,identity(),'4096');
    assert.equal(shouldReuseReceipt(row,new Set()),true);
    assert.equal(shouldReuseReceipt(row,new Set(['TIMEOUT'])),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('stale source, config, and binary receipts are all rejected', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-stale-'));
  try {
    putReceipt(dir,identity());
    assert.equal(loadReceipt(dir,identity({sourceIdentity:'new-source'}),'4096'),null);
    assert.equal(loadReceipt(dir,identity({configHash:'new-config'}),'4096'),null);
    assert.equal(loadReceipt(dir,identity({binarySha256:'c'.repeat(64)}),'4096'),null);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('duplicate receipt address is one atomic slot and cannot double count', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-dup-'));
  try {
    putReceipt(dir,identity()); putReceipt(dir,identity());
    assert.equal(fs.readdirSync(dir).filter(name=>name.endsWith('.json')).length,1);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('worker pool preserves input ordering at worker=1 and worker>1', async () => {
  const values=[0,1,2,3,4,5];
  const one=await runPool(values,1,async value=>value*2);
  const four=await runPool(values,4,async value=>{ await new Promise(r=>setTimeout(r,(5-value)*2)); return value*2; });
  assert.deepEqual(four,one);
});

test('parallel atomic artifact writes never expose partial JSON', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-atomic-'));
  const file=path.join(dir,'artifact.json');
  try {
    await runPool(Array.from({length:32},(_,i)=>i),8,async value=>atomicWriteJson(file,{value,payload:'x'.repeat(1000)}));
    const parsed=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(typeof parsed.value,'number');
    assert.equal(parsed.payload.length,1000);
    assert.equal(fs.readdirSync(dir).some(name=>name.includes('.tmp-')),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('one crashed case runner does not destroy another case result', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-suite-'));
  try {
    const bench=path.join(root,'bench'); fs.mkdirSync(path.join(bench,'inputs'),{recursive:true}); fs.mkdirSync(path.join(bench,'reference'),{recursive:true});
    const cases=[];
    for (const id of ['good','bad']) {
      const bytes=Buffer.from(id); const ref=Buffer.from(`ref-${id}`);
      fs.writeFileSync(path.join(bench,'inputs',`${id}.bin`),bytes); fs.writeFileSync(path.join(bench,'reference',`${id}.c`),ref);
      cases.push({id,binary:`inputs/${id}.bin`,binarySha256:createHash('sha256').update(bytes).digest('hex'),reference:{path:`reference/${id}.c`,sha256:createHash('sha256').update(ref).digest('hex')}});
    }
    fs.writeFileSync(path.join(bench,'manifest.json'),JSON.stringify({schema:'hex-public-benchmark-manifest/v1',suite:'fixture',cases}));
    const run=await runFreshBenchmark({
      args:['--manifest',path.join(bench,'manifest.json'),'--output',path.join(root,'out'),'--workers','2'], cwd:root, repoRoot:root, log:()=>{},
      sourceIdentityFn:()=>({kind:'fixture',head:'f'.repeat(40),dirty:[],identity:'source'}),
      caseRunner:async ({caseId})=>{ if(caseId==='bad') throw Object.assign(new Error('boom'),{code:'BOOM'}); return {row:{schema:SUBJECT_RESULT_SCHEMA,state:'PASS',functions:[],functionStateCounts:{},performance:{reusedFunctions:0,executedFunctions:0}},restarts:0}; },
    });
    assert.equal(run.summary.states.PASS,1);
    assert.equal(run.summary.states.CRASH,1);
    assert.equal(run.summary.results.find(x=>x.id==='good').state,'PASS');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('config digest is stable under key order but changes timeout semantics', () => {
  assert.equal(configDigest({a:1,b:2}),configDigest({b:2,a:1}));
  assert.notEqual(configDigest({functionTimeoutMs:1000}),configDigest({functionTimeoutMs:2000}));
});


test('hard function watchdog persists TIMEOUT and restarts from the next durable state', { timeout:5000 }, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-watchdog-'));
  try {
    const receiptDir=path.join(root,'receipts'); fs.mkdirSync(receiptDir,{recursive:true});
    const out=path.join(root,'case.json');
    const fake=path.join(root,'fake-subject.mjs');
    fs.writeFileSync(fake, `import fs from 'node:fs';\nimport path from 'node:path';\nconst a=process.argv.slice(2);\nconst v=(n)=>a[a.indexOf(n)+1];\nconst receipt=v('--receipt-dir'), inflight=v('--inflight-file');\nconst done=fs.readdirSync(receipt).some(n=>n.endsWith('.json')&&n!=='inflight.json');\nif(done){console.log(JSON.stringify({schema:'hex-public-benchmark-subject/v1',state:'PASS',functions:[{address:'4096',name:'slow',state:'TIMEOUT',reason:'function-watchdog-timeout',pseudocode:null}]}));process.exitCode=1;}\nelse{fs.writeFileSync(inflight,JSON.stringify({schema:'hex-public-benchmark-function-receipt/v1',caseId:v('--case-id'),binarySha256:'${'a'.repeat(64)}',sourceIdentity:v('--source-id'),configHash:v('--config-hash'),architecture:'arm64',endianness:'little',functionAddress:'4096',functionIndex:0,functionName:'slow',functionEnd:'4112'}));setInterval(()=>{},1000);}\n`);
    const result=await runFreshCase({binary:'unused',out,caseId:'case',receiptDir,sourceIdentity:'source',configHash:'config',functionTimeoutMs:100,setupTimeoutMs:1000,watchdogGraceMs:10,pollMs:10,subjectPath:fake});
    assert.equal(result.restarts,1);
    assert.equal(result.row.state,'TIMEOUT');
    const row=loadReceipt(receiptDir,identity(),'4096');
    assert.equal(row.state,'TIMEOUT');
    assert.equal(row.reason,'function-watchdog-timeout');
    assert.equal(JSON.parse(fs.readFileSync(out,'utf8')).state,'TIMEOUT');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

// Writes a fake subject that measures two functions and reports PASS. The inflight marker only
// exists while a function is running (as in fresh-subject.mjs), so the interval between the first
// function's end and the second function's start has no marker: that interval is not case setup.
function writeTwoFunctionSubject(file,{firstFunctionMs=0,betweenFunctionsMs=0}={}) {
  fs.writeFileSync(file,`import fs from 'node:fs';\nconst args=process.argv.slice(2);\nconst v=(n)=>args[args.indexOf(n)+1];\nconst inflight=v('--inflight-file');\nconst functions=[{address:'4096',name:'first'},{address:'8192',name:'second'}];\nconst sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));\nconst syncBusy=(ms)=>{const until=performance.now()+ms;while(performance.now()<until){}};\nconst results=[];\nfor(let i=0;i<functions.length;i++){\n  const fn=functions[i];\n  fs.writeFileSync(inflight,JSON.stringify({functionAddress:fn.address,functionIndex:i,functionName:fn.name}));\n  if(i===0&&${firstFunctionMs}>0) await sleep(${firstFunctionMs});\n  fs.rmSync(inflight,{force:true});\n  results.push({address:fn.address,name:fn.name,state:'PASS',pseudocode:'void f() {}'});\n  if(i===0&&${betweenFunctionsMs}>0) syncBusy(${betweenFunctionsMs});\n}\nconsole.log(JSON.stringify({schema:'hex-public-benchmark-subject/v1',state:'PASS',functions:results,performance:{setup:{},totalMs:0,reusedFunctions:0,executedFunctions:results.length,functionTimingsMs:[]}}));\n`);
}

test('case setup timeout never fires for the gap between two measured functions', { timeout:10000 }, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-midrun-gap-'));
  try {
    const receiptDir=path.join(root,'receipts'); fs.mkdirSync(receiptDir,{recursive:true});
    const out=path.join(root,'case.json');
    const subjectPath=path.join(root,'fake-subject.mjs');
    // setupTimeoutMs=1000: the child exceeds that total age while running the first function,
    // then performs 600 ms of marker-less between-function work (< the setup/no-progress budget).
    writeTwoFunctionSubject(subjectPath,{firstFunctionMs:1400,betweenFunctionsMs:600});
    const result=await runFreshCase({
      binary:'unused', out, caseId:'case', receiptDir, sourceIdentity:'source', configHash:'config',
      functionTimeoutMs:2000, setupTimeoutMs:1000, watchdogGraceMs:100, pollMs:10, subjectPath,
    });
    assert.equal(result.row.reason ?? null,null,'mid-run gap must not be reported as case-setup-timeout');
    assert.equal(result.row.state,'PASS');
    assert.equal(result.row.functions.length,2);
    assert.deepEqual(result.row.functions.map(fn=>`${fn.address}:${fn.state}`),['4096:PASS','8192:PASS']);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('a stall between two functions is still bounded by the setup/no-progress budget', { timeout:10000 }, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-midrun-stall-'));
  try {
    const receiptDir=path.join(root,'receipts'); fs.mkdirSync(receiptDir,{recursive:true});
    const out=path.join(root,'case.json');
    const subjectPath=path.join(root,'fake-subject.mjs');
    writeTwoFunctionSubject(subjectPath,{firstFunctionMs:1400,betweenFunctionsMs:3000});
    const started=performance.now();
    const result=await runFreshCase({
      binary:'unused', out, caseId:'case', receiptDir, sourceIdentity:'source', configHash:'config',
      functionTimeoutMs:2000, setupTimeoutMs:1000, watchdogGraceMs:100, pollMs:10, subjectPath,
    });
    assert.equal(result.row.state,'TIMEOUT');
    assert.equal(result.row.reason,'case-setup-timeout');
    assert.ok(performance.now()-started < 5000,`stalled case must be killed by the no-progress budget, took ${performance.now()-started} ms`);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('a child that never reaches a function is still killed as case-setup-timeout', { timeout:10000 }, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hex-fresh-setup-hang-'));
  try {
    const receiptDir=path.join(root,'receipts'); fs.mkdirSync(receiptDir,{recursive:true});
    const out=path.join(root,'case.json');
    const subjectPath=path.join(root,'fake-subject.mjs');
    fs.writeFileSync(subjectPath,`setInterval(()=>{},1000);\n`);
    const result=await runFreshCase({
      binary:'unused', out, caseId:'case', receiptDir, sourceIdentity:'source', configHash:'config',
      functionTimeoutMs:2000, setupTimeoutMs:1000, watchdogGraceMs:100, pollMs:10, subjectPath,
    });
    assert.equal(result.row.state,'TIMEOUT');
    assert.equal(result.row.reason,'case-setup-timeout');
    assert.deepEqual(result.row.functions,[]);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

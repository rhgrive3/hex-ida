import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,workFor} from './helpers.mjs';
import {semanticAbiAdapter} from '../../js/analysis/semantic-function.js';
import {AAPCS64_ABI} from '../../js/targets/abi/index.js';
import {queryScopedAbiPlacement} from '../../js/analysis/types/scoped-abi.js';
const pair={type:'struct Pair',aggregate:true,bits:128,members:[0,8].map(byteOffset=>({type:'uint64',bits:64,byteOffset}))};
function setup(t,prototype={parameters:[pair]}) {
  const f=fixture(d=>{d.profile.abiRevision=AAPCS64_ABI.semanticVersion;});
  const snapshotId='snap',functionId='function',adapter=semanticAbiAdapter(AAPCS64_ABI,{architecture:'arm64',platform:'linux',binaryId:'binary-scpa-test',sliceId:'slice-arm64',functionId,snapshotId});
  const original=adapter.classifyArguments(prototype?{functionPrototype:prototype}:{});
  const context={binding:{worldId:f.world.id,assumptionsId:f.assumptions.id,snapshotId,binaryId:'binary-scpa-test',functionId,kind:'arguments',callSiteId:null,producerArtifactId:'native-abi',ownerRevision:'one'},
    result:{...original,completeness:'partial'},isCurrent:()=>true};
  return {context,run:(allow=true)=>queryScopedAbiPlacement({functionId,kind:'arguments'},{...f,snapshotId,work:workFor(t),getContext:()=>context,allowPartialDeclarations:allow})};
}
test('partial aggregate retains physical/logical candidate geometry without hard type facts',async t=>{
  const {context,run}=setup(t);context.result.arguments[0].possible=true;context.result.arguments[0].exact=false;
  const r=await run();assert.equal(r.status,'partial');assert.equal(r.argumentCountClosed,false);
  assert.deepEqual(r.results[0].candidatePieces.map(p=>p.logicalBitOffset),[0,64]);
  assert.deepEqual(r.results[0].candidatePieces.map(p=>p.destination.register),['x0','x1']);
  assert.equal(r.results[0].candidateStatus,'described-only');assert.deepEqual(r.results[0].pieces,[]);
  assert.equal(r.results[0].typeConstraintPublished,false);assert.equal(r.results[0].declaration.possible,true);
  assert.equal(Object.hasOwn(r.results[0],'graph'),false);assert.equal((await run(false)).status,'unsupported');
});
test('real no-prototype output does not imply width, arity, pointer type, or zero stack arguments',async t=>{
  const {run}=setup(t,null),r=await run();assert.equal(r.status,'partial');assert.equal(r.argumentCountClosed,false);
  assert.equal(r.results.length,16);assert.ok(r.results.every(e=>e.candidatePieces.length===0&&e.pieces.length===0));
});
test('invalid aggregate coverage is visible but never filled from its register list',async t=>{
  const {context,run}=setup(t);context.result.arguments[0].pieces.pop();
  const r=await run();assert.equal(r.results[0].candidateStatus,'inconsistent');assert.deepEqual(r.results[0].candidatePieces,[]);
});
test('register list without canonical pieces cannot be expanded into candidate lanes',async t=>{
  const {context,run}=setup(t);delete context.result.arguments[0].pieces;
  const r=await run();assert.deepEqual(r.results[0].candidatePieces,[]);
});
test('scalar span is not inferred, but an explicitly declared candidate span can be inspected',async t=>{
  const {context,run}=setup(t,{parameters:[{type:'uint32',bits:32}]});
  assert.deepEqual((await run()).results[0].candidatePieces,[]);
  context.result.arguments[0].bytes=4;context.result.arguments[0].possible=true;
  const r=await run();assert.equal(r.results[0].candidatePieces[0].bitSize,32);assert.deepEqual(r.results[0].pieces,[]);
});
test('overlapping x/w candidates are diagnostic and neither candidate becomes exact',async t=>{
  const {context,run}=setup(t,{parameters:[{type:'uint64',bits:64},{type:'uint32',bits:32}]});
  context.result.arguments[0]={...context.result.arguments[0],reg:'x0',bytes:8};
  context.result.arguments[1]={...context.result.arguments[1],reg:'w0',bytes:4};
  const r=await run();assert.equal(r.candidateConflicts.rows.length,1);assert.ok(r.results.every(e=>!e.staticExact&&!e.typeConstraintPublished));
});
test('partial candidate geometry still rejects malformed physical widths',async t=>{
  const {context,run}=setup(t,{parameters:[{type:'uint64',bits:64}]});context.result.arguments[0].bytes=1;
  await assert.rejects(run(),/physical-width/);
});

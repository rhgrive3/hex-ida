import assert from 'node:assert/strict';
import test from 'node:test';
import { createPassDescriptor } from '../../../js/decompiler/phase8/contract.js';
import { createAnalysisState, runPassTransaction } from '../../../js/decompiler/phase8/transaction.js';
import { createValidatedPassResult, validateMemoryRewriteAdoption, validateTerminalEffectRewriteAdoption } from '../../../js/decompiler/phase8/pass-validation.js';
import { partialStoreFixture, identity } from '../../phase9/memory/main-fixtures.mjs';

const STATE=Object.freeze({ssa:{key:'ssa'},cfg:{key:'cfg'}});
function descriptor(){return createPassDescriptor({id:'phase8.c4-memory-probe',version:'1.0.0',stage:'scalar-optimization',consumes:['ssa'],preserves:['cfg'],invalidates:[]});}
function passFor(validation,rewrite,kind='memory-byte-rewrite',targets=['memory-state']){
  const d=descriptor();
  return {descriptor:d,run(){return createValidatedPassResult({descriptor:d,status:'changed',changed:true,transforms:[{kind,targets,proof:'C4-04B bounded semantic equivalence',rewrite,validation}]});}};
}
function memoryRequest(beforeIr,afterIr){return {identity,beforeIr,afterIr,inputs:[],preconditions:[],memory:{addressBits:12,endian:'little',wrapping:'modular',alignment:'unaligned'},timeoutMs:5000,backendTier:'tiered'};}
function rewrite(kind='memory-byte-rewrite'){return Object.freeze({before:Object.freeze({kind,revision:0}),after:Object.freeze({kind,revision:1})});}
function faultDescriptor(){return {kind:'pc-alignment-fault',condition:{kind:'target-misaligned',alignmentBytes:4},detail:{architecture:'arm64',instructionSet:'a64'}};}
function withFaultTarget(ir,target){const ret=ir.instructions.find(inst=>inst.op==='ret');ret.returnTargetValue={id:`pc-${target}`,kind:'const',const:target,bits:64};ret.extra={...(ret.extra??{}),returnControlTargetValueId:'return-pc',returnControlTarget:{schema:'semantic-return-control-target/v1',state:'resolved',valueId:'return-pc'},attributes:{...((ret.extra??{}).attributes??{}),machineEffects:{bundleCompleteness:'exact',unknownEffects:false,architectureId:'arm64',mode:'a64',possibleFaults:[faultDescriptor()]}}};return ir;}

test('C4-04B finite-byte memory rewrite commits only with a current private receipt',async()=>{
  const before=partialStoreFixture(),after=partialStoreFixture(),proof=rewrite();
  const request=memoryRequest(before,after);
  const validation=await validateMemoryRewriteAdoption({passId:'phase8.c4-memory-probe',passVersion:'1.0.0',transformKind:'memory-byte-rewrite',targets:['memory-state'],rewrite:proof,memoryRequest:request});
  assert.equal(validation.validation,'equivalent',validation.reason);
  const outcome=runPassTransaction(createAnalysisState(STATE),passFor(validation,proof),{},{});
  assert.equal(outcome.committed,true,outcome.stopReason);
  assert.equal(outcome.result.transforms.length,1);
});

test('C4-04B stale memory proof cannot cross the transaction boundary',async()=>{
  const before=partialStoreFixture(),after=partialStoreFixture(),proof=rewrite(),request=memoryRequest(before,after);
  const validation=await validateMemoryRewriteAdoption({passId:'phase8.c4-memory-probe',passVersion:'1.0.0',transformKind:'memory-byte-rewrite',targets:['memory-state'],rewrite:proof,memoryRequest:request});
  assert.equal(validation.validation,'equivalent');
  after.instructions[1].args[0].value.const=0xbbn;
  const outcome=runPassTransaction(createAnalysisState(STATE),passFor(validation,proof),{},{});
  assert.equal(outcome.committed,false);
  assert.match(outcome.stopReason,/equivalence-authority/);
});

test('C4-04B memory mismatch is refuted and atomic',async()=>{
  const before=partialStoreFixture(),after=partialStoreFixture();after.instructions[1].args[0].value.const=0xbbn;
  const proof=rewrite(),validation=await validateMemoryRewriteAdoption({passId:'phase8.c4-memory-probe',passVersion:'1.0.0',transformKind:'memory-byte-rewrite',targets:['memory-state'],rewrite:proof,memoryRequest:memoryRequest(before,after)});
  assert.equal(validation.validation,'refuted',validation.reason);
  const state=createAnalysisState(STATE),snapshot=state.snapshot(),outcome=runPassTransaction(state,passFor(validation,proof),{},{});
  assert.equal(outcome.committed,false);assert.match(outcome.stopReason,/rewrite-refuted/);assert.deepEqual(state.snapshot(),snapshot);
});

test('C4-04B canonical terminal fault effects can authorize only their declared effect rewrite',async()=>{
  const before=withFaultTarget(partialStoreFixture(),0x1001n),after=withFaultTarget(partialStoreFixture(),0x1001n);
  const proof=rewrite('terminal-control-effect-rewrite');
  const effectRequest={identity:{...identity,architecture:'arm64'},beforeIr:before,afterIr:after,inputs:[],preconditions:[],timeoutMs:5000,backendTier:'tiered'};
  const validation=await validateTerminalEffectRewriteAdoption({passId:'phase8.c4-memory-probe',passVersion:'1.0.0',transformKind:'terminal-control-effect-rewrite',targets:['terminal-control'],rewrite:proof,effectRequest});
  assert.equal(validation.validation,'equivalent',validation.reason);
  const outcome=runPassTransaction(createAnalysisState(STATE),passFor(validation,proof,'terminal-control-effect-rewrite',['terminal-control']),{},{});
  assert.equal(outcome.committed,true,outcome.stopReason);
});

test('C4-04B unvalidated memory rewrite is no longer an admissible escape hatch',()=>{
  const d=descriptor(),state=createAnalysisState(STATE),snapshot=state.snapshot();
  const pass={descriptor:d,run(){return createValidatedPassResult({descriptor:d,status:'changed',changed:true,transforms:[{kind:'memory-byte-rewrite',targets:['memory-state'],proof:'missing proof',rewrite:rewrite(),unvalidatedReason:'memory used to be outside scalar proof scope'}]});}};
  const outcome=runPassTransaction(state,pass,{},{});
  assert.equal(outcome.committed,false);assert.match(outcome.stopReason,/rewrite-unvalidated/);assert.deepEqual(state.snapshot(),snapshot);
});

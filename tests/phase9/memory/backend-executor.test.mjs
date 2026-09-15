import test from 'node:test';
import assert from 'node:assert/strict';
import { createByteMemory, symbolicExecute, expr as E, solver, verify } from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir.js';
import { identity, integrationFixture, scalarFixture } from '../taint/fixtures.mjs';
import { memoryFixture } from './fixtures.mjs';

test('bounded byte-memory formulas are consumed by the existing actual backend',async()=>{
  const m=createByteMemory({identity,addressBits:2,initialBytes:[[0n,0n],[1n,1n],[2n,2n],[3n,3n]]});
  const p=E.createFreshSymbol(E.bvSort(2),'p'),q=E.createFreshSymbol(E.bvSort(2),'q');
  assert.equal(m.store(p,1,99n).status,'stored');const read=m.load(q,1);assert.ok(read.expression,read.reason);
  const session=new solver.ExhaustiveBvBackend().createSession();
  try {
    const query=verify.createVerificationQuery({kind:verify.VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,claimKind:verify.CLAIM_KIND.EDGE_FEASIBLE,
      targetEntity:'byte-read-over-write',constraints:[E.createCompare('eq',p,q)],assertion:E.createCompare('ne',read.expression,E.createBv(8,99))});
    const result=await session.check(query);assert.equal(result.status,'unsat');
    const alternative=verify.createVerificationQuery({kind:verify.VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,claimKind:verify.CLAIM_KIND.EDGE_FEASIBLE,
      targetEntity:'byte-may-alias',assertion:E.createCompare('ne',read.expression,E.createBv(8,99))});
    const witness=await session.check(alternative);assert.equal(witness.status,'sat');assert.equal(verify.validateSatModel(alternative,witness.model).valid,true);
  } finally {session.dispose();}
});
test('concrete-only default executor parity and bounded canonical replay',()=>{
  for(const endian of ['little','big']) {
    const {ir,options}=memoryFixture({endian});
    const legacy=symbolicExecute(ir),first=symbolicExecute(ir,options),second=symbolicExecute(ir,options);
    assert.equal(first.status,'complete');assert.equal(first.paths[0].returnValue.value,legacy.paths[0].returnValue.value);
    assert.deepEqual(first.paths,second.paths);
  }
});
test('executor limit N-1/N/N+1 uses measured paths, steps, branches and visits',()=>{
  const ir=integrationFixture(),byteMemory={identity,addressBits:8,wrapping:'modular'};
  const base=symbolicExecute(ir,{byteMemory});assert.equal(base.status,'complete');
  for(const [option,metric] of [['maxPaths','paths'],['maxSteps','stepsPerPath'],['maxBranches','branches'],['maxBlockVisits','blockVisitsPerBlock']]) {
    const count=base.metrics[metric];
    const low=symbolicExecute(ir,{byteMemory,[option]:count-1});assert.equal(low.status,'partial',option);assert.equal(low.paths.length,0);
    for(const n of [count,count+1]) assert.equal(symbolicExecute(ir,{byteMemory,[option]:n}).status,'complete',option);
  }
});
test('production rejects unresolved stores, width laundering and malformed flags',()=>{
  const {ir,options}=memoryFixture();ir.blocks[0].insts[0].loc=null;
  assert.equal(symbolicExecute(ir,options).status,'partial');
  const bad=memoryFixture();bad.ir.blocks[0].insts[1].dst.bits=8;
  assert.equal(symbolicExecute(bad.ir,bad.options).reason,'load-width-mismatch');
  const flag=memoryFixture();flag.ir.blocks[0].insts[1].volatile='unknown';
  assert.equal(symbolicExecute(flag.ir,flag.options).reason,'volatile-barrier');
  const unsafe=scalarFixture();unsafe.blocks[0].insts[0].args[0].value.const=Number.MAX_SAFE_INTEGER+1;
  assert.equal(symbolicExecute(unsafe,{byteMemory:{identity,addressBits:8}}).reason,'unsafe-integer');
});
test('preflight rejects oversized IR before making an address map',()=>{
  const ir=scalarFixture();ir.blocks=Array(20).fill(ir.blocks[0]);
  const r=symbolicExecute(ir,{byteMemory:{identity,addressBits:8,limits:{workItems:10}}});
  assert.equal(r.status,'partial');assert.equal(r.reason,'budget:workItems');assert.equal(r.metrics.stepsPerPath,0);
});
test('nonmatching and duplicate PHI predecessor bindings cannot produce exact values',()=>{
  for(const incoming of [[{from:99,value:{id:'wrong',const:0n,bits:8}}],[{from:1,value:{id:'one',const:1n,bits:8}},{from:1,value:{id:'two',const:2n,bits:8}}]]) {
    const ir=integrationFixture();ir.blocks[3].phis[0].incoming=incoming;
    const r=symbolicExecute(ir,{byteMemory:{identity,addressBits:8,wrapping:'modular'}});
    assert.equal(r.status,'partial');assert.equal(r.reason,'ambiguous-phi');
  }
});

test('actual compatibility memoryAccess qualifiers and addr space are not silently ignored',()=>{
  const descriptor={widthBits:32,addressSpace:'data',endian:'little',atomic:false,volatility:false,ordering:'unknown'};
  for(const [change,reason] of [
    [{atomic:true},'atomic-barrier'],[{volatility:true},'volatile-barrier'],
    [{atomic:null},'unknown-memory-qualifiers'],[{volatility:null},'unknown-memory-qualifiers'],
    [{endian:'big'},'memory-endian-mismatch'],[{addressSpace:'code'},'address-space-mismatch'],
    [{widthBits:64},'memory-width-mismatch'],
  ]) {
    const {ir,options}=memoryFixture();ir.blocks[0].insts[1].extra={memoryAccess:{...descriptor,...change}};
    const result=symbolicExecute(ir,options);assert.equal(result.status,'partial');assert.equal(result.reason,reason);
  }
  const good=memoryFixture();good.ir.blocks[0].insts[1].extra={memoryAccess:descriptor};
  assert.equal(symbolicExecute(good.ir,good.options).status,'complete');
  const space=memoryFixture();space.ir.blocks[0].insts[1].addr={addressSpace:'code'};
  assert.equal(symbolicExecute(space.ir,space.options).reason,'address-space-mismatch');
  const imprecise=memoryFixture();imprecise.ir.blocks[0].insts[1].addr={precise:false};
  assert.equal(symbolicExecute(imprecise.ir,imprecise.options).reason,'unresolved-memory-address');
});

test('existing FunctionSandbox.symbolic callsite reaches the canonical byte executor',async()=>{
  const {FunctionSandbox}=await import('../../../js/symbolic/index.js');
  const {ir,options}=memoryFixture({partial:true});
  const r=new FunctionSandbox().symbolic(ir,options);
  assert.equal(r.status,'complete');assert.equal(r.paths[0].returnValue.value,0x1122aa44n);
  assert.equal(r.identity.snapshotId,identity.snapshotId);
});

test('unrecognized instructions and legacy lookalike input objects cannot mint exact execution',()=>{
  const ir=scalarFixture();ir.blocks[0].insts.splice(1,0,{id:'unknown-effect',op:'unrecognized-effect',args:[]});
  assert.equal(symbolicExecute(ir,{byteMemory:{identity,addressBits:8}}).status,'partial');
  for(const configured of [{kind:'const',value:7n},Object.freeze({kind:'symbol',name:'x'}),false]) {
    const r=symbolicExecute(scalarFixture(),{byteMemory:{identity,addressBits:8},symbolicArgs:{0:configured}});
    assert.equal(r.status,'partial');assert.equal(r.reason,'unsupported-configured-argument');
  }
  const missing=scalarFixture();missing.blocks[0].insts[0].op=OP.BIN;
  missing.blocks[0].insts[0].args.push({value:{id:'one',bits:8,const:1n}});
  assert.equal(symbolicExecute(missing,{byteMemory:{identity,addressBits:8}}).status,'partial');
});

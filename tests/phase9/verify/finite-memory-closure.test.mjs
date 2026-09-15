import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../../js/symbolic/index.js';
import { OP, MK } from '../../../js/ir-base.js';
import { identity } from '../memory/main-fixtures.mjs';
const E=S.expr;
const val=(id,bits,n)=>({id,bits,...(n==null?{kind:'arg',reg:id}:{const:BigInt(n)})});
const at=(address,size)=>({kind:MK.GLOBAL,address,size});
function store(address,size,value) { return {op:OP.STORE,loc:at(address,size),args:[{value}]}; }
function ir(insts,ret=val('ret',8,0)) {
  const instructions=[...insts,{op:OP.RET,args:ret?[{value:ret}]:[]}];
  for(const [index,inst]of instructions.entries()) {inst.id??=`i${index}`;inst.address??=BigInt(index*4);inst.row??=index;if(inst.dst)inst.dst.def=inst;}
  return {entry:0,instructions,blocks:[{index:0,insts:instructions,succ:[]}]};
}
const config={identity,memory:{addressBits:1,wrapping:'modular',initialBytes:[[0n,0],[1n,0]]},inputs:[]};
const query=(beforeIr,afterIr,extra={})=>S.queryMemoryEquivalence({...config,beforeIr,afterIr,...extra});
test('different stores cannot prove equivalent merely because return values match',async()=>{
  const r=await query(ir([store(0n,1,val('a',8,1))]),ir([store(0n,1,val('a',8,2))]));
  assert.equal(r.verdict,'refuted',r.reason);assert.equal(r.eligible,false);assert.equal(r.firstDivergence?.address,0n);
  assert.ok(r.evidence);assert.equal(r.metrics.solverCalls,1);
});
test('equivalent partial writes prove using the actual Bool/BV backend',async()=>{
  const before=ir([store(0n,2,val('word',16,0x1234)),store(1n,1,val('high',8,0xab))]);
  const after=ir([store(0n,1,val('low',8,0x34)),store(1n,1,val('high',8,0xab))]);
  const r=await query(before,after);assert.equal(r.verdict,'proved',r.reason);assert.equal(r.eligible,true);
  assert.equal(r.scope.kind,'finite-byte-execution');assert.equal(r.scope.domainBytes,2);
  assert.equal(S.isAdoptableMemoryEquivalence(r,{identity,beforeIr:before,afterIr:after,preconditions:[],memory:config.memory,inputs:[]}),true);
});
test('unknown initial byte is shared between executions rather than silently zero initialized',async()=>{
  const before=ir([]),same=ir([]),changed=ir([store(0n,1,val('zero',8,0))]);
  const extra={memory:{addressBits:1,wrapping:'modular',initialBytes:[[1n,0]]}};
  assert.equal((await query(before,same,extra)).verdict,'proved');
  const r=await query(before,changed,extra);assert.equal(r.verdict,'refuted',r.reason);assert.equal(r.firstDivergence?.address,0n);
});
function symbolicStoreFixture(swap=false) {
  const p=val('p',1),q=val('q',1);
  const a={op:OP.STORE,args:[{value:val('a',8,1)}],addr:{base:p,disp:0n,size:1},loc:{kind:MK.UNKNOWN,size:1}};
  const b={op:OP.STORE,args:[{value:val('b',8,2)}],addr:{base:q,disp:0n,size:1},loc:{kind:MK.UNKNOWN,size:1}};
  return {program:ir(swap?[b,a]:[a,b]),p,q};
}
test('symbolic store order is refuted under alias and proved with an explicit disjoint precondition',async()=>{
  const b=symbolicStoreFixture(),a=symbolicStoreFixture(true);
  const p=E.createFreshSymbol(E.bvSort(1),'address_p'),q=E.createFreshSymbol(E.bvSort(1),'address_q');
  const inputs=[{before:b.p,after:a.p,expression:p},{before:b.q,after:a.q,expression:q}];
  assert.equal((await query(b.program,a.program,{inputs})).verdict,'refuted');
  const preconditions=[E.createCompare('ne',p,q)];const r=await query(b.program,a.program,{inputs,preconditions});
  assert.equal(r.verdict,'proved',r.reason);
  assert.equal(S.isAdoptableMemoryEquivalence(r,{identity,beforeIr:b.program,afterIr:a.program,preconditions:[]}),false);
  assert.equal(S.isAdoptableMemoryEquivalence(r,{identity,beforeIr:b.program,afterIr:a.program,preconditions,memory:config.memory,inputs}),true);
});
test('contradictory preconditions never mint vacuous adoption',async()=>{
  const r=await query(ir([]),ir([]),{preconditions:[E.createBool(false)]});
  assert.equal(r.eligible,false);assert.equal(r.verdict,'unknown');assert.match(r.reason,/precondition/);
});
test('the public query refuses omitted observables, forged proof flags and unmodeled effects',async()=>{
  const b=ir([]),a=ir([]);
  for(const extra of [{memoryObservables:[]},{verified:true},{backend:{}},{effectObservables:[]}])assert.equal((await query(b,a,extra)).eligible,false);
  assert.equal((await query(ir([{op:OP.CALL,args:[]}]),a)).eligible,false);
  const state=ir([{op:OP.MOV,extra:{stateWrite:{register:'flags'}},args:[{value:val('c',8,1)}],dst:{id:'s',bits:8}}]);
  assert.equal((await query(state,a)).eligible,false);
});
test('stale IR, stale identity and forged receipt cannot be adopted',async()=>{
  const b=ir([]),a=ir([]),r=await query(b,a);assert.equal(r.eligible,true,r.reason);
  assert.equal(S.isAdoptableMemoryEquivalence({...r},{identity,beforeIr:b,afterIr:a,preconditions:[],memory:config.memory,inputs:[]}),false);
  assert.equal(S.isAdoptableMemoryEquivalence(r,{identity:{...identity,snapshotId:'new'},beforeIr:b,afterIr:a,preconditions:[]}),false);
  a.instructions[0].args[0].value.const=1n;
  assert.equal(S.isAdoptableMemoryEquivalence(r,{identity,beforeIr:b,afterIr:a,preconditions:[],memory:config.memory,inputs:[]}),false);
});
test('cancel, deadline and observation limits publish no proof or paths',async()=>{
  for(const extra of [{signal:AbortSignal.abort()},{timeoutMs:0},{limits:{observedBytes:3}}]) {
    const r=await query(ir([]),ir([]),extra);assert.equal(r.eligible,false);assert.equal(r.evidence,null);
  }
  for(const observedBytes of [4,5])assert.equal((await query(ir([]),ir([]),{limits:{observedBytes}})).eligible,true);
});
test('unmatched inputs, geometry mismatch and excessive unknown state stay unknown',async()=>{
  const p=val('input',1);assert.equal((await query(ir([],p),ir([]))).eligible,false);
  assert.equal((await query(ir([]),ir([]),{memory:{addressBits:65}})).eligible,false);
  const r=await query(ir([]),ir([]),{memory:{addressBits:4}});assert.equal(r.eligible,false);assert.equal(r.evidence,null);
});
test('big endian partial writes are checked over every byte',async()=>{
  const extra={memory:{...config.memory,endian:'big'}};
  const b=ir([store(0n,2,val('w',16,0x1234)),store(1n,1,val('low',8,0xab))]);
  const a=ir([store(0n,1,val('hi',8,0x12)),store(1n,1,val('low',8,0xab))]);
  assert.equal((await query(b,a,extra)).eligible,true);
});
function branched(yes=1,no=2) {
  const p=val('branch-input',1);
  const branch={op:OP.CBR,id:'branch',args:[{value:p}],extra:{kind:'cbnz',target:8n},row:0,address:0n};
  const y=store(0n,1,val('yes',8,yes)),n=store(0n,1,val('no',8,no));
  const r1={op:OP.RET,args:[{value:val('ry',8,0)}]},r2={op:OP.RET,args:[{value:val('rn',8,0)}]};
  for(const [i,inst]of [y,r1,n,r2].entries())Object.assign(inst,{id:`arm${i}`,row:i+1,address:8n+BigInt(i*4)});
  return {p,program:{entry:0,blocks:[{index:0,insts:[branch],succ:[1,2]},{index:1,insts:[y,r1],succ:[]},{index:2,insts:[n,r2],succ:[]}],instructions:[branch,y,r1,n,r2]}};
}
test('all terminal paths and cross-path memory observables participate in the proof',async()=>{
  const b=branched(),a=branched(),changed=branched(1,3);
  const inputs=[{before:b.p,after:a.p}];
  const r=await query(b.program,a.program,{inputs});assert.equal(r.verdict,'proved',r.reason);
  assert.equal(r.scope.beforePathCount,2);assert.equal(r.scope.afterPathCount,2);assert.equal(r.metrics.proofPairs,4);
  const no=await query(b.program,changed.program,{inputs:[{before:b.p,after:changed.p}]});
  assert.equal(no.verdict,'refuted',no.reason);assert.equal(no.firstDivergence.kind,'memory-byte');
  assert.equal(no.firstDivergence.before,2n);assert.equal(no.firstDivergence.after,3n);
  for(const proofPairs of [3,4,5]){
    const result=await query(b.program,a.program,{inputs,limits:{proofPairs}});
    assert.equal(result.eligible,proofPairs>=4,result.reason);
  }
  assert.equal((await query(b.program,a.program,{inputs,execution:{maxPaths:1}})).eligible,false);
});
test('deadline, cancel and source invalidation during the judge await discard the entire proof',async()=>{
  const b=ir([]),a=ir([]);
  const pending=query(b,a);
  queueMicrotask(()=>{a.instructions[0].args[0].value.const=2n;});
  const stale=await pending;assert.equal(stale.eligible,false);assert.equal(stale.evidence,null);
  const signal=new AbortController();const cancelled=query(ir([]),ir([]),{signal:signal.signal});
  queueMicrotask(()=>signal.abort());const r=await cancelled;assert.equal(r.eligible,false);assert.equal(r.evidence,null);
});
test('unsupported execution injection cannot supply fabricated values or taint handlers',async()=>{
  let calls=0;
  for(const execution of [{_taint:{value:()=>{calls++;}}},{symbolicArgs:{0:1n}},{unknownCall:()=>{calls++;}}]) {
    const r=await query(ir([]),ir([]),{execution});assert.equal(r.eligible,false);assert.equal(r.evidence,null);
  }
  assert.equal(calls,0);
});
test('finite loop is compared at termination; exhausted visits cannot prove termination',async()=>{
  const start=val('start',8,2),n={id:'n',bits:8},next={id:'next',bits:8};
  const phi={id:'phi',op:OP.PHI,args:[],incoming:[{from:-1,value:start},{from:1,value:next}],dst:n};n.def=phi;
  const s=store(0n,1,n);Object.assign(s,{id:'s',row:0,address:0n});
  const branch={id:'br',op:OP.CBR,args:[{value:n}],extra:{kind:'cbnz',target:8n},row:1,address:4n};
  const sub={id:'sub',op:OP.BIN,sub:'sub',args:[{value:n},{value:val('one',8,1)}],dst:next,row:2,address:8n};next.def=sub;
  const back={id:'back',op:OP.BR,args:[],extra:{target:0n},row:3,address:12n};
  const ret={id:'r',op:OP.RET,args:[{value:n}],row:4,address:16n};
  const b={entry:0,blocks:[{index:0,phis:[phi],insts:[s,branch],succ:[1,2]},{index:1,insts:[sub,back],succ:[0]},{index:2,insts:[ret],succ:[]}],instructions:[phi,s,branch,sub,back,ret]};
  const a=ir([store(0n,1,val('zero',8,0))]);
  assert.equal((await query(b,a)).eligible,true);
  assert.equal((await query(b,a,{execution:{maxBlockVisits:2}})).eligible,false);
});
test('adoption rechecks the current initial memory assumptions and input correspondence',async()=>{
  const b=ir([]),a=ir([store(0n,1,val('zero',8,0))]);
  const r=await query(b,a);assert.equal(r.eligible,true);
  assert.equal(S.isAdoptableMemoryEquivalence(r,{identity,beforeIr:b,afterIr:a,preconditions:[],inputs:[],memory:{...config.memory,initialBytes:[[0n,1],[1n,0]]}}),false);
  const left=branched(),right=branched();const inputs=[{before:left.p,after:right.p}];
  const proof=await query(left.program,right.program,{inputs});assert.equal(proof.eligible,true,proof.reason);
  assert.equal(S.isAdoptableMemoryEquivalence(proof,{identity,beforeIr:left.program,afterIr:right.program,preconditions:[],inputs:[],memory:config.memory}),false);
});
test('64-bit concrete write footprint proves global terminal byte equality without enumerating the address space',async()=>{
  const high=0x8000000000000100n;
  const b=ir([store(high,2,val('word',16,0x1234)),store(high+1n,1,val('part',8,0xab))]);
  const a=ir([store(high,1,val('lo',8,0x34)),store(high+1n,1,val('hi',8,0xab))]);
  const memory={addressBits:64,wrapping:'reject'};
  const r=await query(b,a,{memory});assert.equal(r.eligible,true,r.reason);
  assert.equal(r.scope.proofMode,'concrete-writes');assert.deepEqual(r.scope.observedAddresses,[high,high+1n]);
  assert.equal(S.isAdoptableMemoryEquivalence(r,{identity,beforeIr:b,afterIr:a,preconditions:[],inputs:[],memory}),true);
  a.instructions[0].args[0].value.const=0x35n;
  const no=await query(b,a,{memory});assert.equal(no.verdict,'refuted',no.reason);assert.equal(no.firstDivergence.address,high);
});
test('footprint includes writes present on only one side and wrapped bytes, retaining unknown initial memory',async()=>{
  const high=(1n<<64n)-1n;
  const b=ir([store(high,2,val('word',16,0x1234))]);
  const a=ir([store(high,1,val('last',8,0x34)),store(0n,1,val('first',8,0x12))]);
  assert.equal((await query(b,a,{memory:{addressBits:64,wrapping:'modular'}})).eligible,true);
  const r=await query(ir([]),ir([store(high,1,val('zero',8,0))]),{memory:{addressBits:64,wrapping:'reject'}});
  assert.equal(r.verdict,'refuted',r.reason);assert.equal(r.firstDivergence.address,high);
});
test('symbolic writes cannot be mistaken for a finite concrete footprint',async()=>{
  const b=symbolicStoreFixture(),a=symbolicStoreFixture();
  const r=await query(b.program,a.program,{inputs:[{before:b.p,after:a.p},{before:b.q,after:a.q}],memory:{...config.memory,proofMode:'concrete-writes'}});
  assert.equal(r.eligible,false);assert.match(r.reason,/symbolic-write-footprint/);assert.equal(r.evidence,null);
});
test('mutating fault observables inside an existing descriptor invalidates a prior proof',async()=>{
  const b=ir([store(0n,1,val('one',8,1))]),a=ir([store(0n,1,val('one',8,1))]),faults=[];
  b.instructions[0].extra={memoryAccess:{widthBits:8,addressSpace:identity.addressSpace,endian:'little',volatility:false,atomic:false,ordering:'none',faults}};
  const r=await query(b,a);assert.equal(r.eligible,true,r.reason);
  faults.push('data-abort');
  assert.equal(S.isAdoptableMemoryEquivalence(r,{identity,beforeIr:b,afterIr:a,memory:config.memory,inputs:[],preconditions:[]}),false);
});

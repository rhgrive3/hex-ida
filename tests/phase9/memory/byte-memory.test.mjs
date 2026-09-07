import test from 'node:test';
import assert from 'node:assert/strict';
import { createByteMemory, joinByteMemory } from '../../../js/symbolic/memory/byte-memory.js';
import * as E from '../../../js/symbolic/expr/index.js';
export const identity=Object.freeze({queryId:'m-test',snapshotId:'s1',binaryId:'b',functionId:'f',architecture:'generic',addressSpace:'data',semanticsVersion:'2'});
const mem=(options={})=>createByteMemory({identity,...options});
const value=(r,env)=>{assert.ok(r.expression,r.reason);const e=E.evaluateExpr(r.expression,env);assert.equal(e.status,'value');return e.value;};
for(const endian of ['little','big']) for(const size of [1,2,4,8]) {
  test(`byte memory: ${endian} ${size} byte parity and partial overwrite`,()=>{
    const m=mem({endian});const n=BigInt.asUintN(size*8,0xfedcba9876543210n);
    assert.equal(m.store(0x100n,size,n).status,'stored');assert.equal(value(m.load(0x100n,size)),n);
    const i=size-1;m.store(0x100n+BigInt(i),1,0xaan);
    const shift=BigInt((endian==='little'?i:size-1-i)*8);
    const expected=(n&~(255n<<shift))|(0xaan<<shift);
    assert.equal(value(m.load(0x100n,size)),expected);
  });
}
test('escalation preserves old bytes, prior reads, and write order',()=>{
  const m=mem({addressBits:8});m.store(4n,2,0x1234n);const before=m.load(4n,2);
  const p=E.createFreshSymbol(E.bvSort(8),'p');m.store(p,1,0xeen);
  assert.equal(value(before),0x1234n);
  for(const a of [4n,5n,6n]) assert.equal(value(m.load(4n,2),{[p.symbolId]:a}),a===4n?0x12een:a===5n?0xee34n:0x1234n);
  m.store(4n,1,0x77n);assert.equal(value(m.load(4n,1),{[p.symbolId]:4n}),0x77n);
});
test('unknown initial bytes form one function, not zero or independent symbols',()=>{
  const m=mem({addressBits:2}),p=E.createFreshSymbol(E.bvSort(2),'p'),q=E.createFreshSymbol(E.bvSort(2),'q');
  const a=m.load(p,1),same=m.load(p,1),b=m.load(q,1);
  assert.equal(a.expression,same.expression);
  assert.equal(E.evaluateExpr(a.expression).status,'unbound_symbol');
  const syms=[];const walk=n=>{if(n.kind==='fresh_symbol'&&n.meta?.source==='initial-byte')syms.push(n);for(const k of ['arg','left','right','cond','thenExpr','elseExpr'])if(n[k])walk(n[k]);};walk(b.expression);
  const env={[p.symbolId]:2n,[q.symbolId]:2n};for(const s of syms)env[s.symbolId]=s.name==='mem_0'?43n:199n;
  assert.equal(value(a,env),43n);assert.equal(value(b,env),43n);
});
test('equal printed symbol names are NOT MustAlias',()=>{
  const m=mem({addressBits:2,initialBytes:[[0n,1n],[1n,2n],[2n,3n],[3n,4n]]});
  const p=E.createFreshSymbol(E.bvSort(2),'same'),q=E.createFreshSymbol(E.bvSort(2),'same');
  m.store(p,1,9n);assert.equal(value(m.load(q,1),{[p.symbolId]:0n,[q.symbolId]:1n}),2n);
});
test('64-bit BigInt addresses and explicit modular wrap',()=>{
  const high=0xffffffffffffffffn,m=mem({wrapping:'modular'});
  assert.equal(m.store(high,2,0xbbaan).status,'stored');
  assert.equal(value(m.load(high,1)),0xaan);assert.equal(value(m.load(0n,1)),0xbbn);
  assert.equal(value(m.load(high,2)),0xbbaan);
  assert.equal(mem().store(high,2,1n).status,'unknown');
  assert.equal(mem().store(Number(high),1,1n).reason,'unsafe-integer');
  assert.equal(mem().load(1n<<64n,1).reason,'address-out-of-range');
});
test('width/sort/alignment/space and malformed canonical lookalikes fail closed',()=>{
  assert.equal(mem().store(0n,1,E.createBv(16,1n)).reason,'width-mismatch');
  assert.equal(mem().load(E.createBool(true),1).reason,'width-mismatch');
  assert.equal(mem({alignment:'natural'}).load(1n,2).reason,'alignment-unproved');
  assert.equal(mem().load(0n,1,{addressSpace:'other'}).reason,'address-space-mismatch');
  const forged=Object.freeze({kind:'const',sort:E.bvSort(8),value:999n});
  assert.equal(mem().store(0n,1,forged).status,'unknown');
});
for(const reason of ['unknown-clobber','unknown-call','may-alias-clobber'])test(`barrier: ${reason}`,()=>{
  const m=mem();m.store(0n,1,1n);m.barrier(reason);assert.equal(m.load(0n,1).reason,reason);
});
for(const flag of ['volatile','atomic'])test(`barrier: ${flag}`,()=>{
  const m=mem();m.store(0n,1,1n);assert.equal(m.load(0n,1,{[flag]:true}).status,'unknown');assert.equal(m.load(0n,1).status,'unknown');
});
test('fork/join isolates writes and correlates initial unknown reads across paths',()=>{
  const root=mem({addressBits:8});root.store(0n,1,7n);
  const yes=root.fork(),no=root.fork();yes.store(0n,1,8n);no.store(0n,1,9n);
  assert.equal(value(root.load(0n,1)),7n);
  const cond=E.createFreshSymbol(E.boolSort(),'c');const join=joinByteMemory(cond,yes,no);
  yes.store(0n,1,123n);
  assert.equal(value(join.load(0n,1),{[cond.symbolId]:true}),8n);assert.equal(value(join.load(0n,1),{[cond.symbolId]:false}),9n);
  const a=yes.load(22n,1),b=no.load(22n,1);assert.equal(a.expression,b.expression);
  assert.throws(()=>joinByteMemory(cond,yes,mem({addressBits:8})),/unrelated/);
});
test('identity, mutation, cancellation and deadline cannot publish values',()=>{
  const stale={...identity,snapshotId:'s2'};let current=identity;
  const m=mem({getCurrentIdentity:()=>current});m.store(0n,1,1n);current=stale;
  assert.equal(m.load(0n,1,{identity}).reason,'stale-identity');
  const c=new AbortController(),a=mem({signal:c.signal});c.abort();assert.equal(a.load(0n,1).reason,'cancelled');
  let now=0;const d=mem({now:()=>now,timeoutMs:1});now=1;assert.equal(d.load(0n,1).reason,'deadline');
  const r=mem().load(0n,1);assert.ok(Object.isFrozen(r));assert.ok(Object.isFrozen(r.bytes));assert.ok(Object.isFrozen(r.expression));
});
for(const [budget,action] of [
  ['concreteMemoryBytes',m=>m.store(0n,1,1n)],
  ['storeHistoryEntries',m=>m.store(0n,1,1n)],
  ['symbolicMemoryCells',m=>m.load(0n,1)],
  ['aliasForks',m=>m.fork()],
]) test(`budget N-1/N/N+1: ${budget}`,()=>{
  for(const n of [0,1,2]) {
    const m=mem({limits:{[budget]:n}});
    for(let i=0;i<n;i++) {
      const result=budget==='concreteMemoryBytes'?m.store(BigInt(i),1,1n):budget==='symbolicMemoryCells'?m.load(BigInt(i),1):action(m);
      assert.notEqual(result?.status,'unknown');
    }
    if(budget==='aliasForks')assert.throws(()=>m.fork(),/budget/);
    else {const r=budget==='concreteMemoryBytes'?m.store(BigInt(n),1,1n):budget==='symbolicMemoryCells'?m.load(BigInt(n),1):action(m);assert.equal(r.status,'unknown');assert.equal(r.expression,null);}
  }
});
test('zero work/allocation and cancellation during actual byte processing',()=>{
  assert.equal(mem({limits:{workItems:0}}).load(0n,1).status,'unknown');
  assert.equal(mem({limits:{allocationUnits:0}}).store(0n,1,1n).status,'unknown');
  let checks=0;const m=mem({isCancelled:()=>++checks>12});const r=m.store(0n,8,E.createFreshSymbol(E.bvSort(64),'v'));
  assert.equal(r.status,'unknown');assert.equal(r.expression,null);assert.ok(checks>12);
});
test('independent finite byte oracle: exhaustive aliases, endians, partial writes and wrap',()=>{
  let observations=0;
  for(const endian of ['little','big'])for(const size of [1,2]) {
    const initial=[3,77,149,251];
    const m=mem({addressBits:2,wrapping:'modular',endian,initialBytes:initial.map((v,i)=>[BigInt(i),BigInt(v)])});
    const p=E.createFreshSymbol(E.bvSort(2),'p'),q=E.createFreshSymbol(E.bvSort(2),'q'),r=E.createFreshSymbol(E.bvSort(2),'r');
    m.store(p,2,0xabcdn);m.store(q,1,0x66n);const got=m.load(r,size);
    for(let a=0;a<4;a++)for(let b=0;b<4;b++)for(let c=0;c<4;c++) {
      const oracle=initial.slice();
      oracle[a]=endian==='little'?0xcd:0xab;oracle[(a+1)%4]=endian==='little'?0xab:0xcd;oracle[b]=0x66;
      let expected=0n;
      for(let lane=0;lane<size;lane++) expected|=BigInt(oracle[(c+lane)%4])<<BigInt(8*(endian==='little'?lane:size-1-lane));
      assert.equal(value(got,{[p.symbolId]:BigInt(a),[q.symbolId]:BigInt(b),[r.symbolId]:BigInt(c)}),expected);observations++;
    }
  }
  assert.equal(observations,256);
});

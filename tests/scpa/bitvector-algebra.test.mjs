import test from 'node:test';import assert from 'node:assert/strict';
import {expr} from '../../js/decompiler/ast/nodes.js';
import {checkBitvectorViewRelation as check} from '../../js/core/evidence/bv-view-proof.js';
import {workFor} from './helpers.mjs';
const v=(n='x',bits=8)=>expr.variable(n,bits,false),c=(n,bits=8)=>expr.constant(BigInt(n),bits,false);
const b=(op,a,d)=>expr.binary(op,a,d,a.bits,false);
for(const bits of [1,8,16,32,64,128]) {
 test(`${bits}-bit modular association and cancellation do not use Number arithmetic`,()=>{const x=v('x',bits),y=v('y',bits),k=c(1,bits),two=c(2,bits);
   for(const [a,z] of [[b('+',b('+',x,k),k),b('+',x,two)],[b('-',b('+',x,y),y),x],[b('+',x,y),b('+',y,x)],[b('-',x,x),c(0,bits)],[b('+',x,c((1n<<BigInt(bits))-1n,bits)),b('-',x,k)]])assert.equal(check(a,z).status,'verified');
   assert.notEqual(check(b('+',x,k),x).status,'verified');
 });
 test(`${bits}-bit Boolean masks association xor parity`,()=>{const x=v('x',bits),y=v('y',bits),z=c(0,bits),all=c(-1,bits);
   for(const [a,d] of [[b('&',x,all),x],[b('|',x,z),x],[b('^',x,x),z],[b('&',x,x),x],[b('|',x,x),x],[b('^',b('^',x,y),y),x],[b('&',b('&',x,y),x),b('&',y,x)]])assert.equal(check(a,d).status,'verified');
 });
}
test('independent concrete evaluation checks all admitted pairs over a deterministic small-width corpus',t=>{
  let seed=781;const rand=n=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)%n;const bits=3,mask=7n;
  const expressions=[v('x',bits),v('y',bits),c(0,bits),c(1,bits),c(7,bits)];
  for(let i=0;i<40;i++)expressions.push(b(['+','-','&','|','^'][rand(5)],expressions[rand(expressions.length)],expressions[rand(expressions.length)]));
  const evalAt=(e,x,y)=> e.kind==='var'?(e.name==='x'?x:y):e.kind==='const'?e.value&mask:((a,z)=>({'+' :()=>a+z,'-':()=>a-z,'&':()=>a&z,'|':()=>a|z,'^':()=>a^z}[e.op]())&mask)(evalAt(e.left,x,y),evalAt(e.right,x,y));
  const work=workFor(t,{workUnits:1000000,residentBytes:128*1024*1024});let admitted=0;
  for(const a of expressions)for(const d of expressions){if(check(a,d,{work}).status!=='verified')continue;admitted++;for(let x=0n;x<8n;x++)for(let y=0n;y<8n;y++)assert.equal(evalAt(a,x,y),evalAt(d,x,y));}
  assert.ok(admitted>45);
});
test('algebra does not remove two identical-looking volatile reads',()=>{const l=()=>expr.load({key:'p'},8,null,{signed:false,volatile:true});assert.notEqual(check(b('^',l(),l()),c(0),{allowMemory:true}).status,'verified');});
test('load addition commutativity does not authorize load reordering',()=>{const l=n=>expr.load({key:n},8,null,{signed:false});assert.notEqual(check(b('+',l('a'),l('b')),b('+',l('b'),l('a')),{allowMemory:true}).status,'verified');});
test('effect extensions and trap flags remain unqualified',()=>{const a=b('+',v(),c(0)),d=v();a.flags='NZCV';assert.notEqual(check(a,d).status,'verified');});

test('normal-form growth is independently bounded even without an external work object',()=>{
  const variable=i=>({kind:'var',name:`large-v-${i}`,bits:128,signed:false,effect:'pure'});
  const combine=(a,b)=>({kind:'binary',op:'and',left:a,right:b,bits:128,signed:false,effect:'pure'});
  let level=Array.from({length:256},(_,i)=>variable(i));
  while(level.length>1)level=Array.from({length:level.length/2},(_,i)=>combine(level[2*i],level[2*i+1]));
  const r=check(level[0],level[0]);assert.equal(r.status,'unknown');assert.equal(r.reason,'expression-normal-form-budget');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as candidate from '../../js/core/identity/fnv64.js';
import * as oracle from '../helpers/refinement-baseline/js/core/identity/fnv64.js';
const fill=n=>Uint8Array.from({length:n},(_,i)=>(i*179+i%31)&255);
function result(fn) {try{return {ok:true,value:fn()};}catch(e){return {ok:false,name:e.name,message:e.message};}}
function compare(make,seeds=[]) {assert.deepStrictEqual(result(()=>candidate.fnv64Bytes(make(),...seeds)),result(()=>oracle.fnv64Bytes(make(),...seeds)));}
test('refinement: indexed bytes match iterator oracle at all threshold boundaries and seeds',()=>{
 for(const n of [0,1,32,4095,4096,4097,8192,131071]) for(const seeds of [[],[0,0],[0xffffffff,0xffffffff],[17,12345]]) compare(()=>fill(n),seeds);
});
test('refinement: sliced buffers and nonzero byte offsets hash only the view',()=>{
 const b=fill(10000); for(const [start,end]of [[1,9999],[500,8193],[999,5095]]) compare(()=>b.subarray(start,end));
});
test('refinement: custom iterators, getter order and IteratorClose are preserved',()=>{
 for(const kind of ['own','getter','invalid','throw']) {
  function make(log) {const b=fill(8192); const it=function*(){try{log.push('iter');yield 7;if(kind==='throw')throw new Error('iteration');yield kind==='invalid'?256:8;}finally{log.push('closed');}};
   if(kind==='getter')Object.defineProperty(b,Symbol.iterator,{get(){log.push('getter');return it;}});else b[Symbol.iterator]=it;return b;}
  const a=[],b=[];assert.deepEqual(result(()=>candidate.fnv64Bytes(make(a))),result(()=>oracle.fnv64Bytes(make(b))));assert.deepEqual(a,b);
 }
});
test('refinement: shadowed length and buffer properties are not consulted by hashing',()=>{
 const make=()=>{const b=fill(8192);Object.defineProperties(b,{length:{get(){throw new Error('length accessed');}},buffer:{get(){throw new Error('buffer accessed');}}});return b;};compare(make);
});
test('refinement: cross-realm views, subclasses, Buffer, proxies and ordinary iterables use compatible paths',()=>{
 compare(()=>vm.runInNewContext('new Uint8Array(8192).fill(173)'));
 class Bytes extends Uint8Array {} compare(()=>new Bytes(8192).fill(3));compare(()=>Buffer.alloc(8192,3));
 compare(()=>new Proxy(fill(8192),{})); compare(()=>[0,1,255]);compare(()=>new Set([1,2,255]));compare(()=>({*[Symbol.iterator](){yield 0;yield 9;}}));
});
test('refinement: detached, resizable, shared and empty buffers retain iterator behavior',()=>{
 compare(()=>{const b=fill(8192);structuredClone(b.buffer,{transfer:[b.buffer]});return b;});
 if(typeof SharedArrayBuffer==='function')compare(()=>new Uint8Array(new SharedArrayBuffer(8192)).fill(11));
 if(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')) {
  compare(()=>new Uint8Array(new ArrayBuffer(8192,{maxByteLength:16384})).fill(5));
  compare(()=>{const b=new ArrayBuffer(8192,{maxByteLength:16384});const v=new Uint8Array(b,4096,4096);b.resize(1024);return v;});
 }
});
test('refinement: replaced iterator next and Math.imul remain observable',()=>{
 const proto=Object.getPrototypeOf(new Uint8Array()[Symbol.iterator]());const next=proto.next;
 try {proto.next=function(){const r=next.call(this);return r.done?r:{done:false,value:(r.value+1)&255};};compare(()=>fill(8192));} finally{proto.next=next;}
 const mul=Math.imul;
 try {Math.imul=(a,b)=>mul(a,b)^1;compare(()=>fill(8192));} finally{Math.imul=mul;}
});
test('refinement: invalid seeds fail before inspecting iterable',()=>{
 for(const s of [[-1,0],[0,0x100000000],[NaN,0],[1.5,2],[0n,0]])compare(()=>({get [Symbol.iterator](){throw new Error('too late');}}),s);
});

test('refinement: text digest preserves UTF-16 and both initial states across boundary sizes',()=>{
 for(const n of [0,1,8,32,128,255,256,257,4096])for(const unit of ['a','é','\ud800','\udc00']){
  const text=unit.repeat(n);assert.equal(candidate.fnv64TextDigest(text),oracle.fnv64Text(text)+oracle.fnv64Text(text,0xcbf29ce4,0x84222325));
 }
});

test('refinement: buffer eligibility does not execute Symbol.hasInstance hooks',()=>{
 const prior=Object.getOwnPropertyDescriptor(ArrayBuffer,Symbol.hasInstance);
 try {Object.defineProperty(ArrayBuffer,Symbol.hasInstance,{configurable:true,value(){throw new Error('unexpected instanceof');}});compare(()=>fill(8192));}
 finally {if(prior)Object.defineProperty(ArrayBuffer,Symbol.hasInstance,prior);else delete ArrayBuffer[Symbol.hasInstance];}
});

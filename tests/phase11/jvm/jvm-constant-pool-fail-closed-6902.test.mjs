import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';

const u2=(out,x)=>out.push((x>>>8)&255,x&255);
const u4=(out,x)=>out.push((x>>>24)&255,(x>>>16)&255,(x>>>8)&255,x&255);
const utf8=(text)=>{const out=[1];const bytes=[...Buffer.from(text,'utf8')];u2(out,bytes.length);out.push(...bytes);return out;};
const cpClass=(index)=>[7,(index>>>8)&255,index&255];
const cpNameAndType=(name,descriptor)=>[12,(name>>>8)&255,name&255,(descriptor>>>8)&255,descriptor&255];
const cpMethodref=(owner,nat)=>[10,(owner>>>8)&255,owner&255,(nat>>>8)&255,nat&255];
const cpMethodHandle=(kind,index)=>[15,kind,(index>>>8)&255,index&255];
function buildClass(entries,{major=52,classAttributes=[]}={}){
  const out=[];u4(out,0xcafebabe);u2(out,0);u2(out,major);u2(out,entries.length+1);
  for(const entry of entries)out.push(...entry);
  u2(out,0x0021);u2(out,2);u2(out,4);u2(out,0);u2(out,0);u2(out,0);u2(out,classAttributes.length);
  for(const {nameIndex,payload} of classAttributes){u2(out,nameIndex);u4(out,payload.length);out.push(...payload);}
  return Uint8Array.from(out);
}
function bootstrapPayload(methodRef,args=[]){const out=[];u2(out,1);u2(out,methodRef);u2(out,args.length);for(const arg of args)u2(out,arg);return out;}
const base=[utf8('A'),cpClass(1),utf8('java/lang/Object'),cpClass(3)];

// Even an unreferenced CONSTANT_NameAndType must not carry an impossible descriptor.
assert.throws(()=>parseJvm(buildClass([...base,utf8('orphan'),utf8('Q'),cpNameAndType(5,6)])),/jvm-invalid-cp-nameandtype-descriptor/);
assert.doesNotThrow(()=>parseJvm(buildClass([...base,utf8('orphan'),utf8('I'),cpNameAndType(5,6)])));
assert.doesNotThrow(()=>parseJvm(buildClass([...base,utf8('orphan'),utf8('()V'),cpNameAndType(5,6)])));

// REF_newInvokeSpecial may only target a void-returning constructor.
function constructorFixture(descriptor){return [...base,utf8('<init>'),utf8(descriptor),cpNameAndType(5,6),cpMethodref(2,7),cpMethodHandle(8,8)];}
assert.throws(()=>parseJvm(buildClass(constructorFixture('()I'))),/jvm-invalid-cp-methodhandle-constructor-descriptor/);
assert.doesNotThrow(()=>parseJvm(buildClass(constructorFixture('()V'))));

// BootstrapMethods references are typed: MethodHandle target + loadable constants only.
const bootstrapEntries=[...base,utf8('bootstrap'),utf8('()V'),cpNameAndType(5,6),cpMethodref(2,7),cpMethodHandle(6,8),utf8('BootstrapMethods')];
assert.throws(()=>parseJvm(buildClass(bootstrapEntries,{classAttributes:[{nameIndex:10,payload:bootstrapPayload(8)}]})),/jvm-invalid-bootstrap-method-ref/);
assert.throws(()=>parseJvm(buildClass(bootstrapEntries,{classAttributes:[{nameIndex:10,payload:bootstrapPayload(9,[7])}]})),/jvm-invalid-bootstrap-argument/);
assert.doesNotThrow(()=>parseJvm(buildClass(bootstrapEntries,{classAttributes:[{nameIndex:10,payload:bootstrapPayload(9,[2])}]})));

console.log('jvm parser fail-closed #6902: PASS');

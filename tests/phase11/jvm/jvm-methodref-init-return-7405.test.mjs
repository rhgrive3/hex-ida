import assert from 'node:assert/strict';
import { parseJvm, probeJvm } from '../../../js/managed/jvm/parser.js';
import { parseJvm as parseJvmCore } from '../../../js/managed/jvm/parser-core.js';

// #7405 — JVMS §4.4.2: a CONSTANT_Methodref_info name beginning with '<'
// must be <init>, and its descriptor must return void. The JVM rejects
// violators with ClassFormatError even when the entry is never referenced.

const u2=(out,x)=>out.push((x>>>8)&255,x&255);
const u4=(out,x)=>out.push((x>>>24)&255,(x>>>16)&255,(x>>>8)&255,x&255);
const utf8=(text)=>{const out=[1];const bytes=[...Buffer.from(text,'utf8')];u2(out,bytes.length);out.push(...bytes);return out;};
const cpClass=(index)=>[7,(index>>>8)&255,index&255];
const cpNameAndType=(name,descriptor)=>[12,(name>>>8)&255,name&255,(descriptor>>>8)&255,descriptor&255];
const cpMethodref=(owner,nat)=>[10,(owner>>>8)&255,owner&255,(nat>>>8)&255,nat&255];
const cpInterfaceMethodref=(owner,nat)=>[11,(owner>>>8)&255,owner&255,(nat>>>8)&255,nat&255];

function buildClass(entries,{major=61}={}){
  const out=[];u4(out,0xcafebabe);u2(out,0);u2(out,major);u2(out,entries.length+1);
  for(const entry of entries)out.push(...entry);
  u2(out,0x0021);u2(out,2);u2(out,4);u2(out,0);u2(out,0);u2(out,0);u2(out,0);
  return Uint8Array.from(out);
}

const base=[utf8('T'),cpClass(1),utf8('java/lang/Object'),cpClass(3)];

function methodrefFixture(name,descriptor){
  return [...base,utf8(name),utf8(descriptor),cpNameAndType(5,6),cpMethodref(2,7)];
}

// An unused <init>:()I Methodref is JVM-invalid and must fail closed.
assert.throws(()=>parseJvm(buildClass(methodrefFixture('<init>','()I'))),/jvm-invalid-cp-methodref-init-return-type/);
// Same rule from the core parser: it is a constant-pool invariant, not a
// post-parse closure detail.
assert.throws(()=>parseJvmCore(buildClass(methodrefFixture('<init>','()I'))),/jvm-invalid-cp-methodref-init-return-type/);
// <init> may never return anything but void.
assert.throws(()=>parseJvm(buildClass(methodrefFixture('<init>','()Ljava/lang/String;'))),/jvm-invalid-cp-methodref-init-return-type/);
// <clinit> is not a valid Methodref name: '<'-prefixed Methodref names must be <init>.
assert.throws(()=>parseJvm(buildClass(methodrefFixture('<clinit>','()V'))),/jvm-invalid-cp-memberref-name/);
// The same fail-closed rule covers arbitrary unused '<'-prefixed Methodref names.
assert.throws(()=>parseJvm(buildClass(methodrefFixture('<other>','()V'))),/jvm-invalid-cp-memberref-name/);
// void <init> and ordinary method references keep parsing.
assert.doesNotThrow(()=>parseJvm(buildClass(methodrefFixture('<init>','()V'))));
assert.doesNotThrow(()=>parseJvm(buildClass(methodrefFixture('run','()V'))));
// InterfaceMethodref has no load-time special-name provision (JVMS §4.4.3);
// the same entries must keep parsing there.
const ifaceFixture=(name,descriptor)=>[...base,utf8(name),utf8(descriptor),cpNameAndType(5,6),cpInterfaceMethodref(2,7)];
assert.doesNotThrow(()=>parseJvm(buildClass(ifaceFixture('<init>','()I'))));
assert.doesNotThrow(()=>parseJvm(buildClass(ifaceFixture('run','()V'))));

assert.equal(probeJvm(buildClass(methodrefFixture('<init>','()V'))).supported, true);

console.log('jvm methodref <init> return type #7405: PASS');

import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';

const u2=(out,x)=>out.push((x>>>8)&255,x&255);
const u4=(out,x)=>out.push((x>>>24)&255,(x>>>16)&255,(x>>>8)&255,x&255);
const utf8=(text)=>{const out=[1];const bytes=[...Buffer.from(text,'utf8')];u2(out,bytes.length);out.push(...bytes);return out;};
const cpClass=(index)=>[7,(index>>>8)&255,index&255];
const cpNameAndType=(name,descriptor)=>[12,(name>>>8)&255,name&255,(descriptor>>>8)&255,descriptor&255];
const cpFieldref=(owner,nat)=>[9,(owner>>>8)&255,owner&255,(nat>>>8)&255,nat&255];
const cpMethodref=(owner,nat)=>[10,(owner>>>8)&255,owner&255,(nat>>>8)&255,nat&255];
const cpMethodHandle=(kind,index)=>[15,kind,(index>>>8)&255,index&255];
const cpMethodType=(descriptor)=>[16,(descriptor>>>8)&255,descriptor&255];
const cpDynamic=(tag,bootstrap,nat)=>[tag,(bootstrap>>>8)&255,bootstrap&255,(nat>>>8)&255,nat&255];
const cpModule=(tag,name)=>[tag,(name>>>8)&255,name&255];

function buildClass(entries,{major=52,accessFlags=0x0021,classAttributes=[]}={}){
  const out=[];u4(out,0xcafebabe);u2(out,0);u2(out,major);
  let slots=1;for(const entry of entries)slots+=entry[0]===5||entry[0]===6?2:1;u2(out,slots);
  for(const entry of entries)out.push(...entry);
  u2(out,accessFlags);u2(out,2);u2(out,4);u2(out,0);u2(out,0);u2(out,0);u2(out,classAttributes.length);
  for(const {nameIndex,payload} of classAttributes){u2(out,nameIndex);u4(out,payload.length);out.push(...payload);}
  return Uint8Array.from(out);
}

function bootstrapPayload(methodRef){const out=[];u2(out,1);u2(out,methodRef);u2(out,0);return out;}
const base=[utf8('A'),cpClass(1),utf8('java/lang/Object'),cpClass(3)];

// JVM-introduced minimum class-file versions.
assert.throws(()=>parseJvm(buildClass([...base,cpMethodHandle(1,0)],{major:50})),/jvm-invalid-cp-tag-version-15/);
assert.throws(()=>parseJvm(buildClass([...base,cpMethodType(0)],{major:50})),/jvm-invalid-cp-tag-version-16/);
assert.throws(()=>parseJvm(buildClass([...base,cpDynamic(18,0,0)],{major:50})),/jvm-invalid-cp-tag-version-18/);
assert.throws(()=>parseJvm(buildClass([...base,cpModule(19,0)],{major:52})),/jvm-invalid-cp-tag-version-19/);
assert.throws(()=>parseJvm(buildClass([...base,cpModule(20,0)],{major:52})),/jvm-invalid-cp-tag-version-20/);
assert.throws(()=>parseJvm(buildClass([...base,cpDynamic(17,0,0)],{major:54})),/jvm-invalid-cp-tag-version-17/);

// Descriptor grammar is contextual to the CP entry kind.
assert.throws(()=>parseJvm(buildClass([...base,utf8('f'),utf8('()V'),cpNameAndType(5,6),cpFieldref(2,7)])),/jvm-invalid-field-descriptor/);
assert.throws(()=>parseJvm(buildClass([...base,utf8('m'),utf8('I'),cpNameAndType(5,6),cpMethodref(2,7)])),/jvm-invalid-method-descriptor/);
assert.throws(()=>parseJvm(buildClass([...base,utf8('I'),cpMethodType(5)])),/jvm-invalid-method-descriptor/);
assert.throws(()=>parseJvm(buildClass([...base,utf8('d'),utf8('()V'),cpNameAndType(5,6),cpDynamic(17,0,7)],{major:55})),/jvm-invalid-field-descriptor/);
assert.throws(()=>parseJvm(buildClass([...base,utf8('d'),utf8('I'),cpNameAndType(5,6),cpDynamic(18,0,7)],{major:51})),/jvm-invalid-method-descriptor/);

// BootstrapMethods must exist and contain every Dynamic/InvokeDynamic index.
function dynamicFixture(tag,descriptor,bootstrapIndex=0){
  const entries=[...base,utf8('bootstrap'),utf8('()V'),cpNameAndType(5,6),cpMethodref(2,7),cpMethodHandle(6,8),utf8('BootstrapMethods'),utf8('dyn'),utf8(descriptor),cpNameAndType(11,12),cpDynamic(tag,bootstrapIndex,13)];
  return {entries,attribute:{nameIndex:10,payload:bootstrapPayload(9)}};
}
{
  const {entries,attribute}=dynamicFixture(17,'I');
  assert.throws(()=>parseJvm(buildClass(entries,{major:55})),/jvm-invalid-cp-bootstrap-method-index/);
  assert.throws(()=>parseJvm(buildClass(dynamicFixture(17,'I',1).entries,{major:55,classAttributes:[attribute]})),/jvm-invalid-cp-bootstrap-method-index/);
  assert.doesNotThrow(()=>parseJvm(buildClass(entries,{major:55,classAttributes:[attribute]})));
}
{
  const {entries,attribute}=dynamicFixture(18,'()V');
  assert.doesNotThrow(()=>parseJvm(buildClass(entries,{major:51,classAttributes:[attribute]})));
}

// Module/Package constants require ACC_MODULE.
for(const tag of [19,20]){
  const entries=[...base,utf8(tag===19?'m':'p'),cpModule(tag,5)];
  assert.throws(()=>parseJvm(buildClass(entries,{major:53})),/jvm-invalid-cp-module-context/);
  assert.doesNotThrow(()=>parseJvm(buildClass(entries,{major:53,accessFlags:0x8000})));
}

// Boundary-positive MethodType at Java 7 / class 51.
assert.doesNotThrow(()=>parseJvm(buildClass([...base,utf8('()V'),cpMethodType(5)],{major:51})));

console.log('PR #6902 review regressions: PASS');

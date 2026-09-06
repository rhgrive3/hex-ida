import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';

const u1=(out,x)=>out.push(x&255);
const u2=(out,x)=>out.push((x>>>8)&255,x&255);
const u4=(out,x)=>out.push((x>>>24)&255,(x>>>16)&255,(x>>>8)&255,x&255);
const utf8=(text)=>{const out=[1];const bytes=[...Buffer.from(text,'utf8')];u2(out,bytes.length);out.push(...bytes);return out;};
const cpClass=(index)=>[7,(index>>>8)&255,index&255];
const cpString=(index)=>[8,(index>>>8)&255,index&255];
const cpNameAndType=(name,descriptor)=>[12,(name>>>8)&255,name&255,(descriptor>>>8)&255,descriptor&255];
const cpFieldref=(owner,nat)=>[9,(owner>>>8)&255,owner&255,(nat>>>8)&255,nat&255];
const cpMethodref=(owner,nat)=>[10,(owner>>>8)&255,owner&255,(nat>>>8)&255,nat&255];
const cpMethodHandle=(kind,index)=>[15,kind,(index>>>8)&255,index&255];
const cpMethodType=(descriptor)=>[16,(descriptor>>>8)&255,descriptor&255];
const cpDynamic=(tag,bootstrap,nat)=>[tag,(bootstrap>>>8)&255,bootstrap&255,(nat>>>8)&255,nat&255];
const cpModule=(tag,name)=>[tag,(name>>>8)&255,name&255];
const cpInteger=(value=0)=>{const out=[3];u4(out,value>>>0);return out;};
const cpLong=(value=0n)=>{const out=[5];for(let shift=56n;shift>=0n;shift-=8n)out.push(Number((value>>shift)&255n));return out;};

function buildClass(entries,{major=52}={}){
  const out=[];u4(out,0xcafebabe);u2(out,0);u2(out,major);
  let slots=1;for(const entry of entries)slots+=entry[0]===5||entry[0]===6?2:1;u2(out,slots);
  for(const entry of entries)out.push(...entry);
  u2(out,0x0021);u2(out,2);u2(out,4);u2(out,0);u2(out,0);u2(out,0);u2(out,0);
  return Uint8Array.from(out);
}

const base=[utf8('A'),cpClass(1),utf8('java/lang/Object'),cpClass(3)];
const mustReject=(entries,pattern=/jvm-invalid-cp-/)=>assert.throws(()=>parseJvm(buildClass(entries)),pattern);

mustReject([...base,cpString(0)]);
mustReject([...base,cpInteger(),cpClass(5)]);
mustReject([...base,utf8('x'),utf8('I'),cpNameAndType(5,6),cpFieldref(1,7)]);
mustReject([...base,utf8('x'),cpClass(5),cpNameAndType(5,6)]);
mustReject([...base,cpLong(),cpString(6)]);
mustReject([...base,cpMethodHandle(0,2)]);
mustReject([...base,cpMethodHandle(1,2)]);
mustReject([...base,utf8('run'),utf8('()V'),cpNameAndType(5,6),cpMethodref(2,7),cpMethodHandle(8,8)],/jvm-invalid-cp-methodhandle-target-name/);
mustReject([...base,utf8('<init>'),utf8('()V'),cpNameAndType(5,6),cpMethodref(2,7),cpMethodHandle(5,8)],/jvm-invalid-cp-methodhandle-target-name/);
mustReject([...base,utf8('<clinit>'),utf8('()V'),cpNameAndType(5,6),cpMethodref(2,7),cpMethodHandle(6,8)],/jvm-invalid-cp-methodhandle-target-name/);
mustReject([...base,cpMethodType(0)]);
mustReject([...base,cpDynamic(17,0,0)]);
mustReject([...base,cpDynamic(18,0,0)]);
mustReject([...base,cpModule(19,0)]);
mustReject([...base,cpModule(20,0)]);

for(const [name,kind] of [['run',5],['<init>',8]]){
  const validHandle=[...base,utf8(name),utf8('()V'),cpNameAndType(5,6),cpMethodref(2,7),cpMethodHandle(kind,8)];
  assert.doesNotThrow(()=>parseJvm(buildClass(validHandle)),`valid MethodHandle kind ${kind} target name ${name}`);
}

const valid=[
  ...base,
  cpString(6),utf8('forward'),
  utf8('field'),utf8('I'),cpNameAndType(7,8),cpFieldref(2,9),
  cpMethodHandle(1,10),utf8('()V'),cpMethodType(12),
];
const parsed=parseJvm(buildClass(valid));
assert.equal(parsed.constantPool[5].stringIndex,6,'forward CP references must remain valid');
assert.deepEqual(parsed.constantPool[11],{tag:15,referenceKind:1,referenceIndex:10});
assert.deepEqual(parsed.constantPool[13],{tag:16,descriptorIndex:12});

console.log('jvm constant-pool references #3742: PASS');

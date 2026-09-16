import assert from 'node:assert/strict';
import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { jvmCanonicalValueTypeForDescriptor } from '../../../js/managed/jvm/value-type.js';

const FLOAT32 = { kind: 'float', widthBits: 32, format: 'binary32' };
const FLOAT64 = { kind: 'float', widthBits: 64, format: 'binary64' };
const BIT32 = { kind: 'bitvector', widthBits: 32 };
const BIT64 = { kind: 'bitvector', widthBits: 64 };
const u1=(o,x)=>o.push(x&255), u2=(o,x)=>o.push((x>>>8)&255,x&255), u4=(o,x)=>o.push((x>>>24)&255,(x>>>16)&255,(x>>>8)&255,x&255);
const utf=(s)=>{const o=[1],b=[...Buffer.from(s)];u2(o,b.length);o.push(...b);return o;};
const cpClass=(i)=>[7,(i>>>8)&255,i&255], nat=(n,d)=>[12,(n>>>8)&255,n&255,(d>>>8)&255,d&255], fieldRef=(c,n)=>[9,(c>>>8)&255,c&255,(n>>>8)&255,n&255];

function buildClass({ descriptor, isStatic }) {
  const out=[];
  u4(out,0xcafebabe);u2(out,0);u2(out,61);
  // 1 A, 2 Class(A), 3 Object, 4 Class(Object), 5 value, 6 desc,
  // 7 NAT, 8 Fieldref, 9 read, 10 ()desc, 11 Code.
  const entries=[utf('A'),cpClass(1),utf('java/lang/Object'),cpClass(3),utf('value'),utf(descriptor),nat(5,6),fieldRef(2,7),utf('read'),utf(`()${descriptor}`),utf('Code')];
  u2(out,entries.length+1); for(const e of entries)out.push(...e);
  u2(out,0x0021);u2(out,2);u2(out,4);u2(out,0);
  u2(out,1); u2(out,isStatic?0x0009:0x0001);u2(out,5);u2(out,6);u2(out,0);
  u2(out,1);u2(out,isStatic?0x0009:0x0001);u2(out,9);u2(out,10);u2(out,1);
  const ret={F:0xae,D:0xaf,I:0xac,J:0xad}[descriptor];
  const code=isStatic?[0xb2,0,8,ret]:[0x2a,0xb4,0,8,ret];
  u2(out,11);u4(out,12+code.length);u2(out,2);u2(out,isStatic?0:1);u4(out,code.length);out.push(...code);u2(out,0);u2(out,0);
  u2(out,0);
  return Uint8Array.from(out);
}

async function project(descriptor,isStatic){
  const frontend=new JvmFrontend();
  const image=await frontend.open(buildClass({descriptor,isStatic}),{binaryId:`8955-${descriptor}-${isStatic}`});
  const methods=[];for await(const m of frontend.enumerateMethods(image))methods.push(m);
  assert.equal(methods.length,1);
  const decoded=await frontend.decodeMethod(methods[0],{image});
  await frontend.validateMethod(decoded,{image});
  const lowered=lowerVMEffectsToSemanticIr(decoded);
  const load=lowered.semanticIr.nodes.find(n=>n.kind==='load');assert.ok(load);
  const value=lowered.semanticIr.values.find(v=>load.outputs.includes(v.id));assert.ok(value);
  return {decoded,lowered,value};
}

assert.deepEqual(jvmCanonicalValueTypeForDescriptor('F'),FLOAT32);
assert.deepEqual(jvmCanonicalValueTypeForDescriptor('D'),FLOAT64);
assert.deepEqual(jvmCanonicalValueTypeForDescriptor('I'),BIT32);
assert.deepEqual(jvmCanonicalValueTypeForDescriptor('J'),BIT64);
assert.equal(jvmCanonicalValueTypeForDescriptor('Ljava/lang/String;'),null);

for(const c of [
  ['F',true,FLOAT32],['D',true,FLOAT64],['F',false,FLOAT32],['D',false,FLOAT64],
  ['I',true,BIT32],['J',true,BIT64],
]){
  const [descriptor,isStatic,expected]=c;
  const {decoded,lowered,value}=await project(descriptor,isStatic);
  const field=decoded.bundles.find(b=>b.mnemonic==='getstatic'||b.mnemonic==='getfield');
  if (expected.kind === 'float') assert.deepEqual(field.producedValues[0].type, expected);
  else assert.equal(field.producedValues[0].type, undefined);
  assert.deepEqual(value.machineType,expected);
  assert.notEqual(lowered.semanticIr.completeness,'unknown');
}

// Cross-stage fail-closed: if a JVM producer claims float/double authority but
// drops/corrupts the canonical type, v2 must demote before the width fallback
// can publish a complete same-width bitvector.
{
  const {decoded}=await project('F',true);
  const bundles=decoded.bundles.map(b=>{
    if(b.mnemonic!=='getstatic')return b;
    const producedValues=b.producedValues.map(v=>{const {type,...rest}=v;return rest;});
    return {...b,producedValues};
  });
  const corrupted={...decoded,bundles,aggregateCompleteness:'exact'};
  const lowered=lowerVMEffectsToSemanticIr(corrupted);
  assert.equal(lowered.semanticIr.completeness,'partial');
  assert.ok(lowered.semanticIr.unknowns.some(u=>u.reason==='jvm-floating-value-type-authority-missing'));
  const load=lowered.semanticIr.nodes.find(n=>n.kind==='load');
  const value=lowered.semanticIr.values.find(v=>load.outputs.includes(v.id));
  assert.deepEqual(value.machineType,BIT32);
  assert.notEqual(load.completeness,'complete');
}

console.log('issue-8955 jvm compiled field float/double authority: PASS');

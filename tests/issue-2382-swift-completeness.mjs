import assert from 'node:assert/strict';
import { buildSwiftMetadataModel, buildSwiftRuntimeIndex, resolveSwiftDispatch } from '../js/swift.js';

const BASE=0x1000n;
function fixture(){
  const mem=new Uint8Array(0x3000);
  const off=(a)=>Number(BigInt(a)-BASE);
  const u32=(a,v)=>{const o=off(a),n=Number(BigInt.asUintN(32,BigInt(v)));mem[o]=n&255;mem[o+1]=(n>>>8)&255;mem[o+2]=(n>>>16)&255;mem[o+3]=(n>>>24)&255;};
  const rel32=(field,target)=>u32(field,BigInt(target)-BigInt(field));
  const str=(a,s)=>{const b=new TextEncoder().encode(s);mem.set(b,off(a));mem[off(a)+b.length]=0;};
  const desc=(a,nameAddr)=>{u32(a,17);u32(a+4n,0);rel32(a+8n,nameAddr);u32(a+12n,0);u32(a+16n,0);u32(a+20n,0);u32(a+24n,0);};
  rel32(0x1000n,0x2000n); rel32(0x1004n,0x2100n);
  desc(0x2000n,0x3000n); desc(0x2100n,0x3010n); str(0x3000n,'First'); str(0x3010n,'LastType');
  const read=async(a,len)=>{const o=off(a);return o<0||o+len>mem.length?null:mem.subarray(o,o+len);};
  return {mem,read,off};
}
const sections=(size)=>[{section:'__swift5_types',vmAddr:0x1000n,size:BigInt(size)}];

{
  const {read}=fixture();
  const model=await buildSwiftMetadataModel(read,sections(4),{budget:20});
  assert.equal(model.types.length,1); assert.equal(model.completeness.types.complete,true); assert.equal(model.complete,true);
}
{
  const {read}=fixture();
  const model=await buildSwiftMetadataModel(read,sections(8),{budget:1});
  assert.equal(model.types.length,1); assert.equal(model.completeness.types.capped,true); assert.equal(model.completeness.types.complete,false); assert.equal(model.complete,false);
  const result=resolveSwiftDispatch(buildSwiftRuntimeIndex(model),{kind:'vtable',typeName:'Missing',slot:0});
  assert.equal(result.resolved,null); assert.equal(result.complete,false);
}
{
  const f=fixture(); const read=async(a,len)=>BigInt(a)===0x1004n&&len===4?null:f.read(a,len);
  const model=await buildSwiftMetadataModel(read,sections(8),{budget:20});
  assert.equal(model.completeness.types.unreadableEntries,1); assert.equal(model.completeness.types.complete,false); assert.equal(model.complete,false);
}
{
  const f=fixture(); f.mem.fill(0,f.off(0x2100n),f.off(0x2100n)+28);
  const model=await buildSwiftMetadataModel(f.read,sections(8),{budget:20});
  assert.equal(model.completeness.types.invalidEntries,1); assert.equal(model.completeness.types.complete,false); assert.equal(model.complete,false);
}
{
  const direct=resolveSwiftDispatch(null,{target:0x1234n,name:'known'}); assert.equal(direct.complete,true);
}
console.log('issue-2382 swift completeness: ok');

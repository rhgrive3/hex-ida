import assert from 'node:assert/strict';
import { buildSwiftMetadataModel, buildSwiftRuntimeIndex, resolveSwiftDispatch } from '../js/swift.js';

const mem=new Map();
const put=(addr,bytes)=>{for(let i=0;i<bytes.length;i++)mem.set(Number(addr)+i,bytes[i]);};
const u32=(v)=>Uint8Array.of(v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255);
const i32=(v)=>u32(v>>>0);
const u64=(v)=>{let x=BigInt(v),b=new Uint8Array(8);for(let i=0;i<8;i++){b[i]=Number(x&255n);x>>=8n;}return b;};
const rel32=(field,target)=>i32(Number(BigInt(target)-BigInt(field)));
const cstr=(s)=>new TextEncoder().encode(s+'\0');
const read=async(addr,len)=>{const out=new Uint8Array(len);for(let i=0;i<len;i++){const v=mem.get(Number(addr)+i);if(v==null)return i?out.subarray(0,i):null;out[i]=v;}return out;};
const write32=(a,v)=>put(a,u32(v));
const writeRel=(field,target)=>put(field,rel32(field,target));

const TYPE_SEC=0x1000n,PROTO_SEC=0x1100n,CONF_SEC=0x1200n;
const TYPE=0x2000n,TYPE_NAME=0x2100n,PROTO=0x3000n,PROTO_NAME=0x3100n,CONF=0x4000n,WIT=0x5000n,IMPL=0x6000n;
put(TYPE,new Uint8Array(28));put(PROTO,new Uint8Array(32));put(CONF,new Uint8Array(16));put(WIT,new Uint8Array(8));
writeRel(TYPE_SEC,TYPE);writeRel(PROTO_SEC,PROTO);writeRel(CONF_SEC,CONF);
write32(TYPE,17);writeRel(TYPE+8n,TYPE_NAME);put(TYPE_NAME,cstr('T'));
write32(PROTO,3);writeRel(PROTO+8n,PROTO_NAME);put(PROTO_NAME,cstr('P'));write32(PROTO+16n,1);write32(PROTO+24n,1);
writeRel(CONF,PROTO);writeRel(CONF+4n,TYPE);writeRel(CONF+8n,WIT);
put(WIT,u64(IMPL));
const sections=[{section:'__swift5_types',vmAddr:TYPE_SEC,size:4},{section:'__swift5_protos',vmAddr:PROTO_SEC,size:4},{section:'__swift5_proto',vmAddr:CONF_SEC,size:4}];
const opts={budget:128,resolvePointer:async(raw)=>raw};

const model=await buildSwiftMetadataModel(read,sections,opts);
assert.equal(model.protocols[0].requirements.length,1);
assert.equal(model.protocols[0].requirements[0].witnessCallable,true);
assert.equal(model.witnessTables.length,1);
assert.equal(model.witnessTables[0].source,'conformance');
assert.equal(model.witnessTables[0].entries[0].target,IMPL);
const resolved=resolveSwiftDispatch(buildSwiftRuntimeIndex(model),{kind:'witness',typeAddress:TYPE,protocolAddress:PROTO,slot:0});
assert.equal(resolved.resolved?.target,IMPL);
assert.equal(resolved.complete,true);

write32(PROTO+24n,7);
const associated=await buildSwiftMetadataModel(read,sections,opts);
assert.equal(associated.witnessTables.length,0);
assert.equal(associated.complete,false);

write32(PROTO+24n,1);write32(CONF+12n,1<<8);
const conditional=await buildSwiftMetadataModel(read,sections,opts);
assert.equal(conditional.witnessTables.length,0);
assert.equal(conditional.complete,false);
console.log('issue-2378 swift witness autoproject: ok');

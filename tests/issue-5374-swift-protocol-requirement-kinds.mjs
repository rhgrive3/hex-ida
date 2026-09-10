import assert from 'node:assert/strict';
import { buildSwiftMetadataModel, buildSwiftRuntimeIndex, resolveSwiftDispatch } from '../js/swift.js';

/* #5374: ProtocolRequirementFlags::Kind 7 (AssociatedTypeAccessFunction) and
   8 (AssociatedConformanceAccessFunction) are function requirements invoked
   through the witness table. They must classify witnessCallable:true so a
   proof-safe conformance projects its witness table, while kind 0
   (BaseProtocol) and reserved kinds 9..15 stay fail-closed non-callable. */

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

const TYPE_SEC=0x11000n,PROTO_SEC=0x11100n,CONF_SEC=0x11200n;
const TYPE=0x12000n,TYPE_NAME=0x12100n,PROTO=0x13000n,PROTO_NAME=0x13100n,CONF=0x14000n,WIT=0x15000n,IMPL=0x16000n;
put(TYPE,new Uint8Array(28));put(PROTO,new Uint8Array(32));put(CONF,new Uint8Array(16));put(WIT,new Uint8Array(8));
writeRel(TYPE_SEC,TYPE);writeRel(PROTO_SEC,PROTO);writeRel(CONF_SEC,CONF);
write32(TYPE,17);writeRel(TYPE+8n,TYPE_NAME);put(TYPE_NAME,cstr('T'));
write32(PROTO,3);writeRel(PROTO+8n,PROTO_NAME);put(PROTO_NAME,cstr('P'));write32(PROTO+16n,1);write32(PROTO+24n,1);
writeRel(CONF,PROTO);writeRel(CONF+4n,TYPE);writeRel(CONF+8n,WIT);
put(WIT,u64(IMPL));
const sections=[{section:'__swift5_types',vmAddr:TYPE_SEC,size:4},{section:'__swift5_protos',vmAddr:PROTO_SEC,size:4},{section:'__swift5_proto',vmAddr:CONF_SEC,size:4}];
const opts={budget:128,resolvePointer:async(raw)=>raw};

function reset(){mem.clear();
  put(TYPE,new Uint8Array(28));put(PROTO,new Uint8Array(32));put(CONF,new Uint8Array(16));put(WIT,new Uint8Array(8));
  writeRel(TYPE_SEC,TYPE);writeRel(PROTO_SEC,PROTO);writeRel(CONF_SEC,CONF);
  write32(TYPE,17);writeRel(TYPE+8n,TYPE_NAME);put(TYPE_NAME,cstr('T'));
  write32(PROTO,3);writeRel(PROTO+8n,PROTO_NAME);put(PROTO_NAME,cstr('P'));write32(PROTO+16n,1);write32(PROTO+24n,1);
  writeRel(CONF,PROTO);writeRel(CONF+4n,TYPE);writeRel(CONF+8n,WIT);
  put(WIT,u64(IMPL));
}

async function project(kind){reset();write32(PROTO+24n,kind);return buildSwiftMetadataModel(read,sections,opts);}

// Kinds 1..8 are callable function requirements; 7/8 were misclassified before #5374.
for(const kind of [1,2,3,4,5,6,7,8]){
  const model=await project(kind);
  assert.equal(model.protocols[0].requirements[0].kind,kind,`kind ${kind} recorded`);
  assert.equal(model.protocols[0].requirements[0].witnessCallable,true,`kind ${kind} is a callable witness requirement`);
  assert.equal(model.witnessTables.length,1,`kind ${kind} projects its witness table`);
  assert.equal(model.witnessTables[0].entries[0].resolved,true,`kind ${kind} witness entry resolves`);
  assert.equal(model.completeness.witnessTables.complete,true,`kind ${kind} witness completeness`);
  assert.equal(model.complete,true,`kind ${kind} model completes`);
  const resolved=resolveSwiftDispatch(buildSwiftRuntimeIndex(model),{kind:'witness',typeAddress:TYPE,protocolAddress:PROTO,slot:0});
  assert.equal(resolved.resolved?.target,IMPL,`kind ${kind} dispatch resolves through the witness entry`);
  assert.equal(resolved.complete,true);
}

// Kind 0 (BaseProtocol) stays a non-callable pointer entry.
const base=await project(0);
assert.equal(base.protocols[0].requirements[0].witnessCallable,false,'kind 0 BaseProtocol stays non-callable');
assert.equal(base.witnessTables.length,0,'kind 0 blocks witness projection');
assert.ok(base.warnings.some((w)=>w.includes('non-callable protocol requirements')),'kind 0 warning');

// Reserved kinds 9..15 stay fail-closed (never inferred callable).
for(const kind of [9,10,15]){
  const reserved=await project(kind);
  assert.equal(reserved.protocols[0].requirements[0].witnessCallable,false,`kind ${kind} reserved stays non-callable`);
  assert.equal(reserved.witnessTables.length,0,`kind ${kind} blocks witness projection`);
  assert.equal(reserved.complete,false,`kind ${kind} model stays incomplete`);
}

console.log('issue-5374 swift protocol requirement kinds: ok');

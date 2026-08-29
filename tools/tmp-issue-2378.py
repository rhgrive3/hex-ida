from pathlib import Path

p = Path('js/swift.js')
s = p.read_text()

old = """export async function parseSwiftProtocolDescriptor(read,address){const addr=BigInt(address),b=await exact(read,addr,24);if(!b)return null;const flags=u32(b,0);if(contextKind(flags)!=='protocol')return null;const name=await relativeString(read,addr+8n,i32(b,8));if(!name)return null;return{runtime:'swift',kind:'protocol',address:addr,flags,name,parent:rel(addr+4n,i32(b,4)),numRequirementsInSignature:u32(b,12),numRequirements:u32(b,16),associatedTypeNames:rel(addr+20n,i32(b,20)),requirements:[]};}
"""
new = """export async function parseSwiftProtocolDescriptor(read,address){const addr=BigInt(address),b=await exact(read,addr,24);if(!b)return null;const flags=u32(b,0);if(contextKind(flags)!=='protocol')return null;const name=await relativeString(read,addr+8n,i32(b,8));if(!name)return null;return{runtime:'swift',kind:'protocol',address:addr,flags,name,parent:rel(addr+4n,i32(b,4)),numRequirementsInSignature:u32(b,12),numRequirements:u32(b,16),associatedTypeNames:rel(addr+20n,i32(b,20)),requirements:[]};}

const SWIFT_GENERIC_REQUIREMENT_BYTES=12;
const SWIFT_PROTOCOL_REQUIREMENT_BYTES=8;
function swiftProtocolRequirementKind(flags){const kind=Number(flags)&0x0f;return{kind,callable:kind>=1&&kind<=6};}
async function parseSwiftProtocolRequirements(read,protocol,budget=4096){
  const declared=Number(protocol?.numRequirements||0),signature=Number(protocol?.numRequirementsInSignature||0),limit=normalizeBudget(budget,4096,100000);
  if(!Number.isInteger(declared)||declared<0||!Number.isInteger(signature)||signature<0||declared>limit)return{requirements:[],complete:false,reason:'protocol-requirement-budget'};
  const start=BigInt(protocol.address)+24n+BigInt(signature*SWIFT_GENERIC_REQUIREMENT_BYTES),requirements=[];
  for(let i=0;i<declared;i++){
    const at=start+BigInt(i*SWIFT_PROTOCOL_REQUIREMENT_BYTES),b=await exact(read,at,SWIFT_PROTOCOL_REQUIREMENT_BYTES);
    if(!b)return{requirements,complete:false,reason:'protocol-requirement-unreadable'};
    const flags=u32(b,0),kindInfo=swiftProtocolRequirementKind(flags);
    requirements.push({index:i,address:at,flags,kind:kindInfo.kind,witnessCallable:kindInfo.callable,defaultImplementation:rel(at+4n,i32(b,4))});
  }
  return{requirements,complete:true,reason:null};
}
"""
if old not in s:
    raise SystemExit('protocol descriptor anchor not found')
s = s.replace(old, new, 1)

old = """  const types=typeScan.items,protocols=protoScan.items,conformances=confScan.items;
  const warnings=[];
  for(const t of types)if(t.fieldDescriptor!=null){try{
"""
new = """  const types=typeScan.items,protocols=protoScan.items,conformances=confScan.items;
  const warnings=[];
  for(const p of protocols){
    const scan=await parseSwiftProtocolRequirements(read,p,Math.min(budget,4096));
    p.requirements=scan.requirements;
    p.requirementsComplete=scan.complete;
    if(!scan.complete){protoScan.completeness.complete=false;protoScan.completeness.invalidEntries++;warnings.push(`Swift protocol ${p.name||p.address}: requirement metadata is partial (${scan.reason||'unknown'}).`);}
  }
  for(const t of types)if(t.fieldDescriptor!=null){try{
"""
if old not in s:
    raise SystemExit('model protocol anchor not found')
s = s.replace(old, new, 1)

old = """  const witnessTables=[];let witnessTablesComplete=true;for(const w of opts.witnessTables||[]){const entries=await parseSwiftWitnessTable(read,w.address,w.count,budget,opts),expected=Math.min(normalizeBudget(w.count,0,100000),budget);if(entries.length!==expected||Number(w.count)>budget||entries.some((x)=>x.resolved!==true))witnessTablesComplete=false;witnessTables.push({...w,entries});}
"""
new = """  const witnessTables=[];let witnessTablesComplete=true;
  const witnessSeeds=[...(opts.witnessTables||[])],seedAddresses=new Set(witnessSeeds.map((w)=>String(w.address)));
  for(const c of conformances){
    if(c.witnessTable==null||seedAddresses.has(c.witnessTable.toString()))continue;
    const protocol=protocols.find((p)=>p.address.toString()===c.protocol?.toString()),type=c.typeReferenceKind<=1&&c.typeRef!=null?types.find((t)=>t.address.toString()===c.typeRef.toString()):null;
    if(!protocol||!type||c.conditionalRequirements!==0||c.resilientWitnesses===true||protocol.requirementsComplete!==true){witnessTablesComplete=false;warnings.push(`Swift conformance ${c.address}: witness table layout is not proof-safe for automatic projection.`);continue;}
    const requirements=protocol.requirements||[];
    if(requirements.length!==Number(protocol.numRequirements)||requirements.some((r)=>r.witnessCallable!==true)){witnessTablesComplete=false;warnings.push(`Swift conformance ${c.address}: non-callable protocol requirements prevent exact witness projection.`);continue;}
    if(!requirements.length)continue;
    const seed={address:c.witnessTable,count:requirements.length,typeAddress:type.address,typeName:type.name,protocolAddress:protocol.address,protocolName:protocol.name,source:'conformance'};
    witnessSeeds.push(seed);seedAddresses.add(c.witnessTable.toString());
  }
  for(const w of witnessSeeds){const entries=await parseSwiftWitnessTable(read,w.address,w.count,budget,opts),expected=Math.min(normalizeBudget(w.count,0,100000),budget);if(entries.length!==expected||Number(w.count)>budget||entries.some((x)=>x.resolved!==true))witnessTablesComplete=false;witnessTables.push({...w,entries});}
"""
if old not in s:
    raise SystemExit('witness anchor not found')
s = s.replace(old, new, 1)
p.write_text(s)

Path('tests/issue-2378-swift-witness-autoproject.mjs').write_text(r'''import assert from 'node:assert/strict';
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
''')

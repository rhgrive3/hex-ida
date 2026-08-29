import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ByteView } from '../js/binary/reader.js';
import { parseChainedBindingSites, resolveMachOPointer } from '../js/binary/macho-dyld.js';
import { parseSwiftConformanceDescriptor } from '../js/swift.js';

function makeChainedFixture({ pointerFormat = 9, raw = 0x800n, imageBase = 0x100000000n } = {}) {
  const bytes = new Uint8Array(0x1200);
  const dv = new DataView(bytes.buffer);
  const startsOffset = 0x1c;
  const startsBase = startsOffset;
  const record = startsBase + 8;
  const structSize = 24;
  dv.setUint32(4, startsOffset, true);
  dv.setUint32(startsBase, 1, true);
  dv.setUint32(startsBase + 4, 8, true);
  dv.setUint32(record, structSize, true);
  dv.setUint16(record + 4, 0x1000, true);
  dv.setUint16(record + 6, pointerFormat, true);
  dv.setBigUint64(record + 8, 0x1000n, true);
  dv.setUint32(record + 16, 0, true);
  dv.setUint16(record + 20, 1, true);
  dv.setUint16(record + 22, 0, true);

  const segment = { name:'__DATA', address:imageBase + 0x1000n, size:0x1000n, fileOffset:0x100n, fileSize:0x1000n };
  dv.setBigUint64(Number(segment.fileOffset), raw, true);
  const image = {
    imageBase,
    segments:[segment],
    metadata:{chainedFixups:{complete:true}},
    warnings:[],
    addressToOffset(address) {
      const a=BigInt(address);
      if(a<segment.address||a>=segment.address+segment.fileSize)return null;
      return segment.fileOffset+(a-segment.address);
    },
    segmentAt(address) {
      const a=BigInt(address);
      return a>=imageBase && a<imageBase+0x100000n ? { address:imageBase, size:0x100000n } : null;
    },
    sectionAt() { return null; },
  };
  const imports=[{name:'_external',sites:[]}];
  parseChainedBindingSites(new ByteView(bytes), {offset:0,size:0x80}, image, imports, [segment]);
  return { image, storage:segment.address, imports };
}

// arm64e USERLAND rebase is decoded only at a proven chained-fixup site.
{
  const targetOffset=0x800n;
  const {image,storage}=makeChainedFixture({pointerFormat:9,raw:targetOffset});
  assert.equal(resolveMachOPointer(image,targetOffset,{address:storage}), image.imageBase+targetOffset);
  assert.equal(resolveMachOPointer(image,targetOffset+8n,{address:storage}), null, 'raw mismatch cannot borrow a recorded site');
}

// DYLD_CHAINED_PTR_64_OFFSET reconstructs high8 and adds image base.
{
  const high8=0n, target=0x880n;
  const raw=(target&0xfffffffffn)|((high8&0xffn)<<36n);
  const {image,storage}=makeChainedFixture({pointerFormat:6,raw});
  assert.equal(resolveMachOPointer(image,raw,{address:storage}),image.imageBase+target);
}

// A bind is never fabricated as a VM address.
{
  const raw=(1n<<62n)|0x1234n;
  const {image,storage}=makeChainedFixture({pointerFormat:9,raw});
  assert.equal(resolveMachOPointer(image,raw,{address:storage}),null);
}

// Ordinary already-materialized in-image pointers remain accepted outside fixup sites.
{
  const image={sectionAt:()=>null,segmentAt:(a)=>BigInt(a)===0x100002000n?{}:null};
  assert.equal(resolveMachOPointer(image,0x100002000n,{address:0x100003000n}),0x100002000n);
  assert.equal(resolveMachOPointer(image,0xdeadbeefn,{address:0x100003000n}),null);
}

function makeRead(base=0x100000000n,size=0x10000){
  const bytes=new Uint8Array(size), dv=new DataView(bytes.buffer);
  const off=(a)=>Number(BigInt(a)-base);
  const writeI32=(a,v)=>dv.setInt32(off(a),Number(v),true);
  const writeU32=(a,v)=>dv.setUint32(off(a),Number(v),true);
  const writeU64=(a,v)=>dv.setBigUint64(off(a),BigInt(v),true);
  const read=async(a,n)=>{const o=off(a);return o<0||o+n>bytes.length?null:bytes.slice(o,o+n);};
  return {base,bytes,writeI32,writeU32,writeU64,read};
}

// Swift indirect protocol reference passes the absolute slot address to the canonical resolver.
{
  const m=makeRead(), c=m.base+0x1000n, slot=m.base+0x1800n, proto=m.base+0x2400n, type=m.base+0x3000n;
  m.writeI32(c, Number(slot-c)|1);
  m.writeI32(c+4n, Number(type-(c+4n)));
  m.writeI32(c+8n, 0);
  m.writeU32(c+12n, 0);
  m.writeU64(slot, proto);
  const seen=[];
  const out=await parseSwiftConformanceDescriptor(m.read,c,{resolvePointer:async(raw,ctx)=>{seen.push({raw,ctx});return raw;}});
  assert.equal(out.protocol,proto);
  assert.equal(seen[0].ctx.address,slot);
}

// Missing resolver remains conservative; raw encoded/absolute bytes are not promoted.
{
  const m=makeRead(), c=m.base+0x1000n, slot=m.base+0x1800n, proto=m.base+0x2400n, type=m.base+0x3000n;
  m.writeI32(c, Number(slot-c)|1); m.writeI32(c+4n, Number(type-(c+4n))); m.writeU32(c+12n,0); m.writeU64(slot,proto);
  assert.equal(await parseSwiftConformanceDescriptor(m.read,c,{}),null);
}

// typeReferenceKind=1 uses the same absolute-pointer resolver contract.
{
  const m=makeRead(), c=m.base+0x1000n, proto=m.base+0x2400n, typeSlot=m.base+0x3000n, type=m.base+0x3500n;
  m.writeI32(c, Number(proto-c)); m.writeI32(c+4n, Number(typeSlot-(c+4n))); m.writeU32(c+12n,1<<3); m.writeU64(typeSlot,type);
  const seen=[];
  const out=await parseSwiftConformanceDescriptor(m.read,c,{resolvePointer:async(raw,ctx)=>{seen.push(ctx.address);return raw;}});
  assert.equal(out.protocol,proto); assert.equal(out.typeRef,type); assert.deepEqual(seen,[typeSlot]);
}

// Direct relative protocol references do not require or call the resolver.
{
  const m=makeRead(), c=m.base+0x1000n, proto=m.base+0x2400n, type=m.base+0x3000n;
  m.writeI32(c, Number(proto-c)); m.writeI32(c+4n, Number(type-(c+4n))); m.writeU32(c+12n,0);
  let calls=0;
  const out=await parseSwiftConformanceDescriptor(m.read,c,{resolvePointer:async()=>{calls++;return null;}});
  assert.equal(out.protocol,proto); assert.equal(out.typeRef,type); assert.equal(calls,0);
}

// Canonical App path must route Swift pointer resolution through Backend -> platform loader.
const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
const backend=fs.readFileSync(new URL('../js/backend.js',import.meta.url),'utf8');
const worker=fs.readFileSync(new URL('../js/platform/worker.js',import.meta.url),'utf8');
assert.match(app,/buildSwiftMetadataModel\(read,regions,\{[\s\S]{0,180}resolvePointer:\(raw,context\)=>this\.backend\.resolvePointer\(raw,\{\.\.\.context,sliceIndex:slice\}\)/);
assert.match(backend,/resolvePointer\(raw, context = \{\}\)[\s\S]{0,160}_callTo\('platform', 'resolvePointer'/);
assert.match(worker,/case 'resolvePointer': return resolvePointer\(msg, signal\)/);

console.log('issue #2376 Swift canonical pointer resolver regressions: PASS');

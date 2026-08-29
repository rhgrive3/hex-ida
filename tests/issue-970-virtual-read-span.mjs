import assert from 'node:assert/strict';
import { BinaryImage } from '../js/binary/model.js';
import { ByteView } from '../js/binary/reader.js';
import { parsePE } from '../js/binary/pe.js';
import { parseCompactUnwind } from '../js/binary/macho-core.js';
import { createMachOMetadataBudget } from '../js/binary/macho-budget.js';

const data = new Uint8Array(0x300);
data.set([0xaa, 0xbb, 0xcc, 0xdd], 0x100);
data.set([0x11, 0x22, 0x33, 0x44], 0x104); // unrelated raw-file bytes
data.set([0x51, 0x52], 0x200);

function imageWithTail(bytes = data) {
  const image = new BinaryImage(bytes, { format:'elf' });
  image.addSegment({
    name:'LOAD0', address:0x1000n, size:8n,
    fileOffset:0x100n, fileSize:4n,
    perms:{ read:true }, source:'PT_LOAD',
  });
  return image;
}

const resident = imageWithTail();
assert.deepEqual([...resident.readVirtual(0x1000n, 4)], [0xaa,0xbb,0xcc,0xdd], 'fully file-backed reads remain unchanged');
assert.deepEqual([...resident.readVirtual(0x1002n, 4)], [0xcc,0xdd,0,0], 'file-backed -> BSS tail must compose mapped bytes plus zero-fill');
assert.deepEqual([...resident.readVirtual(0x1004n, 4)], [0,0,0,0], 'fully zero-fill reads must synthesize zero bytes');
assert.equal(resident.addressToOffset(0x1004n), null, 'zero-fill VA must not resolve to unrelated raw-file bytes');
assert.equal(resident.resolveVirtualMapping(0x1004n)?.kind, 'zero');

const gap = new BinaryImage(data, { format:'elf' });
gap.addSegment({ address:0x1000n, size:4n, fileOffset:0x100n, fileSize:4n, perms:{read:true} });
gap.addSegment({ address:0x2000n, size:2n, fileOffset:0x200n, fileSize:2n, perms:{read:true} });
assert.equal(gap.readVirtual(0x1002n, 4), null, 'file-backed -> unmapped gap must fail closed');

const contiguous = new BinaryImage(data, { format:'pe' });
contiguous.addSegment({ address:0x3000n, size:2n, fileOffset:0x100n, fileSize:2n, perms:{read:true} });
contiguous.addSegment({ address:0x3002n, size:2n, fileOffset:0x200n, fileSize:2n, perms:{read:true} });
assert.deepEqual([...contiguous.readVirtual(0x3000n, 4)], [0xaa,0xbb,0x51,0x52], 'VA-contiguous mappings with non-contiguous file offsets must compose per mapping');

const machoSparse = new BinaryImage(data, { format:'macho' });
machoSparse.addSegment({ address:0x4000n, size:8n, fileOffset:0x100n, fileSize:8n, perms:{read:true}, source:'LC_SEGMENT_64' });
machoSparse.addSection({ name:'__bss', segment:'__DATA', address:0x4004n, size:4n, fileOffset:0n, fileSize:0n, perms:{read:true,write:true}, source:'LC_SEGMENT_64' });
assert.deepEqual([...machoSparse.readVirtual(0x4002n, 4)], [0xcc,0xdd,0,0], 'zero-fill child section must override broader segment raw-file continuity');

const source = {
  size: BigInt(data.length),
  async readExactly(offset, size) {
    const o = Number(offset), n = Number(size);
    assert.ok(Number.isSafeInteger(o) && Number.isSafeInteger(n) && o >= 0 && n >= 0 && o + n <= data.length);
    return data.slice(o, o + n);
  },
};
const streamed = imageWithTail();
streamed.attachSource(source, { discardBytes:true });
assert.deepEqual([...await streamed.readVirtualAsync(0x1002n, 4n)], [0xcc,0xdd,0,0], 'streaming path must share resident mapping semantics');
assert.deepEqual([...await streamed.readVirtualAsync(0x1004n, 4n)], [0,0,0,0], 'streaming zero-fill must not read source bytes');

const streamedGap = new BinaryImage(null, { format:'elf', source, fileSize:source.size });
streamedGap.addSegment({ address:0x1000n, size:4n, fileOffset:0x100n, fileSize:4n, perms:{read:true} });
streamedGap.addSegment({ address:0x2000n, size:2n, fileOffset:0x200n, fileSize:2n, perms:{read:true} });
assert.equal(await streamedGap.readVirtualAsync(0x1002n, 4n), null, 'streaming path must fail closed across unmapped VA gaps');

function w16(b,o,v){b[o]=v&255;b[o+1]=(v>>>8)&255;}
function w32(b,o,v){b[o]=v&255;b[o+1]=(v>>>8)&255;b[o+2]=(v>>>16)&255;b[o+3]=(v>>>24)&255;}
function w64(b,o,v){let n=BigInt(v);for(let i=0;i<8;i++){b[o+i]=Number(n&255n);n>>=8n;}}
function rawOffsetPE(ptr){
  const b=new Uint8Array(0x1200),pe=0x80,coff=pe+4,opt=coff+20,os=0xf0,s=opt+os;
  w16(b,0,0x5a4d); w32(b,0x3c,pe); w32(b,pe,0x4550); w16(b,coff,0x8664); w16(b,coff+2,1); w16(b,coff+16,os);
  w16(b,opt,0x20b); w64(b,opt+24,0x140000000n); w32(b,opt+32,0x1000); w32(b,opt+36,0x200); w32(b,opt+56,0x2000); w32(b,opt+60,0x200); w16(b,opt+68,3);
  b.set(new TextEncoder().encode('.text\0\0\0'),s); w32(b,s+8,0x200); w32(b,s+12,0x1000); w32(b,s+16,0x200); w32(b,s+20,ptr); w32(b,s+36,0x60000020);
  return b;
}
const peSectionAddress=0x140001000n;
{
  const bytes=rawOffsetPE(0x820); bytes[0x800]=0x41; bytes[0x820]=0x43; const image=parsePE(bytes);
  assert.equal(image.sections[0].fileOffset,0x800n,'PE non-zero raw offset rounds down to Windows loader boundary');
  assert.equal(image.readVirtual(peSectionAddress,1)?.[0],0x41,'PE virtual reads use effective raw start');
  assert.equal(image.metadata.peSectionRawMappings[0].declaredFileOffset,0x820);
  assert.equal(image.metadata.peSectionRawMappings[0].effectiveFileOffset,0x800);
  assert.ok(image.warnings.some((x)=>x.includes('0x820')&&x.includes('0x800')));
}
assert.equal(parsePE(rawOffsetPE(0x9ff)).sections[0].fileOffset,0x800n,'0x9ff also rounds to 0x800');
{
  const image=parsePE(rawOffsetPE(0));
  assert.equal(image.sections[0].fileSize,0n,'PointerToRawData zero remains non-file-backed');
  assert.equal(image.addressToOffset(peSectionAddress),null);
  assert.equal(image.readVirtual(peSectionAddress,1)?.[0],0);
  assert.equal(image.metadata.peSectionRawMappings[0].fileBacked,false);
}
{
  const image=parsePE(rawOffsetPE(1));
  assert.equal(image.sections[0].fileOffset,0n,'non-zero raw offset may round to zero while remaining file-backed');
  assert.equal(image.sections[0].fileSize,0x200n);
  assert.equal(image.addressToOffset(peSectionAddress),0n);
  assert.equal(image.metadata.peSectionRawMappings[0].fileBacked,true);
}
assert.equal(parsePE(rawOffsetPE(0x800)).metadata.peSectionRawMappings[0].roundedDown,false,'aligned raw offset remains unchanged');

function compactUnwindFixture({
  kind=2,
  lower=0x1000,
  upper=0x2000,
  offsets=[0x1000],
  pageOff=80,
  sentinelPageOff=0,
  entryOff=null,
  encodingIndices=null,
  commonCount=1,
  localEncodingCount=0,
}={}) {
  const b=new Uint8Array(512),v=new DataView(b.buffer);
  const u32=(o,x)=>v.setUint32(o,x>>>0,true),u16=(o,x)=>v.setUint16(o,x,true);
  u32(0,1);
  u32(4,commonCount?28:0);u32(8,commonCount);
  if(commonCount)u32(28,0x01000000);
  u32(12,0);u32(16,0);u32(20,32);u32(24,2);
  u32(32,lower);u32(36,pageOff);u32(40,0);
  u32(44,upper);u32(48,sentinelPageOff);u32(52,0);
  u32(pageOff,kind);
  if(kind===2){
    const eo=entryOff??8;u16(pageOff+4,eo);u16(pageOff+6,offsets.length);
    offsets.forEach((offset,i)=>{u32(pageOff+eo+i*8,offset);u32(pageOff+eo+i*8+4,0);});
  }else if(kind===3){
    const eo=entryOff??12;u16(pageOff+4,eo);u16(pageOff+6,offsets.length);
    const encOff=eo+offsets.length*4;u16(pageOff+8,encOff);u16(pageOff+10,localEncodingCount);
    offsets.forEach((offset,i)=>u32(pageOff+eo+i*4,(((encodingIndices?.[i]??0)&0xff)<<24)|((offset-lower)&0x00ffffff)));
    for(let i=0;i<localEncodingCount;i++)u32(pageOff+encOff+i*4,0x02000000+i);
  }
  return b;
}
function compactUnwindImage(bytes){
  const base=0x100000000n;
  const seg={name:'__TEXT',address:base,size:0x10000n,perms:{execute:true}};
  return {
    bytes,arch:'arm64',bits:64,
    sections:[{name:'__unwind_info',fileOffset:0n,fileSize:BigInt(bytes.length)}],
    segments:[seg],unwindEntries:[],functions:[],metadata:{},warnings:[],
    segmentAt(addr){return addr>=base&&addr<base+seg.size?seg:null;},
  };
}
function parseUnwindFixture(options={},budgetOptions=null){
  const bytes=compactUnwindFixture(options),image=compactUnwindImage(bytes);
  const budget=budgetOptions?createMachOMetadataBudget(image,budgetOptions):null;
  parseCompactUnwind(new ByteView(bytes),image,budget);
  return image;
}
{
  const image=parseUnwindFixture();
  assert.equal(image.unwindEntries.length,1,'regular compact-unwind page remains publishable');
  assert.equal(image.unwindEntries[0].start,0x100001000n);
  assert.equal(image.unwindEntries[0].end,0x100002000n,'sentinel upper bound must close the final function extent');
  assert.equal(image.metadata.compactUnwind.complete,true);
}
{
  const image=parseUnwindFixture({kind:3});
  assert.equal(image.unwindEntries.length,1,'valid compressed compact-unwind page remains publishable');
  assert.equal(image.unwindEntries[0].end,0x100002000n);
}
for(const kind of [2,3]){
  const image=parseUnwindFixture({kind,offsets:[0x1000,0x3000]});
  assert.equal(image.unwindEntries.length,0,`kind ${kind} out-of-range entry must publish no unwind evidence`);
  assert.equal(image.functions.length,0);
  assert.equal(image.metadata.compactUnwind.complete,false);
  assert.equal(image.metadata.compactUnwind.partialReason,'entry-out-of-range');
}
{
  const image=parseUnwindFixture({kind:3,entryOff:8});
  assert.equal(image.unwindEntries.length,0,'compressed entry array may not overlap its 12-byte header');
  assert.equal(image.metadata.compactUnwind.partialReason,'compressed-page-range-invalid');
}
{
  const image=parseUnwindFixture({kind:3,encodingIndices:[1]});
  assert.equal(image.unwindEntries.length,0,'compressed encoding index outside common+local domain must fail closed');
  assert.equal(image.metadata.compactUnwind.partialReason,'compressed-encoding-index-invalid');
}
{
  const image=parseUnwindFixture({sentinelPageOff:120});
  assert.equal(image.unwindEntries.length,0,'first-level sentinel must not own a second-level page');
  assert.equal(image.metadata.compactUnwind.partialReason,'sentinel-page-invalid');
}
{
  const image=parseUnwindFixture({pageOff:40});
  assert.equal(image.unwindEntries.length,0,'second-level page must not overlap first-level index storage');
  assert.equal(image.metadata.compactUnwind.partialReason,'page-range-invalid');
}
{
  const image=parseUnwindFixture({}, {limits:{records:1}});
  assert.equal(image.unwindEntries.length,0,'metadata budget exhaustion must publish no compact-unwind evidence');
  assert.equal(image.metadata.compactUnwind.complete,false);
  assert.equal(image.metadata.compactUnwind.partialReason,'metadata-budget');
  assert.ok(image.metadata.machoMetadata.reasons.some((reason)=>reason.startsWith('budget:compact-unwind-index:records')));
}
{
  let checks=0;
  const signal={get aborted(){checks++;return checks>=3;}};
  const image=parseUnwindFixture({}, {signal});
  assert.ok(checks>=3);
  assert.equal(image.unwindEntries.length,0,'cancelled compact-unwind scan must publish no evidence');
  assert.equal(image.functions.length,0);
  assert.equal(image.metadata.compactUnwind.partialReason,'metadata-budget');
  assert.ok(image.metadata.machoMetadata.reasons.includes('budget:aborted'));
}

console.log('issue 970 mapping-aware BinaryImage virtual read regression + issue 2476 PE raw-offset mapping + issue 2370 compact-unwind soundness: PASS');

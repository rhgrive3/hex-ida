import assert from 'node:assert/strict';
import { BinaryImage } from '../js/binary/model.js';
import { parsePE } from '../js/binary/pe.js';

const data = new Uint8Array(0x300);
data.set([0xaa, 0xbb, 0xcc, 0xdd], 0x100);
data.set([0x11, 0x22, 0x33, 0x44], 0x104); // unrelated raw-file bytes
data.set([0x51, 0x52], 0x200);

function imageWithTail(bytes = data) {
  const image = new BinaryImage(bytes, { format:'elf' });
  image.addSegment({ name:'LOAD0', address:0x1000n, size:8n, fileOffset:0x100n, fileSize:4n, perms:{ read:true }, source:'PT_LOAD' });
  return image;
}

const resident = imageWithTail();
assert.deepEqual([...resident.readVirtual(0x1000n, 4)], [0xaa,0xbb,0xcc,0xdd]);
assert.deepEqual([...resident.readVirtual(0x1002n, 4)], [0xcc,0xdd,0,0]);
assert.deepEqual([...resident.readVirtual(0x1004n, 4)], [0,0,0,0]);
assert.equal(resident.addressToOffset(0x1004n), null);
assert.equal(resident.resolveVirtualMapping(0x1004n)?.kind, 'zero');
const gap = new BinaryImage(data, { format:'elf' });
gap.addSegment({ address:0x1000n, size:4n, fileOffset:0x100n, fileSize:4n, perms:{read:true} });
gap.addSegment({ address:0x2000n, size:2n, fileOffset:0x200n, fileSize:2n, perms:{read:true} });
assert.equal(gap.readVirtual(0x1002n, 4), null);
const contiguous = new BinaryImage(data, { format:'pe' });
contiguous.addSegment({ address:0x3000n, size:2n, fileOffset:0x100n, fileSize:2n, perms:{read:true} });
contiguous.addSegment({ address:0x3002n, size:2n, fileOffset:0x200n, fileSize:2n, perms:{read:true} });
assert.deepEqual([...contiguous.readVirtual(0x3000n, 4)], [0xaa,0xbb,0x51,0x52]);
const machoSparse = new BinaryImage(data, { format:'macho' });
machoSparse.addSegment({ address:0x4000n, size:8n, fileOffset:0x100n, fileSize:8n, perms:{read:true}, source:'LC_SEGMENT_64' });
machoSparse.addSection({ name:'__bss', segment:'__DATA', address:0x4004n, size:4n, fileOffset:0n, fileSize:0n, perms:{read:true,write:true}, source:'LC_SEGMENT_64' });
assert.deepEqual([...machoSparse.readVirtual(0x4002n, 4)], [0xcc,0xdd,0,0]);
const source = { size: BigInt(data.length), async readExactly(offset, size) { const o=Number(offset), n=Number(size); return data.slice(o,o+n); } };
const streamed = imageWithTail(); streamed.attachSource(source,{discardBytes:true});
assert.deepEqual([...await streamed.readVirtualAsync(0x1002n,4n)],[0xcc,0xdd,0,0]);
assert.deepEqual([...await streamed.readVirtualAsync(0x1004n,4n)],[0,0,0,0]);
const streamedGap = new BinaryImage(null,{format:'elf',source,fileSize:source.size});
streamedGap.addSegment({address:0x1000n,size:4n,fileOffset:0x100n,fileSize:4n,perms:{read:true}});
streamedGap.addSegment({address:0x2000n,size:2n,fileOffset:0x200n,fileSize:2n,perms:{read:true}});
assert.equal(await streamedGap.readVirtualAsync(0x1002n,4n),null);

function w16(b,o,v){b[o]=v&255;b[o+1]=(v>>>8)&255;}
function w32(b,o,v){b[o]=v&255;b[o+1]=(v>>>8)&255;b[o+2]=(v>>>16)&255;b[o+3]=(v>>>24)&255;}
function w64(b,o,v){let n=BigInt(v);for(let i=0;i<8;i++){b[o+i]=Number(n&255n);n>>=8n;}}
function rawOffsetPE(ptr){const b=new Uint8Array(0x1200),pe=0x80,coff=pe+4,opt=coff+20,os=0xf0,s=opt+os;w16(b,0,0x5a4d);w32(b,0x3c,pe);w32(b,pe,0x4550);w16(b,coff,0x8664);w16(b,coff+2,1);w16(b,coff+16,os);w16(b,opt,0x20b);w64(b,opt+24,0x140000000n);w32(b,opt+32,0x1000);w32(b,opt+36,0x200);w32(b,opt+56,0x2000);w32(b,opt+60,0x200);w16(b,opt+68,3);b.set(new TextEncoder().encode('.text\0\0\0'),s);w32(b,s+8,0x200);w32(b,s+12,0x1000);w32(b,s+16,0x200);w32(b,s+20,ptr);w32(b,s+36,0x60000020);return b;}
const va=0x140001000n;
{const b=rawOffsetPE(0x820);b[0x800]=0x41;b[0x820]=0x43;const i=parsePE(b);assert.equal(i.sections[0].fileOffset,0x800n);assert.equal(i.readVirtual(va,1)?.[0],0x41);assert.equal(i.metadata.peSectionRawMappings[0].declaredFileOffset,0x820);assert.equal(i.metadata.peSectionRawMappings[0].effectiveFileOffset,0x800);assert.ok(i.warnings.some(x=>x.includes('0x820')&&x.includes('0x800')));}
{const i=parsePE(rawOffsetPE(0x9ff));assert.equal(i.sections[0].fileOffset,0x800n);}
{const i=parsePE(rawOffsetPE(0));assert.equal(i.sections[0].fileSize,0n);assert.equal(i.addressToOffset(va),null);assert.equal(i.readVirtual(va,1)?.[0],0);assert.equal(i.metadata.peSectionRawMappings[0].fileBacked,false);}
{const i=parsePE(rawOffsetPE(1));assert.equal(i.sections[0].fileOffset,0n);assert.equal(i.sections[0].fileSize,0x200n);assert.equal(i.addressToOffset(va),0n);assert.equal(i.metadata.peSectionRawMappings[0].fileBacked,true);}
{const i=parsePE(rawOffsetPE(0x800));assert.equal(i.sections[0].fileOffset,0x800n);assert.equal(i.metadata.peSectionRawMappings[0].roundedDown,false);}
console.log('issue 970 + PE raw-offset mapping regressions: PASS');

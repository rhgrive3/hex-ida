import assert from 'node:assert/strict';
import { parseMachO, repairMachOZeroEntrypoint } from '../js/binary/macho.js';
import { repairElfZeroAddressFunctionSeeds } from '../js/binary/elf.js';
import { BinaryImage } from '../js/binary/model.js';

function putAscii(bytes, off, text) { for (let i=0;i<text.length;i++) bytes[off+i]=text.charCodeAt(i); }
function machoZeroThreadFixture() {
  const bytes = new Uint8Array(0x400); const d = new DataView(bytes.buffer);
  d.setUint32(0,0xfeedfacf,true); d.setUint32(4,0x0100000c,true); d.setUint32(8,0,true); d.setUint32(12,2,true);
  d.setUint32(16,2,true); d.setUint32(20,72+288,true); d.setUint32(24,0,true); d.setUint32(28,0,true);
  const seg=32; d.setUint32(seg,0x19,true); d.setUint32(seg+4,72,true); putAscii(bytes,seg+8,'__TEXT');
  d.setBigUint64(seg+24,0n,true); d.setBigUint64(seg+32,0x1000n,true); d.setBigUint64(seg+40,0n,true); d.setBigUint64(seg+48,BigInt(bytes.length),true);
  d.setInt32(seg+56,5,true); d.setInt32(seg+60,5,true);
  const thread=seg+72; d.setUint32(thread,5,true); d.setUint32(thread+4,288,true); d.setUint32(thread+8,6,true); d.setUint32(thread+12,68,true);
  d.setBigUint64(thread+16+256,0n,true); return bytes;
}

const macho = parseMachO(machoZeroThreadFixture());
assert.equal(macho.entrypoint,0n);
assert.equal(macho.metadata.entrypointValid,true);
assert.ok(macho.functions.some((f)=>f.address===0n&&f.source==='entrypoint'));
const badMacho = new BinaryImage(new Uint8Array(4),{format:'macho',arch:'arm64',entrypoint:0n,metadata:{entrypointSource:'LC_MAIN'}});
repairMachOZeroEntrypoint(badMacho);
assert.equal(badMacho.metadata.entrypointValid,false);
assert.equal(badMacho.functions.length,0);

const elf = new BinaryImage(new Uint8Array(16),{format:'elf',arch:'arm64'});
elf.addSegment({address:0n,size:16n,fileOffset:0n,fileSize:16n,perms:{read:true,execute:true}});
elf.symbols.push({name:'entry0',address:0n,size:4n,kind:'function',defined:true,source:'symtab'});
repairElfZeroAddressFunctionSeeds(elf);
assert.ok(elf.functions.some((f)=>f.address===0n&&f.name==='entry0'));
const ifunc = new BinaryImage(new Uint8Array(16),{format:'elf',arch:'arm64'});
ifunc.addSegment({address:0n,size:16n,fileOffset:0n,fileSize:16n,perms:{read:true,execute:true}});
ifunc.symbols.push({name:'resolver',address:0n,size:4n,kind:'indirect-function',defined:true,source:'PT_DYNAMIC'});
repairElfZeroAddressFunctionSeeds(ifunc);
assert.ok(ifunc.functions.some((f)=>f.address===0n&&f.name==='resolver$resolver'));
const undef = new BinaryImage(new Uint8Array(16),{format:'elf',arch:'arm64'});
undef.addSegment({address:0n,size:16n,fileOffset:0n,fileSize:16n,perms:{read:true,execute:true}});
undef.symbols.push({name:'undef',address:0n,size:4n,kind:'function',defined:false});
repairElfZeroAddressFunctionSeeds(undef);
assert.equal(undef.functions.length,0);
const noexec = new BinaryImage(new Uint8Array(16),{format:'elf',arch:'arm64'});
noexec.addSegment({address:0n,size:16n,fileOffset:0n,fileSize:16n,perms:{read:true,execute:false}});
noexec.symbols.push({name:'data0',address:0n,size:4n,kind:'function',defined:true});
repairElfZeroAddressFunctionSeeds(noexec);
assert.equal(noexec.functions.length,0);
console.log('issues #2104/#2116 regressions: PASS');

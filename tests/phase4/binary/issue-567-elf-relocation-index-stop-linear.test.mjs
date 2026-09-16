import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

const SHT_NULL=0, SHT_PROGBITS=1, SHT_SYMTAB=2, SHT_STRTAB=3, SHT_RELA=4;
const ET_REL=1, X86_64=62;

function build(symbolCount, relocationSections) {
  const enc = new TextEncoder();
  const strtabBytes=[0], nameOffset=[];
  for(let i=0;i<symbolCount;i++){nameOffset.push(strtabBytes.length);strtabBytes.push(...enc.encode(`s${i}\0`));}
  const names=['','.strtab','.symtab','.text','.rela.text','.shstrtab'];
  const shstrBytes=[], shstrOff=[];
  for(const name of names){shstrOff.push(shstrBytes.length);shstrBytes.push(...enc.encode(`${name}\0`));}
  const align=(v,a)=>v%a===0?v:v+(a-v%a);
  const strtab=0x80, symtab=align(strtab+strtabBytes.length,8), symEnt=24;
  const symSize=symEnt*(symbolCount+1), text=align(symtab+symSize,16), textSize=16;
  const shstr=text+textSize, shoff=align(shstr+shstrBytes.length,8);
  const shstrIndex=4+relocationSections, shnum=shstrIndex+1;
  const bytes=new Uint8Array(shoff+64*shnum), view=new DataView(bytes.buffer);
  bytes.set([0x7f,0x45,0x4c,0x46,2,1,1,0],0);
  view.setUint16(16,ET_REL,true); view.setUint16(18,X86_64,true); view.setUint32(20,1,true);
  view.setBigUint64(40,BigInt(shoff),true); view.setUint16(52,64,true); view.setUint16(54,56,true);
  view.setUint16(58,64,true); view.setUint16(60,shnum,true); view.setUint16(62,shstrIndex,true);
  bytes.set(strtabBytes,strtab); bytes.set(shstrBytes,shstr); bytes.fill(0x90,text,text+textSize);
  const sv=new DataView(bytes.buffer,symtab,symSize);
  for(let i=0;i<symbolCount;i++){const p=symEnt*(i+1);sv.setUint32(p,nameOffset[i],true);sv.setUint8(p+4,(1<<4)|2);sv.setUint16(p+6,0,true);}
  const sec=(index,{name=0,type,flags=0n,offset=0,size=0,link=0,info=0,align=1n,entsize=0n})=>{
    const p=shoff+index*64; view.setUint32(p,shstrOff[name],true); view.setUint32(p+4,type,true);
    view.setBigUint64(p+8,flags,true); view.setBigUint64(p+24,BigInt(offset),true); view.setBigUint64(p+32,BigInt(size),true);
    view.setUint32(p+40,link,true); view.setUint32(p+44,info,true); view.setBigUint64(p+48,align,true); view.setBigUint64(p+56,entsize,true);
  };
  sec(0,{type:SHT_NULL});
  sec(1,{name:1,type:SHT_STRTAB,offset:strtab,size:strtabBytes.length});
  sec(2,{name:2,type:SHT_SYMTAB,offset:symtab,size:symSize,link:1,info:1,align:8n,entsize:24n});
  sec(3,{name:3,type:SHT_PROGBITS,flags:0x6n,offset:text,size:textSize,align:16n});
  for(let i=0;i<relocationSections;i++) sec(4+i,{name:4,type:SHT_RELA,offset:text,size:0,link:2,info:3,align:8n,entsize:24n});
  sec(shstrIndex,{name:5,type:SHT_STRTAB,offset:shstr,size:shstrBytes.length});
  return bytes;
}

function parseAndCountSymbolFilters(symbols, sections) {
  const original=Array.prototype.filter; let checks=0;
  Array.prototype.filter=function(pred,...rest){
    const first=this[0];
    const isSymbolArray=this.length>0 && first && typeof first==='object'
      && Number.isInteger(first.tableIndex) && Number.isInteger(first.index) && typeof first.source==='string';
    if(isSymbolArray) return original.call(this,(value,index,array)=>{checks++;return pred(value,index,array);},...rest);
    return original.call(this,pred,...rest);
  };
  try { return { image:parseELF(build(symbols,sections)), checks }; }
  finally { Array.prototype.filter=original; }
}

const N=400, R=160;
const {image,checks}=parseAndCountSymbolFilters(N,R);
assert.equal(image.metadata.elfMetadata.complete,true);
assert.equal(image.symbols.length,N);
assert.equal(image.relocations.length,0);
assert.ok(checks <= N*2, `symbol-table predicate checks must be O(S), got ${checks} for S=${N}, R=${R}`);

const aborted=new AbortController(); aborted.abort();
const stopped=parseELF(build(N,R),{signal:aborted.signal});
assert.equal(stopped.metadata.elfMetadata.complete,false);
assert.ok(stopped.metadata.elfMetadata.reasons.includes('budget:aborted'));
assert.equal(stopped.metadata.elfMetadata.used.records,0,'pre-aborted budget must stop before symbol-table materialization');

console.log('issue-567 ELF relocation index stop/linear regression: PASS');

import { ByteView } from './reader.js';
import { ensureMachOMetadataBudget } from './macho-budget.js';

const LC_SEGMENT = 0x1;
const LC_SYMTAB = 0x2;
const LC_DYSYMTAB = 0xb;
const LC_SEGMENT_64 = 0x19;

const S_NON_LAZY_SYMBOL_POINTERS = 0x6;
const S_LAZY_SYMBOL_POINTERS = 0x7;
const S_SYMBOL_STUBS = 0x8;
const S_LAZY_DYLIB_SYMBOL_POINTERS = 0x10;
const S_THREAD_LOCAL_VARIABLE_POINTERS = 0x14;
const INDIRECT_SYMBOL_LOCAL = 0x80000000;
const INDIRECT_SYMBOL_ABS = 0x40000000;

const POINTER_SECTION_TYPES = new Set([
  S_NON_LAZY_SYMBOL_POINTERS,
  S_LAZY_SYMBOL_POINTERS,
  S_LAZY_DYLIB_SYMBOL_POINTERS,
  S_THREAD_LOCAL_VARIABLE_POINTERS,
]);

function thinKind(r) {
  if (r.length < 4) return null;
  const a=r.u8(0), b=r.u8(1), c=r.u8(2), d=r.u8(3);
  if (a===0xce && b===0xfa && c===0xed && d===0xfe) return { bits:32, littleEndian:true };
  if (a===0xcf && b===0xfa && c===0xed && d===0xfe) return { bits:64, littleEndian:true };
  if (a===0xfe && b===0xed && c===0xfa && d===0xce) return { bits:32, littleEndian:false };
  if (a===0xfe && b===0xed && c===0xfa && d===0xcf) return { bits:64, littleEndian:false };
  return null;
}

function readName(r, offset) {
  const bytes = r.slice(offset, 16);
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function sectionKey(section) {
  return `${section.segment}\u0000${section.name}\u0000${section.address}\u0000${section.fileOffset}`;
}

function scanLoadCommands(r, kind, image, budget) {
  const headerSize = kind.bits === 64 ? 32 : 28;
  if (r.length < headerSize) return null;
  const ncmds = r.u32(16);
  const sizeofcmds = r.u32(20);
  if (headerSize + sizeofcmds > r.length) return null;
  const end = headerSize + sizeofcmds;
  const symtabs=[];
  const dysymtabs=[];
  const rawSections=[];
  let p=headerSize;
  for (let i=0; i<ncmds; i++) {
    if (p+8 > end) return null;
    const cmd=r.u32(p), cmdsize=r.u32(p+4);
    if (cmdsize < 8 || p+cmdsize > end) return null;
    if (cmd===LC_SYMTAB && cmdsize===24) {
      symtabs.push({ symoff:r.u32(p+8), nsyms:r.u32(p+12), stroff:r.u32(p+16), strsize:r.u32(p+20) });
    } else if (cmd===LC_DYSYMTAB) {
      if (cmdsize!==80) {
        budget?.partial('indirect-symbols:command-size-invalid', `LC_DYSYMTAB has size ${cmdsize}, expected 80`);
      } else {
        dysymtabs.push({ indirectsymoff:r.u32(p+56), nindirectsyms:r.u32(p+60) });
      }
    } else if (cmd===LC_SEGMENT_64 && kind.bits===64 && cmdsize>=72) {
      const nsects=r.u32(p+64);
      if (72+nsects*80 > cmdsize) return null;
      for (let s=0,q=p+72; s<nsects; s++,q+=80) {
        rawSections.push({
          name:readName(r,q), segment:readName(r,q+16), address:r.u64(q+32), size:r.u64(q+40),
          fileOffset:BigInt(r.u32(q+48)), flags:r.u32(q+64),
          reserved1:r.u32(q+68), reserved2:r.u32(q+72), reserved3:r.u32(q+76),
        });
      }
    } else if (cmd===LC_SEGMENT && kind.bits===32 && cmdsize>=56) {
      const nsects=r.u32(p+48);
      if (56+nsects*68 > cmdsize) return null;
      for (let s=0,q=p+56; s<nsects; s++,q+=68) {
        rawSections.push({
          name:readName(r,q), segment:readName(r,q+16), address:BigInt(r.u32(q+32)), size:BigInt(r.u32(q+36)),
          fileOffset:BigInt(r.u32(q+40)), flags:r.u32(q+56),
          reserved1:r.u32(q+60), reserved2:r.u32(q+64), reserved3:null,
        });
      }
    }
    p+=cmdsize;
  }
  return { symtabs, dysymtabs, rawSections };
}

function attachReservedFields(image, rawSections) {
  const queues=new Map();
  for (const section of image.sections || []) {
    const key=sectionKey(section);
    const queue=queues.get(key) || [];
    queue.push(section);
    queues.set(key, queue);
  }
  for (const raw of rawSections) {
    const queue=queues.get(sectionKey(raw));
    const section=queue?.shift();
    if (!section) continue;
    section.reserved1=raw.reserved1;
    section.reserved2=raw.reserved2;
    if (raw.reserved3 != null) section.reserved3=raw.reserved3;
  }
}

function readIndexedSymbol(r, st, bits, index, budget) {
  const ent=bits===64 ? 16 : 12;
  const total=st.nsyms*ent;
  if (!Number.isSafeInteger(total) || st.symoff>r.length || total>r.length-st.symoff || st.stroff>r.length || st.strsize>r.length-st.stroff) return { error:'symbol-table-range-invalid' };
  const p=st.symoff+index*ent;
  if (!budget.take({ inputBytes:ent, records:1, objects:1, operations:2, estimatedHeapBytes:160 }, 'indirect-symbol-nlist')) return { error:'metadata-budget' };
  const strx=r.u32(p), type=r.u8(p+4), desc=r.u16(p+6);
  if (type & 0xe0) return { symbol:null };
  const ntype=type & 0x0e;
  const external=!!(type & 1);
  if (ntype!==0 || !external) return { symbol:null };
  if (strx>=st.strsize) return { error:'symbol-name-invalid' };
  const start=st.stroff+strx;
  const span=r.slice(start, st.strsize-strx);
  let nul=-1;
  for (let i=0;i<span.length;i++) if (span[i]===0) { nul=i; break; }
  if (nul<0) return { error:'symbol-name-invalid' };
  const name=new TextDecoder().decode(span.subarray(0,nul));
  if (!name) return { error:'symbol-name-invalid' };
  if (!budget.take({ stringBytes:name.length*2, estimatedHeapBytes:name.length*2+32 }, 'indirect-symbol-name')) return { error:'metadata-budget' };
  return { symbol:{ name, ordinal:(desc>>>8)&0xff, weak:!!(desc&0x40) } };
}

export function applyMachOIndirectSymbols(thinInput, image, opts={}) {
  const r=new ByteView(thinInput, { littleEndian:true });
  const kind=thinKind(r);
  if (!kind) return image;
  r.littleEndian=kind.littleEndian;
  const budget=ensureMachOMetadataBudget(image);
  const scanned=scanLoadCommands(r, kind, image, budget);
  if (!scanned) return image;
  attachReservedFields(image, scanned.rawSections);
  if (scanned.dysymtabs.length===0) return image;

  const status=image.metadata.indirectSymbols={ complete:true, records:0, sites:0, partialReason:null };
  const partial=(reason,warning) => {
    status.complete=false;
    status.partialReason ||= reason;
    budget.partial(`indirect-symbols:${reason}`, warning);
    return false;
  };
  if (budget.stopped) { status.complete=false; status.partialReason='metadata-budget'; return image; }
  if (scanned.dysymtabs.length!==1) { partial('duplicate-command', `Mach-O has ${scanned.dysymtabs.length} LC_DYSYMTAB commands; indirect symbols are ambiguous`); return image; }
  if (scanned.symtabs.length!==1) { partial('symbol-table-unavailable', 'LC_DYSYMTAB indirect symbols require exactly one LC_SYMTAB'); return image; }

  const dc=scanned.dysymtabs[0], st=scanned.symtabs[0];
  image.metadata.dysymtab={ indirectsymoff:dc.indirectsymoff, nindirectsyms:dc.nindirectsyms };
  const tableSize=dc.nindirectsyms*4;
  if (!Number.isSafeInteger(tableSize) || dc.indirectsymoff>r.length || tableSize>r.length-dc.indirectsymoff) { partial('table-range-invalid','LC_DYSYMTAB indirect symbol table exceeds Mach-O input'); return image; }

  const ptrSize=kind.bits===64 ? 8n : 4n;
  const symbolCache=new Map();
  const symbolAt=(index) => {
    if (symbolCache.has(index)) return symbolCache.get(index);
    const value=readIndexedSymbol(r, st, kind.bits, index, budget);
    symbolCache.set(index,value);
    return value;
  };

  for (const sec of image.sections || []) {
    const type=sec.flags & 0xff;
    const isStub=type===S_SYMBOL_STUBS;
    const isPointer=POINTER_SECTION_TYPES.has(type);
    if (!isStub && !isPointer) continue;
    let width;
    if (isStub) {
      width=BigInt(sec.reserved2 ?? 0);
      if (width<=0n) { partial('stub-size-invalid',`Mach-O S_SYMBOL_STUBS section ${sec.name} has zero reserved2 stub size`); continue; }
    } else width=ptrSize;
    if (sec.size % width !== 0n) { partial('entry-size-invalid',`Mach-O indirect section ${sec.name} size ${sec.size} is not a multiple of entry width ${width}`); continue; }
    const countBig=sec.size/width;
    if (countBig>BigInt(Number.MAX_SAFE_INTEGER)) { partial('section-count-invalid',`Mach-O indirect section ${sec.name} entry count exceeds safe integer range`); continue; }
    const count=Number(countBig), first=sec.reserved1 ?? 0;
    if (!Number.isSafeInteger(first) || first<0 || first>dc.nindirectsyms || count>dc.nindirectsyms-first) { partial('section-range-invalid',`Mach-O indirect section ${sec.name} references entries outside LC_DYSYMTAB table`); continue; }
    for (let i=0;i<count;i++) {
      if (!budget.take({ inputBytes:4, records:1, operations:2, estimatedHeapBytes:16 }, 'indirect-symbol-record')) { status.complete=false; status.partialReason ||= 'metadata-budget'; return image; }
      status.records++;
      const raw=r.u32(dc.indirectsymoff+(first+i)*4);
      if ((raw & (INDIRECT_SYMBOL_LOCAL|INDIRECT_SYMBOL_ABS))!==0) continue;
      if (raw>=st.nsyms) { partial('symbol-index-invalid',`Mach-O indirect symbol index ${raw} exceeds LC_SYMTAB symbol count ${st.nsyms}`); continue; }
      const decoded=symbolAt(raw);
      if (decoded.error) { if (decoded.error==='metadata-budget') { status.complete=false; status.partialReason ||= 'metadata-budget'; return image; } partial(decoded.error,`Mach-O indirect symbol index ${raw} has no usable LC_SYMTAB record`); continue; }
      const sym=decoded.symbol;
      if (!sym) continue;
      const imports=(image.imports || []).filter((imp)=>imp.name===sym.name && imp.ordinal===sym.ordinal && !!imp.weak===sym.weak);
      const preferred=imports.find((imp)=>imp.source==='symbol-table') || imports[0];
      if (!preferred) { partial('symbol-import-unavailable',`Mach-O indirect symbol ${sym.name} has no canonical import record`); continue; }
      const address=sec.address+BigInt(i)*width;
      if (imports.some((imp)=>(imp.sites||[]).some((site)=>site.address===address))) continue;
      if (!budget.take({ objects:1, operations:1, estimatedHeapBytes:96 }, 'indirect-symbol-site')) { status.complete=false; status.partialReason ||= 'metadata-budget'; return image; }
      preferred.sites ||= [];
      preferred.sites.push({ address, offset:sec.fileOffset+BigInt(i)*width, kind:isStub?'indirect-symbol-stub':'indirect-symbol-pointer' });
      status.sites++;
    }
  }
  return image;
}

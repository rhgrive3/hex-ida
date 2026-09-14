/*
 * Range copy: turn a selection of viewer rows into text on the clipboard.
 *
 * Fixed-width ARM64 keeps the chunked backend fast path. Variable-width
 * architectures must use the viewer's decoded row records so address, bytes
 * and assembly always come from the same proven instruction boundary.
 */
import { CHUNK_ROWS } from './backend.js';
import { addrHex, bytesHex, sizeText } from './format.js';
import { menu, alertDialog, copyTextLazy } from './ui.js';
import { t } from './i18n.js';
import { instructionNote, supportsBeginnerInstructionNotes } from './viewer/architecture-presentation.js';

export const MAX_COPY_ROWS = 200_000;
const MN_COL = 6;

function variableRows(app) { return app.viewer?.isVariableAsm?.() === true; }
function architectureId(app, region) {
  return String(app.viewer?.architectureId?.() || region?.capability?.architecture || app.backend?.platformInfo?.capability?.architecture || app.backend?.legacyInfo?.capability?.architecture || 'unknown').toLowerCase();
}
function rowHex(value, spaced) { const text = String(value || '').trim(); return spaced ? text : text.replace(/\s+/g, ''); }
function asmText(mn, ops, padded = false) { if (!mn) return ''; return ops ? (padded ? mn.padEnd(MN_COL) : mn) + ' ' + ops : mn; }
function explainedLine(app, architecture, row, data, ctx) {
  const mn = data?.mnemonic || '', ops = data?.operands || '', asm = asmText(mn, ops, true);
  let note = '';
  if (mn && supportsBeginnerInstructionNotes(architecture)) {
    const previous = row > 0 ? app.viewer.rowData(row - 1) : null;
    note = instructionNote(architecture, { mnemonic:mn, operands:ops, address:data.address, style:'ja', context:ctx, previous:previous?.mnemonic ? { mnemonic:previous.mnemonic, operands:previous.operands || '' } : null });
  }
  return addrHex(data.address) + '  ' + asm.padEnd(34) + (note ? '  ; ' + note : '');
}

export function rangeCopyItems(app) {
  const sel = app.viewer.selectionRange(); if (!sel) return [];
  const n = sel.count.toLocaleString();
  const items = [
    { label:t('sel.copyRows',{ n }), action:() => copyRange(app,'all') },
    { label:t('sel.copyAddresses'), action:() => copyRange(app,'address') },
    { label:t('sel.copyHex'), action:() => copyRange(app,'hex') },
  ];
  if (app.store.get('canDisassemble')) {
    items.push({ label:t('sel.copyAsm'), action:() => copyRange(app,'asm') });
    items.push({ label:t('sel.copyExplained'), action:() => copyRange(app,'explained') });
  }
  return items;
}
export function rangeCopyMenu(app,x,y) {
  const items=rangeCopyItems(app); if(!items.length)return;
  items.push('-', { label:t('sel.selectAll'), action:() => app.viewer.selectAllRows() }, { label:t('sel.clear'), action:() => app.viewer.clearRange() });
  menu(items,x,y);
}
export function copyRange(app, what) {
  const region=app.store.get('currentRegion'), sel=app.viewer.selectionRange(); if(!region||!sel)return;
  if(sel.count>MAX_COPY_ROWS){
    const variable=variableRows(app), fixed=app.viewer?.fixedInstructionSize?.();
    alertDialog(t('sel.tooLarge'), t('sel.tooLargeText',{ n:sel.count.toLocaleString(), max:MAX_COPY_ROWS.toLocaleString(), size:variable||!Number.isInteger(fixed)?t('sel.rows',{ n:MAX_COPY_ROWS.toLocaleString() }):sizeText(MAX_COPY_ROWS*fixed) }));
    return;
  }
  const wantAsm=(what==='asm'||what==='all'||what==='explained')&&!!app.store.get('canDisassemble')&&region.disasm!==false;
  const n=sel.count.toLocaleString(), label=t('sel.rows',{ n });
  app.setBusy(true,t('sel.copying',{ n }));
  const text=buildText(app,region,sel,what,wantAsm).finally(()=>app.setBusy(false));
  copyTextLazy(text,label);
}

export async function buildText(app, region, sel, what, wantAsm) {
  if (variableRows(app)) return buildVariableText(app,region,sel,what,wantAsm);
  return buildFixedText(app,region,sel,what,wantAsm);
}
async function buildVariableText(app, region, sel, what, wantAsm) {
  const spaced=!app.store.get('hexJoined'), out=[], architecture=architectureId(app,region);
  const ctx={ gen:app.symbols.gen, symbolFor:(a)=>app.symbols.nameAt(a) };
  for(let row=sel.start;row<=sel.end;row++){
    if(app.store.get('currentRegion')!==region)throw new Error(t('sel.regionChanged'));
    const data=app.viewer.rowData(row); if(!data||data.address==null)throw new Error('Selected instruction is no longer available');
    const hex=rowHex(data.bytes,spaced), mn=wantAsm?(data.mnemonic||''):'', ops=wantAsm?(data.operands||''):'';
    if(what==='address')out.push(addrHex(data.address));
    else if(what==='hex')out.push(hex);
    else if(what==='asm')out.push(asmText(mn,ops,true));
    else if(what==='explained')out.push(explainedLine(app,architecture,row,{...data,mnemonic:mn,operands:ops},ctx));
    else { const cells=[addrHex(data.address),hex]; if(wantAsm)cells.push(asmText(mn,ops)); out.push(cells.join('\t')); }
  }
  return out.join('\n');
}
async function buildFixedText(app, region, sel, what, wantAsm) {
  const spaced=!app.store.get('hexJoined'), first=Math.floor(sel.start/CHUNK_ROWS), last=Math.floor(sel.end/CHUNK_ROWS), out=[];
  const architecture=architectureId(app,region), ctx={ gen:app.symbols.gen, symbolFor:(a)=>app.symbols.nameAt(a) };
  for(let c=first;c<=last;c++){
    if(app.store.get('currentRegion')!==region)throw new Error(t('sel.regionChanged'));
    const entry=await app.backend.fetchChunk(region.id,c,wantAsm);
    if(app.store.get('currentRegion')!==region)throw new Error(t('sel.regionChanged'));
    const base=c*CHUNK_ROWS, from=Math.max(sel.start,base), to=Math.min(sel.end,base+CHUNK_ROWS-1);
    for(let row=from;row<=to;row++){
      const idx=row-base, off=idx*4, avail=entry.bytes?Math.min(4,entry.bytes.length-off):0;
      const hex=avail>0?bytesHex(entry.bytes,off,avail,spaced):'', mn=entry.mn?(entry.mn[idx]||''):'', ops=entry.ops?(entry.ops[idx]||''):'';
      if(what==='address')out.push(addrHex(app.viewer.rowAddress(row)));
      else if(what==='hex')out.push(hex);
      else if(what==='asm')out.push(asmText(mn,ops,true));
      else if(what==='explained'){
        const address=app.viewer.rowAddress(row);
        const note=mn&&supportsBeginnerInstructionNotes(architecture)?instructionNote(architecture,{ mnemonic:mn,operands:ops,address,style:'ja',context:ctx }):'';
        const asm=asmText(mn,ops,true); out.push(addrHex(address)+'  '+asm.padEnd(34)+(note?'  ; '+note:''));
      } else { const cells=[addrHex(app.viewer.rowAddress(row)),hex]; if(wantAsm)cells.push(asmText(mn,ops)); out.push(cells.join('\t')); }
    }
    if(last>first){const done=Math.round(((c-first+1)/(last-first+1))*100);app.setBusy(true,t('sel.copyingPct',{ n:sel.count.toLocaleString(),pct:done }));}
  }
  return out.join('\n');
}

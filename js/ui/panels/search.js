import { Sheet, el, button, list, tapRow, toast, alertDialog, userError } from '../../ui.js';
import { addrText, parseAddress, parseHexPattern } from '../../format.js';
import { t } from '../../i18n.js';

const SEARCH_PAGE_LIMIT = 1000;
function numberPattern(text) {
  const t2 = text.trim().replace(/[_,]/g, ''); let value;
  try {
    if (/^-?0x[0-9a-f]+$/i.test(t2)) value = BigInt(t2.replace('-0x', '0x')) * (t2[0] === '-' ? -1n : 1n);
    else if (/^-?\d+$/.test(t2)) value = BigInt(t2);
    else return null;
  } catch { return null; }
  const wide = value < -0x80000000n || value > 0xFFFFFFFFn; const bytes = wide ? 8 : 4;
  const unsigned = BigInt.asUintN(bytes * 8, value); const out = [];
  for (let i = 0; i < bytes; i++) out.push(Number((unsigned >> BigInt(i * 8)) & 0xffn).toString(16).padStart(2, '0'));
  return out.join(' ');
}
function isAbort(error) { return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'; }

export function showSearch(app) {
  const region = app.store.get('currentRegion'); if (!region) return;
  let runController = null;
  const sheet = new Sheet(t('search.title'), { onClose:() => runController?.abort('search-sheet-closed') });
  let kind = app.store.get('searchKind') || 'asm';
  const chips = el('div', 'chips');
  const defs = [['asm',t('search.kind.asm')],['text',t('search.kind.text')],['hex',t('search.kind.hex')],['num',t('search.kind.num')],['addr',t('search.kind.addr')]];
  const chipEls = new Map();
  for (const [key,label] of defs) { const chip = button(label, 'chip', () => setKind(key)); chip.setAttribute('aria-pressed', String(key === kind)); chipEls.set(key, chip); chips.append(chip); }
  const field = el('div', 'field'); const input = el('input'); input.type='search'; input.autocapitalize='off'; input.autocomplete='off'; input.spellcheck=false; input.value=app.store.get('searchQuery') || '';
  const goBtn = button(t('btn.find'), 'chip', () => (runController ? stop() : run())); field.append(input, goBtn);
  const bar = el('div','progress'); const fill = el('i'); bar.append(fill); const status = el('div','hint',''); const results=list();
  sheet.body.append(chips, field, bar, status, results); setKind(kind); setTimeout(() => input.focus(), 50);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });

  function setKind(next) {
    kind=next; app.store.set({searchKind:next});
    for (const [key,chip] of chipEls) chip.setAttribute('aria-pressed', String(key === next));
    input.placeholder=t('search.ph.'+next); status.textContent=t('search.help.'+next,{region:region.name});
  }
  async function run() {
    const text=input.value.trim(); app.store.set({searchQuery:text}); if(!text){toast(t('search.needQuery'));return;}
    if(kind==='addr') { const address=parseAddress(text); if(address==null){toast(t('search.badAddr'));return;} sheet.close(); app.goToAddress(address,{announce:true}); return; }
    runController?.abort('search-replaced'); const controller=new AbortController(); runController=controller;
    results.replaceChildren(); fill.style.width='0%'; status.textContent=t('search.searching'); goBtn.textContent=t('btn.stop');
    const query={regionId:region.id,kind,from:0};
    if(kind==='hex'||kind==='num') {
      const patternText=kind==='num'?numberPattern(text):text; const pattern=patternText?parseHexPattern(patternText):null;
      if(!pattern){toast(t(kind==='num'?'search.badNum':'search.badHex'));runController=null;goBtn.textContent=t('btn.find');return;}
      query.kind='hex'; query.hex=pattern;
    } else query.query=text;
    try {
      const snapshot=await app.analysisQueries.snapshot({signal:controller.signal});
      const response=await app.analysisQueries.search(snapshot,query,{offset:0,limit:SEARCH_PAGE_LIMIT},{
        signal:controller.signal,
        onProgress:(progress)=>{if(!progress?.all)return;fill.style.width=Math.min(100,Math.round(progress.done/progress.all*100))+'%';status.textContent=t('search.searchingN',{n:progress.hits??0});},
      });
      if(controller.signal.aborted)return;
      const items=response.value||[]; fill.style.width='100%';
      status.textContent=!items.length?t('search.none',{region:region.name}):t('search.count',{n:items.length})+(response.completeness!=='complete'?t('search.capped',{n:items.length}):'');
      render(items);
    } catch(error) {
      if(!isAbort(error)){status.textContent='';alertDialog(t('search.failed'),userError(error));}
      else status.textContent=t('search.stopped',{n:0});
    } finally { if(runController===controller)runController=null; goBtn.textContent=t('btn.find'); }
  }
  function stop(){runController?.abort('search-stopped');runController=null;goBtn.textContent=t('btn.find');status.textContent=t('search.stopped',{n:0});}
  const PAGE=150;
  function render(items){
    results.replaceChildren(); let shown=0; const more=tapRow(t('search.more'),{onTap:()=>page()});
    const page=()=>{more.remove();const frag=document.createDocumentFragment();const end=Math.min(items.length,shown+PAGE);
      for(;shown<end;shown++){const item=items[shown];frag.append(tapRow(addrText(item.addr),{sub:item.text,onTap:()=>{sheet.close();app.viewer.goToRow(item.row,'third');app.viewer.mark(item.row);app.viewer.select(item.row,false);app.store.set({selectedRow:item.row});}}));}
      results.append(frag);if(shown<items.length){more.replaceChildren();more.append(el('div',null,t('search.showMore',{n:Math.min(PAGE,items.length-shown)})));results.append(more);}};
    if(items.length)page();
  }
}

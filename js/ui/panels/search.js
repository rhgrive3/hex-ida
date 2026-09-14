import { Sheet, el, button, list, tapRow, toast, alertDialog, userError } from '../../ui.js';
import { addrText, parseAddress, parseHexPattern } from '../../format.js';
import { numberPattern } from '../numeric-pattern.js';
import { t } from '../../i18n.js';

const SEARCH_PAGE_LIMIT = 1000;
function isAbort(error) { return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'; }

export function createSearchPager(queries, snapshot, query) {
  let offset = 0;
  let done = false;
  let completeness = 'complete';
  return {
    get hasMore() { return !done; },
    get completeness() { return completeness; },
    async next(options = {}) {
      if (done) return { value:[], completeness, done:true };
      const currentOffset = offset;
      const response = await queries.search(snapshot, query, { offset:currentOffset, limit:SEARCH_PAGE_LIMIT }, options);
      const value = Array.isArray(response?.value) ? response.value : [];
      if (!Array.isArray(response?.value) || response?.completeness !== 'complete') completeness = 'partial';
      const page = response?.page;
      if (!page || !Object.hasOwn(page, 'next')) {
        completeness = 'partial'; done = true;
      } else if (page.next === null) {
        done = true;
      } else {
        const expectedNext = currentOffset + value.length;
        if (!Number.isSafeInteger(page.next) || page.next <= currentOffset || page.next !== expectedNext) {
          completeness = 'partial'; done = true;
        } else offset = page.next;
      }
      return { value, completeness, done };
    },
  };
}

export function createSearchRunLifecycle() {
  let active = null;
  const owns = (controller) => active === controller && !controller.signal.aborted;
  return {
    get active() { return active; },
    replace(reason = 'search-replaced') {
      const previous = active;
      const controller = new AbortController();
      active = controller;
      previous?.abort(reason);
      return controller;
    },
    start() {
      if (active) return null;
      active = new AbortController();
      return active;
    },
    runIfActive(controller, effect) {
      if (!owns(controller)) return false;
      effect();
      return true;
    },
    cancel(reason) {
      const controller = active;
      active = null;
      controller?.abort(reason);
      return controller;
    },
    finish(controller, effect) {
      if (active !== controller) return false;
      active = null;
      effect?.();
      return true;
    },
  };
}

export function showSearch(app) {
  const region = app.store.get('currentRegion'); if (!region) return;
  const runs = createSearchRunLifecycle();
  const sheet = new Sheet(t('search.title'), { onClose:() => runs.cancel('search-sheet-closed') });
  let kind = app.store.get('searchKind') || 'asm';
  const chips = el('div', 'chips');
  const defs = [['asm',t('search.kind.asm')],['text',t('search.kind.text')],['hex',t('search.kind.hex')],['num',t('search.kind.num')],['addr',t('search.kind.addr')]];
  const chipEls = new Map();
  for (const [key,label] of defs) { const chip = button(label, 'chip', () => setKind(key)); chip.setAttribute('aria-pressed', String(key === kind)); chipEls.set(key, chip); chips.append(chip); }
  const field = el('div', 'field'); const input = el('input'); input.type='search'; input.autocapitalize='off'; input.autocomplete='off'; input.spellcheck=false; input.value=app.store.get('searchQuery') || '';
  const goBtn = button(t('btn.find'), 'chip', () => (runs.active ? stop() : run())); field.append(input, goBtn);
  const bar = el('div','progress'); const fill = el('i'); bar.append(fill); const status = el('div','hint',''); const results=list();
  sheet.body.append(chips, field, bar, status, results); setKind(kind); setTimeout(() => input.focus(), 50);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });

  function setKind(next) {
    kind=next; app.store.set({searchKind:next});
    for (const [key,chip] of chipEls) chip.setAttribute('aria-pressed', String(key === next));
    input.placeholder=t('search.ph.'+next); status.textContent=t('search.help.'+next,{region:region.name});
  }
  const progressFor = (controller) => (progress) => {
    if (!progress?.all) return;
    runs.runIfActive(controller, () => {
      fill.style.width=Math.min(100,Math.round(progress.done/progress.all*100))+'%';
      status.textContent=t('search.searchingN',{n:progress.hits??0});
    });
  };
  const updateStatus = (items, pager) => {
    status.textContent=!items.length?t('search.none',{region:region.name}):t('search.count',{n:items.length})+(pager.completeness!=='complete'?t('search.capped',{n:items.length}):'');
  };
  async function run() {
    const text=input.value.trim(); app.store.set({searchQuery:text}); if(!text){toast(t('search.needQuery'));return;}
    if(kind==='addr') { const address=parseAddress(text); if(address==null){toast(t('search.badAddr'));return;} sheet.close(); app.goToAddress(address,{announce:true}); return; }
    const controller=runs.replace();
    results.replaceChildren(); fill.style.width='0%'; status.textContent=t('search.searching'); goBtn.textContent=t('btn.stop');
    const query={regionId:region.id,kind,from:0};
    if(kind==='hex'||kind==='num') {
      const patternText=kind==='num'?numberPattern(text):text; const pattern=patternText?parseHexPattern(patternText):null;
      if(!pattern){toast(t(kind==='num'?'search.badNum':'search.badHex'));runs.finish(controller,()=>{goBtn.textContent=t('btn.find');});return;}
      query.kind='hex'; query.hex=pattern;
    } else query.query=text;
    try {
      const snapshot=await app.analysisQueries.snapshot({signal:controller.signal});
      const pager=createSearchPager(app.analysisQueries,snapshot,query);
      const response=await pager.next({ signal:controller.signal, onProgress:progressFor(controller) });
      runs.runIfActive(controller, () => {
        const items=response.value; fill.style.width='100%';
        updateStatus(items,pager);
        render(items,pager);
      });
    } catch(error) {
      runs.runIfActive(controller, () => {
        if(!isAbort(error)){status.textContent='';alertDialog(t('search.failed'),userError(error));}
        else status.textContent=t('search.stopped',{n:0});
      });
    } finally { runs.finish(controller,()=>{goBtn.textContent=t('btn.find');}); }
  }
  function stop(){
    if(!runs.cancel('search-stopped'))return;
    goBtn.textContent=t('btn.find');status.textContent=t('search.stopped',{n:0});
  }
  const PAGE=150;
  function render(initialItems,pager){
    const items=[...initialItems];
    results.replaceChildren(); let shown=0; let loading=false;
    const more=tapRow(t('search.more'),{onTap:()=>{void page();}});
    const addMore=()=>{
      if(shown>=items.length&&!pager.hasMore)return;
      const remaining=items.length-shown;
      more.replaceChildren();more.append(el('div',null,t('search.showMore',{n:Math.min(PAGE,remaining||PAGE)})));results.append(more);
    };
    const page=async()=>{
      if(loading)return;
      more.remove();
      if(shown>=items.length&&pager.hasMore){
        const controller=runs.start();
        if(!controller){addMore();return;}
        loading=true; goBtn.textContent=t('btn.stop');
        try {
          const response=await pager.next({ signal:controller.signal, onProgress:progressFor(controller) });
          if(!runs.runIfActive(controller, () => {
            items.push(...response.value); fill.style.width='100%'; updateStatus(items,pager);
          }))return;
        } catch(error) {
          if(!runs.runIfActive(controller, () => {
            if(!isAbort(error)){alertDialog(t('search.failed'),userError(error));addMore();}
          }))return;
          return;
        } finally {
          loading=false;
          runs.finish(controller,()=>{goBtn.textContent=t('btn.find');});
        }
      }
      const frag=document.createDocumentFragment();const end=Math.min(items.length,shown+PAGE);
      for(;shown<end;shown++){const item=items[shown];frag.append(tapRow(addrText(item.addr),{sub:item.text,onTap:()=>{sheet.close();app.viewer.goToRow(item.row,'third');app.viewer.mark(item.row);app.viewer.select(item.row,false);app.store.set({selectedRow:item.row});}}));}
      results.append(frag);addMore();
    };
    if(items.length)void page();
  }
}

import { Sheet, el, button, list, tapRow, toast, alertDialog, userError } from '../../ui.js';
import { addrText, parseAddress, parseHexPattern } from '../../format.js';
import { numberPattern } from '../numeric-pattern.js';
import { t, pick } from '../../i18n.js';
import { showCandidates } from './investigation.js';
import { showField } from './field-access.js';
import { showClassTree } from './class-tree.js';
import {
  scoreSearchMatch,
  compareSearchResults,
  rankSearchResults,
  matchGoalForQuery,
  buildOmniboxSearchItems,
  SEARCH_CATEGORIES,
} from '../../ai/interaction/omnibox.js';

export {
  scoreSearchMatch,
  compareSearchResults,
  rankSearchResults,
  matchGoalForQuery,
  buildOmniboxSearchItems,
  SEARCH_CATEGORIES,
};

const SEARCH_PAGE_LIMIT = 1000;
const UNIFIED_COLLECT_LIMIT = 50000;

// Search can be opened from any screen (the omnibox "> 検索"); a hit is
// only visible in the code view, so bring that view forward first.
function showCodeRoute() {
  const router = typeof window !== 'undefined' ? window.__hexUi?.router : null;
  if (router && router.current?.route?.id !== 'code') router.navigate('/code');
}
function isAbort(error) { return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'; }

function collectFunctions(app, seenClasses) {
  const out = [];
  const seen = new Set();
  const pushFn = (name, addr) => {
    if (!name || typeof name !== 'string') return;
    const key = `${name}@${addr != null ? String(addr) : ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind: 'function',
      category: 'function',
      badge: SEARCH_CATEGORIES.function,
      name,
      addr: addr ?? null,
      sub: addr != null ? addrText(addr) : '',
    });
    // Also surface C++ class/namespace prefixes (e.g. Player::getHP -> Player)
    const sep = name.indexOf('::');
    if (sep > 0) {
      const clsName = name.slice(0, sep).replace(/^_+/, '');
      if (clsName && !seenClasses.has(clsName)) {
        seenClasses.set(clsName, { name: clsName, addr: addr ?? null, sub: 'C++' });
      }
    }
  };

  try {
    if (typeof app?.symbols?.functionList === 'function') {
      const fns = app.symbols.functionList(null, UNIFIED_COLLECT_LIMIT) || [];
      for (const fn of fns) {
        if (!fn) continue;
        const name = fn.name || (fn.addr != null ? app.symbols?.nameAt?.(fn.addr) : null);
        if (name) pushFn(name, fn.addr);
      }
    }
  } catch { /* graceful fallback */ }

  try {
    if (typeof app?.symbols?.symbolList === 'function') {
      const syms = app.symbols.symbolList({ max: UNIFIED_COLLECT_LIMIT }) || [];
      for (const sym of syms) {
        if (sym?.name) pushFn(sym.name, sym.addr);
      }
    }
  } catch { /* graceful fallback */ }

  if (Array.isArray(app?.functions)) {
    for (const fn of app.functions) {
      if (fn?.name) pushFn(fn.name, fn.addr);
    }
  }

  return out;
}

function collectStrings(app) {
  const out = [];
  const seen = new Set();
  const sources = [];
  if (Array.isArray(app?.stringIndex)) sources.push(app.stringIndex);
  if (Array.isArray(app?.strings)) sources.push(app.strings);
  const storeStrings = app?.store?.get?.('strings');
  if (Array.isArray(storeStrings)) sources.push(storeStrings);

  for (const listSource of sources) {
    for (const s of listSource) {
      const text = typeof s === 'string' ? s : (s?.text ?? s?.value ?? '');
      if (!text) continue;
      const addr = typeof s === 'object' ? (s?.addr ?? null) : null;
      const key = `${text}@${addr != null ? String(addr) : ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'string',
        category: 'string',
        badge: SEARCH_CATEGORIES.string,
        name: text,
        addr,
        sub: addr != null ? addrText(addr) : '',
      });
    }
  }
  return out;
}

function syncAutoReportWasm(app) {
  const report = app?.autoReport?.report;
  if (!report) return;
  try {
    if (typeof app._syncAutoReportWasmAnalysis === 'function') {
      app._syncAutoReportWasmAnalysis(report);
    } else if (report.wasmAnalysis && !app.v6Workbench?._wasmAnalysis && typeof app.v6Workbench?.ingestWasmAnalysis === 'function') {
      app.v6Workbench.ingestWasmAnalysis(report.wasmAnalysis);
    }
  } catch { /* non-fatal */ }
}

function collectClassesAndFields(app, inferredClasses) {
  syncAutoReportWasm(app);
  const classes = [];
  const fields = [];
  const seenClassNames = new Set();
  const seenFieldKeys = new Set();

  const pushClass = (name, addr = null, sub = '') => {
    if (!name || typeof name !== 'string' || seenClassNames.has(name)) return;
    seenClassNames.add(name);
    classes.push({
      kind: 'class',
      category: 'class',
      badge: SEARCH_CATEGORIES.class,
      name,
      addr,
      className: name,
      sub: sub || (addr != null ? addrText(addr) : ''),
    });
  };

  const pushField = (className, fieldName, { offset = null, addr = null, altName = null, field = null } = {}) => {
    if (!fieldName || typeof fieldName !== 'string') return;
    const displayName = className ? `${className}.${fieldName}` : fieldName;
    const key = `${displayName}@${offset ?? ''}`;
    if (seenFieldKeys.has(key)) return;
    seenFieldKeys.add(key);
    const subParts = [];
    if (offset != null && Number.isFinite(Number(offset))) subParts.push(`+0x${Number(offset).toString(16)}`);
    if (addr != null) subParts.push(addrText(addr));
    fields.push({
      kind: 'field',
      category: 'field',
      badge: SEARCH_CATEGORIES.field,
      name: displayName,
      altName: altName || fieldName,
      fieldName,
      className: className || null,
      offset,
      addr,
      field: field || (offset != null ? { name: fieldName, offset } : null),
      sub: subParts.join(' · '),
    });
  };

  // FieldIndex (Map of className -> { name, ivars })
  if (app?.fields?.classes instanceof Map) {
    for (const cls of app.fields.classes.values()) {
      if (!cls?.name) continue;
      pushClass(cls.name, cls.addr ?? null, cls.ivars?.length ? `${cls.ivars.length} fields` : '');
      for (const iv of cls.ivars || []) {
        if (iv?.name) {
          pushField(cls.name, iv.name, {
            offset: iv.offset ?? null,
            addr: iv.offsetVar ?? iv.addr ?? null,
            altName: iv.property?.name || iv.name,
            field: iv,
          });
        }
      }
    }
  }

  // Raw objcModel.classes array fallback
  if (Array.isArray(app?.objcModel?.classes)) {
    for (const cls of app.objcModel.classes) {
      if (!cls?.name) continue;
      pushClass(cls.name, cls.addr ?? null);
      for (const iv of cls.ivars || []) {
        if (iv?.name) {
          pushField(cls.name, iv.name, {
            offset: iv.offset ?? null,
            addr: iv.offsetVar ?? iv.addr ?? null,
            altName: iv.property?.name || iv.name,
            field: iv,
          });
        }
      }
    }
  }

  // Direct array/Map stores for classes and fields (graceful support for lightweight apps/tests)
  if (app?.classes instanceof Map) {
    for (const cls of app.classes.values()) {
      const name = typeof cls === 'string' ? cls : cls?.name;
      if (name) pushClass(name, cls?.addr ?? null);
    }
  } else if (Array.isArray(app?.classes)) {
    for (const cls of app.classes) {
      const name = typeof cls === 'string' ? cls : cls?.name;
      if (name) pushClass(name, cls?.addr ?? null);
    }
  }

  if (Array.isArray(app?.fields)) {
    for (const f of app.fields) {
      if (f?.name) {
        pushField(f.className || null, f.name, {
          offset: f.offset ?? null,
          addr: f.addr ?? f.offsetVar ?? null,
          altName: f.plain || f.name,
          field: f,
        });
      }
    }
  }

  // Restored C++ RTTI classes from V6Workbench
  try {
    const cxxRtti = typeof app?.v6Workbench?.getCxxRtti === 'function'
      ? app.v6Workbench.getCxxRtti()
      : null;
    if (Array.isArray(cxxRtti?.classes)) {
      for (const cls of cxxRtti.classes) {
        if (!cls || typeof cls !== 'object') continue;
        const name = typeof cls.className === 'string' && cls.className
          ? cls.className
          : (typeof cls.name === 'string' && cls.name ? cls.name : null);
        if (!name) continue;
        const repAddr = cls.vtableVas?.[0]?.va ?? cls.rttiVa ?? cls.methods?.[0]?.fnVa ?? null;
        const methodCount = typeof cls.methodCount === 'number'
          ? cls.methodCount
          : (Array.isArray(cls.methods) ? cls.methods.length : 0);
        const sub = methodCount > 0 ? `C++ RTTI · ${methodCount} methods` : 'C++ RTTI';
        pushClass(name, repAddr, sub);
      }
    }
  } catch { /* graceful fallback */ }

  // C++ classes inferred from qualified symbol names
  for (const [name, info] of inferredClasses.entries()) {
    pushClass(name, info.addr, info.sub);
  }

  return { classes, fields };
}

/**
 * Unified multi-entity search across functions, strings, ObjC/C++ classes, and fields,
 * ranked by relevance (word-boundary first) and bridged to matching goals.
 *
 * @param {object} app
 * @param {string} query
 * @returns {{ query: string, goalAction: object | null, items: Array<object>, results: Array<object> }}
 */
export function unifiedSearch(app, query) {
  const raw = String(query ?? '').trim();
  if (!raw) return { query: '', goalAction: null, items: [], results: [] };

  const inferredClasses = new Map();
  const functions = collectFunctions(app, inferredClasses);
  const strings = collectStrings(app);
  const { classes, fields } = collectClassesAndFields(app, inferredClasses);

  const combined = buildOmniboxSearchItems(raw, [...functions, ...strings, ...classes, ...fields]);
  const goalAction = combined.length > 0 && combined[0].kind === 'goal' ? combined[0] : null;
  const items = goalAction ? combined.slice(1) : combined;

  return {
    query: raw,
    goalAction,
    items,
    results: combined,
  };
}

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
  syncAutoReportWasm(app);
  const region = app.store?.get?.('currentRegion');
  const virtualTree = typeof app?.v6Workbench?.getVirtualTree === 'function'
    ? app.v6Workbench.getVirtualTree()
    : null;
  if (!region && !app.symbols && !app.fields && !app.stringIndex && !virtualTree) return;
  const runs = createSearchRunLifecycle();
  const sheet = new Sheet(t('search.title'), { onClose:() => runs.cancel('search-sheet-closed') });
  let kind = app.store?.get?.('searchKind') || 'unified';
  const chips = el('div', 'chips');
  const defs = [
    ['unified', pick('すべて', 'All')],
    ['asm', t('search.kind.asm')],
    ['text', t('search.kind.text')],
    ['hex', t('search.kind.hex')],
    ['num', t('search.kind.num')],
    ['addr', t('search.kind.addr')],
  ];
  const chipEls = new Map();
  for (const [key,label] of defs) { const chip = button(label, 'chip', () => setKind(key)); chip.setAttribute('aria-pressed', String(key === kind)); chipEls.set(key, chip); chips.append(chip); }
  if (virtualTree) {
    const classTreeBtn = button(pick('クラスツリー', 'Class Tree'), 'chip', () => {
      sheet.close();
      showClassTree(app, { tree: virtualTree });
    });
    classTreeBtn.dataset.action = 'open-class-tree';
    chips.append(classTreeBtn);
  }
  const field = el('div', 'field'); const input = el('input'); input.type='search'; input.autocapitalize='off'; input.autocomplete='off'; input.spellcheck=false; input.value=app.store?.get?.('searchQuery') || '';
  const goBtn = button(t('btn.find'), 'chip', () => (runs.active ? stop() : run())); field.append(input, goBtn);
  const bar = el('div','progress'); const fill = el('i'); bar.append(fill); const status = el('div','hint',''); const results=list();
  sheet.body.append(chips, field, bar, status, results); setKind(kind); setTimeout(() => input.focus(), 50);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });

  function setKind(next) {
    kind=next; app.store?.set?.({searchKind:next});
    for (const [key,chip] of chipEls) chip.setAttribute('aria-pressed', String(key === next));
    if (next === 'unified') {
      input.placeholder = pick('例: HP, 攻撃, Player, _hp', 'e.g. HP, attack, Player, _hp');
      status.textContent = pick('関数・文字列・クラス・フィールドを関連度順で検索します。', 'Search functions, strings, classes, and fields ranked by relevance.');
    } else {
      input.placeholder=t('search.ph.'+next); status.textContent=t('search.help.'+next,{region:region?.name || ''});
    }
  }
  function createGoalBridgeRow(goalAction) {
    const row = tapRow(goalAction.label, {
      sub: pick('目的として自動解析・候補絞り込みを開く', 'Investigate candidates for this goal'),
      tag: pick('目的', 'Goal'),
      tagClass: 'search-goal-badge',
      onTap: () => {
        sheet.close();
        if (typeof app.showCandidates === 'function') app.showCandidates(goalAction.goal);
        else showCandidates(app, goalAction.goal);
      },
    });
    row.classList.add('search-goal-bridge');
    return row;
  }
  function navigateToAddress(item) {
    sheet.close();
    showCodeRoute();
    const isVariable=Boolean(app.viewer?.isVariableAsm?.());
    if(item.addr!=null&&(typeof app.goToAddress==='function'||typeof app.viewer?.goToAddress==='function')){
      const navigated=typeof app.goToAddress==='function'
        ?app.goToAddress(item.addr,{announce:true})
        :app.viewer.goToAddress(item.addr);
      if(navigated){
        const row=app.viewer?.rowOfAddress?.(item.addr)??(isVariable?null:item.row);
        if(row!=null){
          app.viewer?.mark?.(row);
          app.viewer?.select?.(row,false);
          app.store?.set?.({selectedRow:row});
        }
      }
      return;
    }
    if(!isVariable&&item.row!=null){
      app.viewer.goToRow(item.row,'third');
      app.viewer.mark(item.row);
      app.viewer.select(item.row,false);
      app.store?.set?.({selectedRow:item.row});
    }
  }
  function openUnifiedItem(item) {
    if (!item) return;
    const router = typeof window !== 'undefined' ? window.__hexUi?.router : null;
    if (item.category === 'class') {
      sheet.close();
      if (typeof router?.navigate === 'function') {
        router.navigate('/explorer/types?q=' + encodeURIComponent(item.name));
        return;
      }
      if (item.addr != null) {
        navigateToAddress(item);
        return;
      }
      if (typeof app.showClass === 'function') {
        app.showClass(item.className || item.name);
      }
      return;
    }
    if (item.category === 'field' && item.addr == null) {
      sheet.close();
      if (typeof app.showField === 'function') {
        app.showField(item.className, item.field || item.fieldName || item.name);
        return;
      }
      if (item.className && item.field && Number.isFinite(Number(item.field.offset))) {
        showField(app, item.className, item.field);
        return;
      }
      if (typeof router?.navigate === 'function') {
        router.navigate('/explorer/types?q=' + encodeURIComponent(item.className || item.fieldName || item.name));
      }
      return;
    }
    navigateToAddress(item);
  }
  const progressFor = (controller) => (progress) => {
    if (!progress?.all) return;
    runs.runIfActive(controller, () => {
      fill.style.width=Math.min(100,Math.round(progress.done/progress.all*100))+'%';
      status.textContent=t('search.searchingN',{n:progress.hits??0});
    });
  };
  const updateStatus = (items, pager) => {
    status.textContent=!items.length?t('search.none',{region:region?.name || ''}):t('search.count',{n:items.length})+(pager.completeness!=='complete'?t('search.capped',{n:items.length}):'');
  };
  function renderUnified(searchResult) {
    results.replaceChildren();
    fill.style.width = '100%';
    const { goalAction, items } = searchResult;
    if (goalAction) results.append(createGoalBridgeRow(goalAction));
    if (!items.length && !goalAction) {
      status.textContent = t('search.none', { region: region?.name || pick('バイナリ全体', 'binary') });
      return;
    }
    status.textContent = items.length
      ? t('search.count', { n: items.length })
      : pick('目的に一致しました。上のボタンから自動解析できます。', 'Matched a goal. Click above to investigate.');
    const frag = document.createDocumentFragment();
    for (const item of items.slice(0, PAGE)) {
      frag.append(tapRow(item.name, {
        sub: item.sub || (item.addr != null ? addrText(item.addr) : ''),
        tag: item.badge,
        tagClass: `search-cat-${item.category}`,
        mono: item.category === 'function' || item.category === 'field',
        onTap: () => openUnifiedItem(item),
      }));
    }
    results.append(frag);
  }
  async function run() {
    const text=input.value.trim(); app.store?.set?.({searchQuery:text}); if(!text){toast(t('search.needQuery'));return;}
    if(kind==='addr') { const address=parseAddress(text); if(address==null){toast(t('search.badAddr'));return;} sheet.close(); app.goToAddress(address,{announce:true}); return; }
    if(kind==='unified') {
      runs.cancel('search-replaced');
      renderUnified(unifiedSearch(app, text));
      return;
    }
    if(!region) return;
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
        const rawItems=response.value;
        const items=(kind==='text'||kind==='asm')
          ? [...rawItems].map((it) => ({ ...it, score: scoreSearchMatch(String(it?.text ?? ''), text) })).sort(compareSearchResults)
          : rawItems;
        fill.style.width='100%';
        updateStatus(items,pager);
        render(items,pager,text);
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
  function render(initialItems,pager,queryText=''){
    const items=[...initialItems];
    results.replaceChildren(); let shown=0; let loading=false;
    const goalMatch = (kind === 'text' || kind === 'asm') ? matchGoalForQuery(queryText) : null;
    if (goalMatch) {
      results.append(createGoalBridgeRow({
        kind: 'goal',
        category: 'goal',
        badge: '目的',
        name: goalMatch.actionLabel,
        label: goalMatch.actionLabel,
        goal: goalMatch.goal,
        goalLabel: goalMatch.label,
      }));
    }
    const more=tapRow(t('search.more'),{onTap:()=>{void page();}});
    const setMoreLoading=(isLoading)=>{
      more.disabled=isLoading;
      more.setAttribute('aria-busy',isLoading?'true':'false');
      if(isLoading){
        more.replaceChildren(el('div',null,t('status.loading')));
        if(!more.isConnected)results.append(more);
      }
    };
    const addMore=()=>{
      more.disabled=false;
      more.setAttribute('aria-busy','false');
      if(shown>=items.length&&!pager.hasMore){more.remove();return;}
      const remaining=items.length-shown;
      more.replaceChildren();more.append(el('div',null,t('search.showMore',{n:Math.min(PAGE,remaining||PAGE)})));results.append(more);
    };
    const page=async()=>{
      if(loading)return;
      if(shown>=items.length&&pager.hasMore){
        const controller=runs.start();
        if(!controller){addMore();return;}
        loading=true; goBtn.textContent=t('btn.stop');
        setMoreLoading(true);
        try {
          const response=await pager.next({ signal:controller.signal, onProgress:progressFor(controller) });
          if(!runs.runIfActive(controller, () => {
            items.push(...response.value); fill.style.width='100%'; updateStatus(items,pager);
          })){
            if(controller.signal.aborted&&controller.signal.reason==='search-stopped'&&sheet.root.isConnected&&more.isConnected)addMore();
            return;
          }
        } catch(error) {
          const wasActive=runs.runIfActive(controller, () => {
            if(!isAbort(error))alertDialog(t('search.failed'),userError(error));
            addMore();
          });
          if(!wasActive&&controller.signal.aborted&&controller.signal.reason==='search-stopped'&&sheet.root.isConnected&&more.isConnected){
            addMore();
          }
          return;
        } finally {
          loading=false;
          runs.finish(controller,()=>{goBtn.textContent=t('btn.find');});
        }
      }
      more.remove();
      const frag=document.createDocumentFragment();const end=Math.min(items.length,shown+PAGE);
      for(;shown<end;shown++){const item=items[shown];frag.append(tapRow(addrText(item.addr),{sub:item.text,onTap:()=>navigateToAddress(item)}));}
      results.append(frag);addMore();
    };
    if(items.length)void page();
  }
}

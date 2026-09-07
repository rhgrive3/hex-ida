import { ProductRouter, createChildTaskScope } from './router.js';
import {
  ROUTES, PRIMARY_NAV, EXPLORER_SCOPES, FUNCTION_TABS, createActionRegistry,
} from './registry.js';
import {
  h, uiButton, screen, card, emptyState, loadingState, errorState, evidenceBadge,
  tabs, sectionTitle, listRow, VirtualList,
} from './primitives.js';
import { renderSecondaryRoute } from './secondary.js';
import { addrHex, parseAddress, sizeText } from '../format.js';
import { pick } from '../i18n.js';
import { menu, copyText, toast } from '../ui.js';
import {
  currentFunctionAddr, showTools, showRename, showComment, showDebugger, showGlobals,
} from '../tools.js';
import { findGlobals, importList } from '../linkage.js';
import { findCxxClasses } from '../rtti.js';
import { compileGoal } from '../goalc.js';
import { decompile, decompiledText } from '../decompile.js';
import { cfgGraph, callGraph, renderGraph, graphLegend } from '../graphview.js';
import { classifyFunction, discoverSubsystems } from '../recognition/classifier.js';
import { traceAppFunction, runtimeEvidenceForApp } from '../runtime/app-runtime.js';
import { installAssistant } from '../ai/ui/assistant.js';
import { classifyOmnibox, intentLabel } from '../ai/interaction/omnibox.js';
import { askAiMenuItem, functionAiItems } from '../ai/interaction/contextual.js';
import { productDescriptor } from '../platform/product-descriptor.js';
import { queryFunctions, queryStrings } from './explorer-index.js';
import { genericEvidenceStatus, ownerEvidence, summaryEvidenceStatus, provenanceStatus } from './evidence-model.js';
import { uiRoot } from '../ui-root.js';


let _productPanelsPromise = null;
function productPanels() { return _productPanelsPromise ||= import('../panels.js'); }
function lazyProductPanel(name) { return (...args) => productPanels().then((module) => module[name](...args)); }
const showFileInfo = lazyProductPanel('showFileInfo');
const showSections = lazyProductPanel('showSections');
const showStructure = lazyProductPanel('showStructure');
const showCandidates = lazyProductPanel('showCandidates');
const showClass = lazyProductPanel('showClass');

const ja = () => (uiRoot()?.lang || navigator.language || 'ja').toLowerCase().startsWith('ja');
const text = (j, e) => ja() ? j : e;

function addressText(value) {
  try { return addrHex(typeof value === 'bigint' ? value : BigInt(value)); } catch { return String(value || '—'); }
}

function functionName(app, addr) {
  if (addr == null) return text('関数', 'Function');
  const sym = app.symbols;
  const raw = sym && (sym.nameAt?.(addr) || sym.label?.(addr));
  return raw || ('sub_' + BigInt(addr).toString(16).toUpperCase());
}

function currentAddress(app) {
  const stored = app.store.get('currentAddress');
  if (stored != null) return stored;
  const region = app.store.get('currentRegion');
  if (!region) return null;
  return region.vmAddr;
}

function requireFile(app, action) {
  if (app.store.get('fileInfo')) return action();
  toast(text('先にファイルを開いてください。', 'Open a file first.'));
  return null;
}

function architectureOf(app) {
  const capability=app?.store?.get?.('capability') || {};
  const info = app?.store?.get?.('fileInfo') || {};
  const value = capability.architecture || app?.store?.get?.('architecture') || info.architecture || info.arch || info.cpu || 'unknown';
  return String(value).toLowerCase();
}
function instructionBytes(app) {
  const cap = app?.store?.get?.('capability') || {};
  if (cap && Object.prototype.hasOwnProperty.call(cap, 'fixedInstructionSize')) {
    const fixed = cap.fixedInstructionSize;
    return (typeof fixed === 'number' && fixed > 0) ? fixed : null;
  }
  return null;
}
function fixedArm64Rows(app) { return !!app?.store?.get?.('canDisassemble') && instructionBytes(app) != null; }
const EXPLORER_SOURCE_LIMIT=50000;
function annotateCollection(items,{complete=true,total=items?.length||0,scannedCount=items?.length||0,truncationReason=null,provenance='canonical-app-state'}={}) {
  if(items && typeof items==='object'){items.complete=!!complete;items.total=total;items.scannedCount=scannedCount;items.truncationReason=truncationReason;items.provenance=provenance;}
  return items;
}

function installViewportBridge() {
  const root = uiRoot();
  const viewport = window.visualViewport;
  const sync = () => {
    const height = viewport ? viewport.height : window.innerHeight;
    const offset = viewport ? viewport.offsetTop : 0;
    const keyboard = Math.max(0, window.innerHeight - height - offset);
    root.style.setProperty('--ui-visual-height', height + 'px');
    root.style.setProperty('--ui-keyboard-inset', keyboard + 'px');
    root.classList.toggle('ui-keyboard-open', keyboard > 120);
  };
  sync();
  window.addEventListener('resize', sync, { passive: true });
  window.addEventListener('orientationchange', sync, { passive: true });
  viewport?.addEventListener('resize', sync, { passive: true });
  viewport?.addEventListener('scroll', sync, { passive: true });
  const focus = (event) => {
    const target = event.target;
    if (!target || !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    setTimeout(() => target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120);
  };
  document.addEventListener('focusin', focus);
  return () => {
    window.removeEventListener('resize', sync);
    window.removeEventListener('orientationchange', sync);
    viewport?.removeEventListener('resize', sync);
    viewport?.removeEventListener('scroll', sync);
    document.removeEventListener('focusin', focus);
  };
}

function recentQueries() {
  try { return JSON.parse(sessionStorage.getItem('hex.ui.recentQueries') || '[]'); } catch { return []; }
}

function rememberQuery(query) {
  const q = String(query || '').trim();
  if (!q) return;
  const next = [q, ...recentQueries().filter((x) => x !== q)].slice(0, 6);
  try { sessionStorage.setItem('hex.ui.recentQueries', JSON.stringify(next)); } catch { /* private mode */ }
}

/*
 * Canonical Investigate no longer opens the legacy question sheet and then
 * searches its DOM for an input to fake an Enter key. The Goal Compiler is the
 * domain boundary; only the candidate presentation remains a compatibility Sheet.
 */
function runInvestigation(app, query) {
  return requireFile(app, () => {
    try {
      const compiled = compileGoal(String(query || '').trim());
      const goal = compiled?.goal;
      if (!goal) {
        const missing = Array.isArray(compiled?.missing) && compiled.missing.length ? ' ' + compiled.missing.join(' / ') : '';
        toast(text('質問を解析できませんでした。対象や動作をもう少し具体的に書いてください。', 'Could not compile that question. Describe the target or action more specifically.') + missing);
        return null;
      }
      return showCandidates(app, { ...goal, query: compiled });
    } catch (error) {
      toast(text('質問の解析に失敗しました。', 'Question compilation failed.') + ' ' + String(error?.message || error));
      return null;
    }
  });
}

function renderInvestigate(app, router) {
  const s = screen(text('何を知りたい？', 'What do you want to know?'), {
    id: 'investigate',
    subtitle: text('ツール名ではなく、知りたいことをそのまま入力してください。必要な探索方法はHexが選びます。',
      'Describe the answer you need. Hex chooses the search strategy.'),
  });
  const hero = card(null, { className: 'ui-investigate-hero' });
  const form = h('form', 'ui-goal-form');
  const input = h('input', 'ui-command-input');
  input.type = 'search';
  input.placeholder = text('例: 戦闘終了時に経験値が増える場所', 'e.g. where experience increases after a battle');
  input.autocomplete = 'off'; input.autocapitalize = 'off'; input.spellcheck = false;
  const submit = uiButton(text('調べる', 'Investigate'), { cls: 'ui-primary-action' });
  form.append(input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    rememberQuery(q);
    runInvestigation(app, q);
  });
  hero.body.append(form);
  const suggestions = h('div', 'ui-goal-suggestions');
  for (const q of [
    text('経験値が増える場所', 'where experience increases'),
    text('HPを書き換える処理', 'where HP is written'),
    text('通信している場所', 'network communication'),
    text('ガチャの結果を決める処理', 'where gacha results are decided'),
  ]) suggestions.append(uiButton(q, { cls: 'ui-suggestion', onClick: () => { input.value = q; rememberQuery(q); runInvestigation(app, q); } }));
  const commonGoals = h('div', 'ui-goal-suggestions ui-purpose-presets');
for (const preset of [
  { label:text('HP・体力', 'HP / health'), query:text('HPを書き換える処理', 'where HP is written') },
  { label:text('攻撃力', 'Attack power'), query:text('攻撃力を決める・書き換える処理', 'where attack power is calculated or written') },
  { label:text('ダメージ計算', 'Damage calculation'), query:text('ダメージを計算して適用する処理', 'where damage is calculated and applied') },
  { label:text('所持金・コイン', 'Money / coins'), query:text('所持金・コインを増減・保存する処理', 'where money or coins are changed and stored') },
  { label:text('アイテム・所持品', 'Items / inventory'), query:text('アイテム・所持品を増減・保存する処理', 'where inventory items are changed and stored') },
]) {
  commonGoals.append(uiButton(preset.label, {
    cls:'ui-suggestion ui-purpose-chip',
    onClick:() => { input.value = preset.query; rememberQuery(preset.query); runInvestigation(app, preset.query); },
  }));
}
hero.body.append(suggestions, sectionTitle(text('よくある目的', 'Common goals')), commonGoals);
s.body.append(hero.root);

  const overview = card(text('自動で分かったこと', 'Automatic overview'), {
    subtitle: text('ファイル全体の地図を作り、候補・根拠・未確認点をまとめます。',
      'Build a map of the binary and summarize candidates, evidence and unknowns.'),
  });
  overview.body.append(uiButton(text('概要を更新する', 'Refresh overview'), {
    cls: 'ui-secondary-action', onClick: () => requireFile(app, () => app.openOverview()),
  }));
  s.body.append(overview.root);

  const recent = recentQueries();
  if (recent.length) {
    s.body.append(sectionTitle(text('最近の調査', 'Recent investigations')));
    const list = h('div', 'ui-list');
    for (const q of recent) list.append(listRow({ title: q, onClick: () => { input.value = q; runInvestigation(app, q); } }));
    s.body.append(list);
  }
  return { root: s.root, focus: () => input.focus() };
}

function lowerBoundBigInt(array, value) {
  let lo = 0, hi = array.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (array[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

async function matchingFunctionItems(app, query, options) {
  const q = String(query || '').trim();
  return queryFunctions(app, q, options);
}
function sectionItems(app, query) {
  const q = String(query || '').trim().toLowerCase();
  const descriptor = productDescriptor(app.store.get('fileInfo'), app.currentSlice?.());
  return (descriptor.regions || []).filter((r) => !q || String(r.name || r.section || '').toLowerCase().includes(q)).map((r) => ({
    name: r.section || r.name, addr: r.vmAddr, size: r.size, region: r,
  }));
}

async function stringItems(app, query, options) {
  const rows = await app.ensureStrings();
  return queryStrings(rows || [], query, options);
}
let cachedClassesRef = null;
let cachedClassEntities = null;

function getClassEntities(app) {
  const classes = app.fields?.classes || app.objcModel?.classes;
  const swiftTypes = app.swiftModel?.types || app.swiftRuntime?.types || [];
  const cxxClasses = app.symbols ? findCxxClasses(app.symbols) : [];
  const il2cppTypes = app.il2cppModel?.types || app.il2cpp?.types || [];

  if (cachedClassesRef && cachedClassesRef.classes === classes && cachedClassesRef.swift === swiftTypes && cachedClassesRef.cxx === cxxClasses && cachedClassesRef.il2cpp === il2cppTypes && cachedClassEntities) {
    return cachedClassEntities;
  }

  const items = [];
  const seen = new Set();

  if (classes) {
    const entries = (classes instanceof Map)
      ? classes.entries()
      : Array.isArray(classes)
        ? classes.map((c) => [c.name, c])
        : Object.entries(classes);
    for (const [name, info] of entries) {
      if (!name || seen.has('objc:' + name)) continue;
      seen.add('objc:' + name);
      const methods = (info?.methods?.length || info?.methodList?.length || 0);
      const ivars = (info?.ivars?.length || 0);
      const superName = info?.superName || info?.superclass || '';
      const metaParts = [text('Objective-C クラス', 'Objective-C Class')];
      if (methods) metaParts.push(text(`${methods} メソッド`, `${methods} methods`));
      if (ivars) metaParts.push(text(`${ivars} フィールド`, `${ivars} fields`));
      if (superName) metaParts.push(text(`${superName} を継承`, `extends ${superName}`));
      items.push({
        name: String(name),
        normalizedName: String(name).toLowerCase(),
        kind: 'objc',
        methods,
        ivars,
        superName,
        meta: metaParts.join(' · '),
        addr: info?.addr ?? info?.address ?? null,
      });
    }
  }

  if (Array.isArray(swiftTypes)) {
    for (const t of swiftTypes) {
      const name = t?.name || t?.typeName;
      if (!name || seen.has('swift:' + name)) continue;
      seen.add('swift:' + name);
      const kindLabel = t.kind === 'struct' ? text('Swift 構造体', 'Swift Struct') : t.kind === 'enum' ? text('Swift 列挙型', 'Swift Enum') : text('Swift クラス', 'Swift Class');
      const fields = t.fields?.length || 0;
      const metaParts = [kindLabel];
      if (fields) metaParts.push(text(`${fields} フィールド`, `${fields} fields`));
      items.push({
        name: String(name),
        normalizedName: String(name).toLowerCase(),
        kind: 'swift',
        meta: metaParts.join(' · '),
        addr: t?.addr ?? t?.address ?? null,
      });
    }
  }

  if (Array.isArray(cxxClasses)) {
    for (const c of cxxClasses) {
      const name = c?.name;
      if (!name || seen.has('cxx:' + name)) continue;
      seen.add('cxx:' + name);
      const metaParts = [text('C++ クラス (RTTI/vtable)', 'C++ Class (RTTI/vtable)')];
      if (c.vtable != null) metaParts.push('vtable ' + addressText(c.vtable));
      items.push({
        name: String(name),
        normalizedName: String(name).toLowerCase(),
        kind: 'cxx',
        meta: metaParts.join(' · '),
        addr: c.vtable ?? c.typeinfo ?? null,
      });
    }
  }

  if (Array.isArray(il2cppTypes)) {
    for (const t of il2cppTypes) {
      const name = t?.name || t?.fullName;
      if (!name || seen.has('il2cpp:' + name)) continue;
      seen.add('il2cpp:' + name);
      const metaParts = [text('IL2CPP 型', 'IL2CPP Type')];
      if (t.namespace) metaParts.push(t.namespace);
      items.push({
        name: String(name),
        normalizedName: String(name).toLowerCase(),
        kind: 'il2cpp',
        meta: metaParts.join(' · '),
        addr: t?.addr ?? t?.address ?? null,
      });
    }
  }

  cachedClassesRef = { classes, swift: swiftTypes, cxx: cxxClasses, il2cpp: il2cppTypes };
  cachedClassEntities = items;
  return items;
}

export function classItems(app, query) {
  const q = String(query || '').trim().toLowerCase();
  const all = getClassEntities(app);
  if (!q) return all;
  const list = [];
  for (const item of all) {
    if (item.normalizedName.includes(q)) {
      list.push(item);
    }
  }
  return list;
}

function getDataEntities(app) {
  const items = [];
  const seen = new Set();
  const regions = app.store?.get?.('regions') || [];
  const dataRegions = regions.filter((r) => r && !r.exec && (r.read || r.write));

  if (app.symbols) {
    try {
      const globals = findGlobals(app.symbols, app.program || null, regions, { limit: 400 });
      for (const g of globals) {
        const name = g.readable || (g.addr != null ? addressText(g.addr) : 'global');
        if (seen.has('global:' + g.addr)) continue;
        seen.add('global:' + g.addr);
        const metaParts = [text('グローバル変数', 'Global Variable')];
        if (g.region) metaParts.push(g.region);
        if (g.refs != null && g.refsComplete !== false) metaParts.push(text(`${g.refs} か所から参照`, `${g.refs} refs`));
        else if (g.refs != null && g.refs > 0) metaParts.push(text(`少なくとも ${g.refs} か所から参照`, `at least ${g.refs} refs`));
        else if (g.relationSupported === false || g.relationComplete === false) metaParts.push(text('参照範囲は未確定', 'reference coverage unknown'));
        items.push({
          name: String(name),
          normalizedName: (String(name) + ' ' + (g.region || '')).toLowerCase(),
          kind: 'global',
          addr: g.addr,
          meta: metaParts.join(' · '),
        });
      }
    } catch { /* ignore fallback */ }
  }

  const structs = app.structs || app.types?.structs || [];
  if (Array.isArray(structs) || (structs instanceof Map)) {
    const list = structs instanceof Map ? structs.values() : structs;
    for (const s of list) {
      const name = s?.name;
      if (!name || seen.has('struct:' + name)) continue;
      seen.add('struct:' + name);
      const fieldCount = s.fields?.length || s.members?.length || 0;
      const metaParts = [text('構造体', 'Struct')];
      if (s.size) metaParts.push(sizeText(s.size));
      if (fieldCount) metaParts.push(text(`${fieldCount} メンバ`, `${fieldCount} members`));
      items.push({
        name: String(name),
        normalizedName: String(name).toLowerCase(),
        kind: 'struct',
        addr: s.addr ?? null,
        meta: metaParts.join(' · '),
      });
    }
  }

  const schemas = app.schemas || app.store?.get?.('schemas') || [];
  if (Array.isArray(schemas)) {
    for (const sch of schemas) {
      const files = sch.files?.join(', ') || '';
      const name = files || (sch.loader != null ? addressText(sch.loader) : 'table');
      if (seen.has('table:' + name)) continue;
      seen.add('table:' + name);
      const cols = sch.best?.columns || 0;
      const metaParts = [text('復元データ表', 'Recovered Schema')];
      if (cols) metaParts.push(text(`${cols} 列`, `${cols} columns`));
      items.push({
        name: String(name),
        normalizedName: (String(name) + ' ' + files).toLowerCase(),
        kind: 'table',
        addr: sch.loader ?? null,
        meta: metaParts.join(' · '),
      });
    }
  }

  for (const r of dataRegions) {
    const name = r.section || r.name || r.id;
    if (!name || seen.has('region:' + name)) continue;
    seen.add('region:' + name);
    const metaParts = [text('データ領域', 'Data Region')];
    if (r.size) metaParts.push(sizeText(r.size));
    items.push({
      name: String(name),
      normalizedName: String(name).toLowerCase(),
      kind: 'region',
      addr: r.vmAddr,
      meta: metaParts.join(' · '),
    });
  }

  return items;
}

export function dataItems(app, query) {
  const q = String(query || '').trim().toLowerCase();
  const all = getDataEntities(app);
  if (!q) return all;
  const list = [];
  for (const item of all) {
    if (item.normalizedName.includes(q)) {
      list.push(item);
    }
  }
  return list;
}

let cachedExternalDescriptor = null;
let cachedExternalItems = null;

function getExternalEntities(app) {
  const slice = app.currentSlice?.();
  const fileInfo = app.store?.get?.('fileInfo');
  const symbols = app.symbols;
  if (cachedExternalDescriptor && cachedExternalDescriptor.fileInfo === fileInfo && cachedExternalDescriptor.slice === slice && cachedExternalDescriptor.symbols === symbols && cachedExternalItems) {
    return cachedExternalItems;
  }
  const descriptor = productDescriptor(fileInfo, slice);
  const items = [];
  const seen = new Set();
  for (const name of descriptor.dependencies || []) {
    if (!seen.has('dylib:' + name)) {
      seen.add('dylib:' + name);
      items.push({
        name,
        normalizedName: name.toLowerCase(),
        kind: 'dylib',
        meta: text('依存ライブラリ', 'Dependency Library'),
        addr: null,
      });
    }
  }
  if (symbols) {
    if (Array.isArray(symbols.imports)) {
      for (const imp of symbols.imports) {
        const name = String(imp.readable || imp.name || imp);
        const rawName = String(imp.name || imp);
        if (!name || seen.has('import:' + rawName)) continue;
        seen.add('import:' + rawName);
        const addr = imp.addr ?? imp.address ?? null;
        items.push({
          name,
          normalizedName: (name + ' ' + rawName).toLowerCase(),
          kind: 'import',
          meta: text('インポート関数', 'Imported API'),
          addr,
        });
      }
    } else if (symbols.symbolCount) {
      const imports = importList(symbols, app.program || null);
      for (const imp of imports) {
        const name = String(imp.readable || imp.name || '');
        const rawName = String(imp.name || '');
        if (!name || seen.has('import:' + rawName)) continue;
        seen.add('import:' + rawName);
        const metaParts = [imp.framework || text('インポート関数', 'Imported API')];
        if (imp.calls) metaParts.push(text(`${imp.calls} か所から呼出`, `${imp.calls} calls`));
        items.push({
          name,
          normalizedName: (name + ' ' + rawName).toLowerCase(),
          kind: 'import',
          meta: metaParts.join(' · '),
          addr: imp.addr ?? null,
        });
      }
    }
  }
  cachedExternalDescriptor = { fileInfo, slice, symbols };
  cachedExternalItems = items;
  return items;
}

export function externalItems(app, query) {
  const q = String(query || '').trim().toLowerCase();
  const all = getExternalEntities(app);
  if (!q) return all;
  const list = [];
  for (const item of all) {
    if (item.normalizedName.includes(q)) {
      list.push(item);
    }
  }
  return list;
}

function renderExplorer(app, router, route, routeContext = {}) {
  const scope = EXPLORER_SCOPES.some((x) => x.id === route.params.scope) ? route.params.scope : 'functions';
  const s = screen(text('索引', 'Explorer'), {
    id: 'explorer',
    subtitle: text('関数・文字列・型・データ・外部API・セクションを一つの検索体験で見ます。',
      'Browse functions, strings, types, data, external APIs and sections with one search.'),
  });
  const controls = h('div', 'ui-explorer-controls');
  const scopes = h('div', 'ui-scope-tabs');
  scopes.setAttribute('role', 'tablist');
  for (const item of EXPLORER_SCOPES) {
    const b = uiButton(item.label, { cls: 'ui-scope' + (item.id === scope ? ' active' : ''), onClick: () => router.navigate('/explorer/' + item.id) });
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(item.id === scope));
    scopes.append(b);
  }
  const search = h('input', 'ui-search-field');
  search.type = 'search'; search.placeholder = text('名前・文字列・アドレスで検索', 'Search names, strings or addresses');
  search.value = route.query.get('q') || '';
  controls.append(scopes, search);
  s.body.append(controls);
  const content = h('div', 'ui-explorer-content');
  s.body.append(content);
  let disposed = false;
  let virtual = null;
  let timer = 0;
  let querySerial = 0;
  const fallbackRouteController = routeContext.signal ? null : new AbortController();
  const routeSignal = routeContext.signal || fallbackRouteController.signal;
  const queryScope = createChildTaskScope(routeSignal);

  const showRows = (items, renderRow, emptyText) => {
    virtual?.dispose(); virtual = null;
    content.replaceChildren();
    if (!items || !Number(items.length)) { content.append(emptyState(text('見つかりません', 'Nothing found'), emptyText)); return; }
    if(items.complete===false){content.append(h('div','ui-hint',text(`一部のみ表示: ${Number(items.scannedCount||0).toLocaleString()} / ${Number(items.total||0).toLocaleString()} を走査 (${items.truncationReason||'incomplete'})`,`Partial results: scanned ${Number(items.scannedCount||0).toLocaleString()} / ${Number(items.total||0).toLocaleString()} (${items.truncationReason||'incomplete'})`)));}
    virtual = new VirtualList({ items, rowHeight: 64, ariaLabel: text('索引の結果', 'Explorer results'), renderRow });
    content.append(virtual.root);
  };

  const update = async () => {
    if (disposed) return;
    const signal = queryScope.spawn('explorer-query-replaced');
    const serial = ++querySerial;
    const current = () => !disposed && !routeSignal.aborted && !signal.aborted && serial === querySerial;
    const q = search.value.trim();
    const parsed = parseAddress(q);
    if (parsed != null && q) {
      showRows([{ addr: parsed }], (item) => listRow({ title: addressText(item.addr), subtitle: text('このアドレスへ移動', 'Jump to this address'), onClick: () => router.navigate('/code/' + item.addr.toString()) }), '');
      return;
    }
    if (scope === 'functions') {
      if (q) content.replaceChildren(loadingState(text('索引を検索しています…', 'Searching index…')));
      try {
        const items = await matchingFunctionItems(app, q, { signal: signal, limit: 200 });
        if (!current()) return;
        showRows(items, (item) => listRow({ title: item.name, subtitle: addressText(item.addr), meta: item.size != null ? String(item.size) + ' B' : '', onClick: () => router.navigate('/function/' + BigInt(item.addr).toString() + '/overview') }), text('関数名がまだ復元されていない可能性があります。', 'Function names may not be recovered yet.'));
      } catch (err) {
        if (err?.name !== 'AbortError' && current()) content.replaceChildren(errorState(text('検索できませんでした', 'Search failed'), String(err?.message || err)));
      }
      return;
    }
    if (scope === 'sections') {
      const items = sectionItems(app, q);
      showRows(items, (item) => listRow({ title: item.name, subtitle: addressText(item.addr), meta: String(item.size) + ' bytes', onClick: () => { app.selectRegion(item.region, { silent: true }); router.navigate('/code/' + BigInt(item.addr).toString()); } }), text('表示できるセクションがありません。', 'No sections are available.'));
      return;
    }
    if (scope === 'external') {
      const items = externalItems(app, q);
      showRows(items, (item) => listRow({
        title: item.name,
        subtitle: item.addr != null ? addressText(item.addr) : (item.kind === 'dylib' ? text('外部ライブラリ', 'Dynamic library') : text('外部シンボル', 'External symbol')),
        onClick: item.addr != null ? () => router.navigate('/code/' + BigInt(item.addr).toString()) : null,
      }), text('外部ライブラリ情報がありません。', 'No external library information is available.'));
      return;
    }
    if (scope === 'strings') {
      content.replaceChildren(loadingState(text('文字列を集めています…', 'Collecting strings…')));
      try {
        const items = await stringItems(app, q, { signal: signal, limit: 200 });
        if (!current()) return;
        showRows(items, (item) => listRow({ title: item.text, subtitle: addressText(item.addr), onClick: () => { app.goToStringAddress(item.region, item.addr); router.navigate('/code/' + BigInt(item.addr).toString()); } }), text('文字列が見つかりません。', 'No strings were found.'));
        if (items?.complete === false) content.prepend(h('p', 'ui-partial-note', text('結果はメモリ上限内の一部です。未走査領域を「該当なし」とは扱いません。', 'Results are partial within the memory budget; unscanned regions are not treated as negative evidence.')));
      } catch (err) {
        if (err?.name !== 'AbortError' && current()) content.replaceChildren(errorState(text('文字列を表示できません', 'Could not show strings'), String(err && err.message || err)));
      }
      return;
    }
    if (scope === 'classes') {
      const items = classItems(app, q);
      showRows(items, (item) => listRow({
        title: item.name,
        subtitle: item.meta,
        onClick: () => requireFile(app, () => showClass(app, item.name)),
      }), text('クラス情報がありません。', 'No class information is available.'));
      return;
    }
    if (scope === 'data') {
      const items = dataItems(app, q);
      showRows(items, (item) => listRow({
        title: item.name,
        subtitle: item.addr != null ? addressText(item.addr) + (item.region ? ' · ' + item.region : '') : '',
        meta: item.meta || '',
        onClick: item.addr != null ? () => router.navigate('/code/' + BigInt(item.addr).toString()) : () => requireFile(app, () => showGlobals(app)),
      }), text('データ構造・グローバル変数情報がありません。', 'No data structures or global variables found.'));
      return;
    }
  };

  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 120); });
  update();
  return {
    root: s.root,
    getState: () => ({ query: search.value, virtual: virtual?.getState() || null }),
    restoreState: (state) => { if (state?.query != null) search.value = state.query; setTimeout(() => virtual?.restoreState(state?.virtual), 0); },
    dispose: () => { disposed = true; queryScope.abort('explorer-disposed'); fallbackRouteController?.abort('explorer-disposed'); clearTimeout(timer); virtual?.dispose(); },
  };
}

function codeViewState(app) {
  return {
    getState: () => ({
      topRow: app.viewer.topRow(), selectedRow: app.viewer.selectedRow,
      mode: app.store.get('displayMode'), regionId: app.store.get('currentRegion')?.id || null,
    }),
    restoreState: (state) => {
      if (!state) return;
      if (state.mode) app.setMode(state.mode);
      if (Number.isFinite(state.topRow)) app.viewer.goToRow(state.topRow, 'top');
      if (Number.isFinite(state.selectedRow) && state.selectedRow >= 0) app.viewer.select(state.selectedRow, false);
    },
  };
}

function summaryText(res) {
  const value = res?.summary;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(Boolean).join(' ');
  if (value && typeof value === 'object') return value.text || value.summary || value.what || '';
  return '';
}

function recognitionInput(app, addr, res) {
  const owner = app.ownerOf?.(addr);
  const model = res?.model || {};
  const semantic = res?.semanticFacts || {};
  const fn = app.symbols?.functionAt?.(addr);
  const instructions = (model.instructions || []).map((item) => ({ mnemonic: item.mnemonic || item.mn || '', operands: item.operands || item.ops || '' }));
  const blocks = model.blocks || [];
  const edges = blocks.reduce((sum, block) => sum + (block.succ?.length || block.successors?.length || 0), 0);
  const writes = (semantic.stores || []).map((store) => store.location?.key || store.location?.text || store.lhsText).filter(Boolean);
  const calls = (semantic.calls || []).map((call) => call.name).filter(Boolean);
  const operations = [];
  for (const store of semantic.stores || []) {
    const op = store.readModifyWrite?.kind || store.expression?.op || store.expression?.name;
    if (op) operations.push(op);
  }
  return {
    address: addr,
    name: app.symbols?.nameAt?.(addr) || null,
    architecture: architectureOf(app),
    size: fn?.end != null && fn.end > fn.start ? Number(fn.end - fn.start) : 0,
    instructions,
    cfg: { blocks: blocks.length, edges, exits: blocks.filter((block) => !(block.succ?.length || block.successors?.length)).length, calls: calls.length },
    semantic: { writes, calls, operations, reads: [], thresholds: [] },
    calls,
    objcClass: owner?.className || null,
    objcSelector: owner?.sel || null,
  };
}

function evidenceStatus(item) { return genericEvidenceStatus(item); }

function evidenceTitle(item, index) {
  return String(item?.reason || item?.kind || item?.type || item?.source || item?.family || text(`根拠 ${index + 1}`, `Evidence ${index + 1}`));
}

function evidenceSubtitle(item) {
  const bits = [];
  if (item?.address != null) bits.push(addressText(item.address));
  else if (item?.addr != null) bits.push(addressText(item.addr));
  if (item?.row != null) bits.push('row ' + item.row);
  if (item?.provenance?.group) bits.push(String(item.provenance.group));
  else if (item?.group) bits.push(String(item.group));
  if (item?.detail) bits.push(String(item.detail));
  return bits.join(' · ');
}

function renderFunctionWorkspace(app, router, route, routeContext = {}) {
  let addr;
  try { addr = BigInt(route.params.address); } catch { addr = currentFunctionAddr(app); }
  if (addr == null) {
    const s = screen(text('関数', 'Function'), { id: 'function' });
    s.body.append(emptyState(text('関数が選択されていません', 'No function selected'), text('コードまたは索引から関数を開いてください。', 'Open a function from Code or Explorer.')));
    return { root: s.root };
  }
  const verifiedRange=app.validatedFunctionRange?.(addr);
  if(verifiedRange && !verifiedRange.ok){
    const s=screen(functionName(app,addr),{id:'function',subtitle:addressText(addr)});
    s.body.append(errorState(text('関数境界を検証できません','Function boundary could not be verified'),verifiedRange.reason||'unverified-function-range'));
    return {root:s.root};
  }
  const tab = FUNCTION_TABS.some((x) => x.id === route.params.tab) ? route.params.tab : 'overview';
  const actions = h('div', 'ui-screen-actions');
  actions.append(uiButton('•••', { cls: 'ui-icon-action', ariaLabel: text('関数の操作', 'Function actions'), onClick: (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const assistant = window.__hexAi;
    menu([
      ...(assistant ? [askAiMenuItem(assistant, functionAiItems(assistant, { address: addr, name: functionName(app, addr) }), { x: r.left + r.width / 2, y: r.bottom + 4 })] : []),
      { label: text('名前を付ける', 'Rename'), action: () => showRename(app, addr) },
      { label: text('メモを書く', 'Comment'), action: () => showComment(app, addr) },
      { label: text('アセンブリへ', 'Open assembly'), action: () => router.navigate('/code/' + addr.toString()) },
    ], r.left + r.width / 2, r.bottom + 4);
  } }));
  const s = screen(functionName(app, addr), { id: 'function', subtitle: addressText(addr), actions });
  const tabbar = tabs(FUNCTION_TABS, tab, (next) => router.navigate('/function/' + addr.toString() + '/' + next));
  s.body.append(tabbar);
  const content = h('div', 'ui-workspace-content');
  content.append(loadingState(text('関数を解析しています…', 'Analysing function…')));
  s.body.append(content);
  let disposed = false;
  const viewEpoch = app.backend?.gen;
  const viewSlice = app.store.get('sliceIndex');
  const viewCurrent = () => !disposed && app.backend?.gen === viewEpoch && app.store.get('sliceIndex') === viewSlice;

  const rowMapper = () => {
    const region = app.store.get('currentRegion');
    if (!fixedArm64Rows(app)) return { supported: false, rowOfAddress: () => null, addrOfRow: () => null };
    return {
      supported: true,
      rowOfAddress: (a) => !region || a == null ? null : Number((a - region.vmAddr) / BigInt(instructionBytes(app))),
      addrOfRow: (row) => region ? region.vmAddr + BigInt(row) * BigInt(instructionBytes(app)) : null,
    };
  };

  const renderOverview = (res) => {
    const owner = app.ownerOf?.(addr);
    const ownerFact = ownerEvidence(owner);
    const recognition = classifyFunction(recognitionInput(app, addr, res));
    const subsystems = discoverSubsystems(recognitionInput(app, addr, res));
    const grid = h('div', 'ui-card-grid');
    const summary = card(text('何をしている？', 'What does it do?'));
    const recovered = summaryText(res);
    const recoveredStatus = summaryEvidenceStatus(res);
    const ownerLead = ownerFact.unique
      ? text(`${ownerFact.unique.className} の ${ownerFact.unique.sel || 'メソッド'} としてruntime metadataから一意に識別されています。`, `Runtime metadata uniquely identifies this as ${ownerFact.unique.sel || 'a method'} on ${ownerFact.unique.className}.`)
      : ownerFact.candidates.length
        ? text('この実装アドレスは複数のObjective-Cメソッドで共有されています。候補を確認してください。', 'This implementation address is shared by multiple Objective-C methods; review the candidates below.')
        : text('命令列と参照関係から、この関数の役割を確認できます。', 'Use the instructions and references below to determine this function’s role.');
    summary.body.append(h('p', 'ui-lead', recovered || ownerLead));
    summary.body.append(evidenceBadge(recovered ? recoveredStatus : ownerFact.status));
    if (ownerFact.candidates.length > 1) {
      for (const candidate of ownerFact.candidates.slice(0, 8)) summary.body.append(listRow({ title: candidate.className || text('不明なクラス', 'Unknown class'), subtitle: candidate.sel || text('selector不明', 'Unknown selector'), badge: evidenceBadge('likely') }));
    }
    grid.append(summary.root);

    const identity = card(text('コードの分類', 'Code identity'));
    identity.body.append(listRow({
      title: recognition.classification,
      subtitle: (recognition.evidence || []).join(' · ') || text('まだ十分な識別根拠がありません', 'Not enough identity evidence yet'),
      meta: 'score ' + Number(recognition.confidence || 0).toFixed(2),
      badge: evidenceBadge(recognition.classification === 'UNKNOWN' ? 'unverified' : 'likely'),
    }));
    for (const subsystem of subsystems.slice(0, 3)) identity.body.append(listRow({
      title: subsystem.subsystem,
      subtitle: (subsystem.evidence || []).join(' · '),
      meta: 'score ' + Number(subsystem.confidence || 0).toFixed(2),
      badge: evidenceBadge(subsystem.confidence >= 0.72 ? 'likely' : 'unverified'),
    }));
    grid.append(identity.root);

    const facts = card(text('基本情報', 'Basic facts'));
    facts.body.append(listRow({ title: text('命令数', 'Instructions'), meta: String(res.instructions || res.model?.instructions?.length || 0) }));
    facts.body.append(listRow({ title: text('ブロック数', 'Basic blocks'), meta: String(res.model?.blocks?.length || 0) }));
    facts.body.append(listRow({ title: text('アドレス', 'Address'), meta: addressText(addr), mono: true }));
    facts.body.append(listRow({ title: text('アーキテクチャ', 'Architecture'), meta: architectureOf(app) }));
    grid.append(facts.root);
    const next = card(text('次に見る', 'Next steps'));
    for (const item of [
      ['pseudocode', text('疑似Cで読む', 'Read pseudocode')],
      ['flow', text('分岐とループを見る', 'Inspect branches and loops')],
      ['evidence', text('なぜそう言えるか', 'Review evidence')],
      ['runtime', text('実行して確かめる', 'Verify at runtime')],
    ]) next.body.append(listRow({ title: item[1], onClick: () => router.navigate('/function/' + addr.toString() + '/' + item[0]) }));
    grid.append(next.root);
    content.replaceChildren(grid);
  };

  const renderPseudocode = (res) => {
    const map = rowMapper();
    if (!map.supported) {
      content.replaceChildren(emptyState(text('このアーキテクチャの疑似Cは未対応です', 'Pseudocode is unavailable for this architecture'), text('現在のSemantic DecompilerはARM64を対象にしています。未対応のCPUをARM64として表示することはしません。', 'The Semantic Decompiler currently targets ARM64; Hex will not reinterpret another CPU as ARM64.')));
      return;
    }
    const out = decompile(res.model, {
      name: app.symbols?.nameAt?.(addr), addr,
      rowOfAddress: map.rowOfAddress, addrOfRow: map.addrOfRow,
      symbolFor: (a) => app.symbols?.nameAt?.(a) || null,
      notes: app.notes,
    });
    const toolbar = h('div', 'ui-code-toolbar');
    const code = h('pre', 'ui-pseudocode mono');
    code.tabIndex = 0;
    code.textContent = decompiledText(out);
    let wrap = false;
    toolbar.append(
      uiButton(text('コピー', 'Copy'), { cls: 'ui-secondary-action', onClick: () => copyText(code.textContent, text('疑似C', 'Pseudocode')) }),
      uiButton(text('折り返し', 'Wrap'), { cls: 'ui-secondary-action', onClick: (e) => { wrap = !wrap; code.classList.toggle('wrap', wrap); e.currentTarget.setAttribute('aria-pressed', String(wrap)); } }),
      uiButton(text('アセンブリへ', 'Assembly'), { cls: 'ui-secondary-action', onClick: () => router.navigate('/code/' + addr.toString()) }),
    );
    content.replaceChildren(toolbar, code);
  };

  const renderPseudocodeTab = async () => {
    if (app.analysisQueries) {
      try {
        const snapshot = await app.analysisQueries.snapshot({ signal: routeSignal });
        const res = await app.analysisQueries.decompile(snapshot, addr, { signal: routeSignal });
        if (!viewCurrent()) return;
        if (res.completeness === 'unsupported' || !res.value) {
          content.replaceChildren(emptyState(text('このアーキテクチャの疑似Cは未対応です', 'Pseudocode is unavailable for this architecture'), text('現在のSemantic DecompilerはARM64を対象にしています。未対応のCPUをARM64として表示することはしません。', 'The Semantic Decompiler currently targets ARM64; Hex will not reinterpret another CPU as ARM64.')));
          return;
        }
        const val = res.value;
        const out = typeof val === 'string' ? val : (val.code ?? decompiledText(val));
        const toolbar = h('div', 'ui-code-toolbar');
        const code = h('pre', 'ui-pseudocode mono');
        code.tabIndex = 0;
        code.textContent = typeof out === 'string' ? out : decompiledText(out);
        let wrap = false;
        toolbar.append(
          uiButton(text('コピー', 'Copy'), { cls: 'ui-secondary-action', onClick: () => copyText(code.textContent, text('疑似C', 'Pseudocode')) }),
          uiButton(text('折り返し', 'Wrap'), { cls: 'ui-secondary-action', onClick: (e) => { wrap = !wrap; code.classList.toggle('wrap', wrap); e.currentTarget.setAttribute('aria-pressed', String(wrap)); } }),
          uiButton(text('アセンブリへ', 'Assembly'), { cls: 'ui-secondary-action', onClick: () => router.navigate('/code/' + addr.toString()) }),
        );
        content.replaceChildren(toolbar, code);
        return;
      } catch (err) {
        if (routeSignal.aborted) return;
        throw err;
      }
    }
    const map = rowMapper();
    if (!map.supported) {
      content.replaceChildren(emptyState(text('このアーキテクチャの疑似Cは未対応です', 'Pseudocode is unavailable for this architecture'), text('現在のSemantic DecompilerはARM64を対象にしています。未対応のCPUをARM64として表示することはしません。', 'The Semantic Decompiler currently targets ARM64; Hex will not reinterpret another CPU as ARM64.')));
      return;
    }
    const res = await app.analyzeFunctionAt(addr, { signal: routeSignal });
    if (!viewCurrent()) return;
    if (!res || !res.model) { content.replaceChildren(errorState(text('関数を解析できません', 'Could not analyse function'), text('このアドレスは現在のコード領域の関数として解析できませんでした。', 'This address could not be analysed as a function in the current code region.'))); return; }
    renderPseudocode(res);
  };

  const renderFlow = (res) => {
    const map = rowMapper();
    if (!map.supported) {
      content.replaceChildren(emptyState(text('このアーキテクチャのCFG表示は未対応です', 'CFG view is unavailable for this architecture'), text('固定4バイト行を前提にせず、安全側で表示を止めています。', 'This view is disabled rather than assuming fixed four-byte instruction rows.')));
      return;
    }
    const graph = cfgGraph(res.model, {
      rowOfAddress: map.rowOfAddress,
      text: (insn) => insn.mnemonic + ' ' + insn.operands,
      onNode: (_block, target) => router.navigate('/code/' + BigInt(target).toString()),
    });
    if (!graph.nodes.length) { content.replaceChildren(emptyState(text('フローを作れませんでした', 'No control flow available'), text('この関数には図にできるブロック情報がありません。', 'This function has no graphable block information.'))); return; }
    const mode = h('div', 'ui-graph-shell');
    const graphHost = h('div', 'ui-graph-host');
    graphHost.append(renderGraph(graph.nodes, graph.edges, {}));
    const list = h('details', 'ui-graph-text');
    list.append(h('summary', null, text('テキスト一覧でも見る', 'View as text list')));
    const rows = h('div', 'ui-list');
    graph.nodes.forEach((node, index) => rows.append(listRow({ title: String(node.label || node.title || node.id || `Block ${index + 1}`), subtitle: node.addr != null ? addressText(node.addr) : '' })));
    list.append(rows);
    mode.append(graphHost, graphLegend('cfg'), list);
    content.replaceChildren(mode);
  };

  const renderFlowTab = async () => {
    if (app.analysisQueries) {
      try {
        const snapshot = await app.analysisQueries.snapshot({ signal: routeSignal });
        const res = await app.analysisQueries.cfg(snapshot, addr, { signal: routeSignal });
        if (!viewCurrent()) return;
        if (res.completeness === 'unsupported' || !res.value) {
          content.replaceChildren(emptyState(text('このアーキテクチャのCFG表示は未対応です', 'CFG view is unavailable for this architecture'), text('固定4バイト行を前提にせず、安全側で表示を止めています。', 'This view is disabled rather than assuming fixed four-byte instruction rows.')));
          return;
        }
        const cfg = res.value;
        const nodes = Array.isArray(cfg.blocks) ? cfg.blocks.map((b, index) => ({
          id: b.id ?? `b${index}`,
          label: b.label || b.name || `Block ${index + 1}`,
          addr: b.startAddress ?? b.address ?? b.start ?? null,
          title: b.title ?? b.label,
        })) : [];
        const edges = Array.isArray(cfg.edges) ? cfg.edges.map((e) => ({
          from: e.from ?? e.source,
          to: e.to ?? e.target,
          kind: e.kind ?? 'unconditional',
        })) : [];
        if (!nodes.length) {
          content.replaceChildren(emptyState(text('フローを作れませんでした', 'No control flow available'), text('この関数には図にできるブロック情報がありません。', 'This function has no graphable block information.')));
          return;
        }
        const mode = h('div', 'ui-graph-shell');
        const graphHost = h('div', 'ui-graph-host');
        graphHost.append(renderGraph(nodes, edges, {}));
        const list = h('details', 'ui-graph-text');
        list.append(h('summary', null, text('テキスト一覧でも見る', 'View as text list')));
        const rows = h('div', 'ui-list');
        nodes.forEach((node, index) => rows.append(listRow({
          title: String(node.label || node.title || node.id || `Block ${index + 1}`),
          subtitle: node.addr != null ? addressText(node.addr) : '',
          onClick: node.addr != null ? () => router.navigate('/code/' + BigInt(node.addr).toString()) : null,
        })));
        list.append(rows);
        mode.append(graphHost, graphLegend('cfg'), list);
        content.replaceChildren(mode);
        return;
      } catch (err) {
        if (routeSignal.aborted) return;
        throw err;
      }
    }
    const map = rowMapper();
    if (!map.supported) {
      content.replaceChildren(emptyState(text('このアーキテクチャのCFG表示は未対応です', 'CFG view is unavailable for this architecture'), text('固定4バイト行を前提にせず、安全側で表示を止めています。', 'This view is disabled rather than assuming fixed four-byte instruction rows.')));
      return;
    }
    const res = await app.analyzeFunctionAt(addr, { signal: routeSignal });
    if (!viewCurrent()) return;
    if (!res || !res.model) { content.replaceChildren(errorState(text('関数を解析できません', 'Could not analyse function'), text('このアドレスは現在のコード領域の関数として解析できませんでした。', 'This address could not be analysed as a function in the current code region.'))); return; }
    renderFlow(res);
  };

  const renderCalls = async () => {
    content.replaceChildren(loadingState(text('呼び出し関係を集めています…', 'Mapping calls…')));
    try {
      await app.ensureProgram();
      if (!viewCurrent()) return;
      if (!app.program || app.program.unsupported || (app.program.graphCompleteness && !app.program.graphCompleteness.supported)) {
        content.replaceChildren(emptyState(
          text('呼び出し関係を構築できません', 'Call graph unsupported'),
          text('このアーキテクチャまたはフォーマットではプログラム全体の呼び出し索引に対応していません。', 'Whole-program call index is not supported for this architecture or format.'),
        ));
        return;
      }
      const graph = callGraph(app.program, app.symbols, addr, {
        depth: 2, limit: 8, label: (a) => functionName(app, a),
        onNode: (a) => router.navigate('/function/' + BigInt(a).toString() + '/overview'),
      });
      const shell = h('div', 'ui-graph-shell');
      shell.append(renderGraph(graph.nodes, graph.edges, {}), graphLegend('call'));
      content.replaceChildren(shell);
    } catch (err) {
      if (routeSignal.aborted) return;
      throw err;
    }
  };

  const renderEvidence = (res) => {
    const stack = h('div', 'ui-evidence-stack');
    const name = app.symbols?.nameAt?.(addr);
    const boundaryEvidence = app.symbols?.functionEvidence?.(addr);
    const nameEvidence = app.symbols?.nameEvidence?.(addr);
    const boundaryStatus = provenanceStatus(boundaryEvidence);
    const nameStatus = provenanceStatus(nameEvidence);
    stack.append(listRow({ title: text('関数境界', 'Function boundary'), subtitle: addressText(addr), meta: boundaryEvidence?.source || text('由来不明', 'unknown source'), badge: evidenceBadge(boundaryStatus === 'manual' ? 'unverified' : boundaryStatus) }));
    stack.append(listRow({ title: text('関数名', 'Function name'), subtitle: name || text('シンボル名なし', 'No symbol name'), meta: nameStatus === 'manual' ? text('手動 / User', 'Manual / User') : (nameEvidence?.source || ''), badge: evidenceBadge(nameStatus === 'manual' ? 'unverified' : nameStatus) }));

    const deterministic = Array.isArray(res.evidence) ? res.evidence : [];
    deterministic.slice(0, 80).forEach((item, index) => stack.append(listRow({
      title: evidenceTitle(item, index),
      subtitle: evidenceSubtitle(item),
      badge: evidenceBadge(evidenceStatus(item)),
    })));

    const runtime = runtimeEvidenceForApp(app, addr);
    runtime.slice(-20).forEach((item, index) => stack.append(listRow({
      title: text('実行時観測: ', 'Runtime observation: ') + evidenceTitle(item, index),
      subtitle: evidenceSubtitle(item),
      badge: evidenceBadge(evidenceStatus(item)),
    })));

    const proof = Array.isArray(res.rewriteProof) ? res.rewriteProof : [];
    proof.slice(0, 30).forEach((item) => stack.append(listRow({
      title: text('逆コンパイル変換: ', 'Decompiler rewrite: ') + String(item.rule || item.name || item.proof?.kind || 'rewrite'),
      subtitle: item.proof?.detail || item.detail || '',
      badge: evidenceBadge('confirmed'),
    })));

    const note = card(text('表示の意味', 'How to read this'), { subtitle: text('「確認済み」はバイナリまたは実行観測に直接結び付いた事実です。推論は「可能性が高い」「未確認」のまま分離します。ランキング点を確率として表示しません。', 'Confirmed is reserved for facts tied directly to binary/runtime evidence. Inference remains Likely or Unverified; ranking scores are not presented as probabilities.') });
    const nodes = [note.root, stack];
    if (Array.isArray(res.warnings) && res.warnings.length) {
      const warnings = card(text('未解決 / 注意', 'Unresolved / warnings'));
      for (const warning of res.warnings.slice(0, 20)) warnings.body.append(listRow({ title: String(warning), badge: evidenceBadge('unverified') }));
      nodes.push(warnings.root);
    }
    content.replaceChildren(...nodes);
  };

  const renderEvidenceTab = async () => {
    content.replaceChildren(loadingState(text('根拠を集めています…', 'Collecting evidence…')));
    if (app.analysisQueries) {
      try {
        const snapshot = await app.analysisQueries.snapshot({ signal: routeSignal });
        const res = await app.analysisQueries.evidence(snapshot, { functionId: addr }, { limit: 100 }, { signal: routeSignal });
        if (!viewCurrent()) return;
        const stack = h('div', 'ui-evidence-stack');
        const name = app.symbols?.nameAt?.(addr);
        const boundaryEvidence = app.symbols?.functionEvidence?.(addr);
        const nameEvidence = app.symbols?.nameEvidence?.(addr);
        const boundaryStatus = provenanceStatus(boundaryEvidence);
        const nameStatus = provenanceStatus(nameEvidence);
        stack.append(listRow({ title: text('関数境界', 'Function boundary'), subtitle: addressText(addr), meta: boundaryEvidence?.source || text('由来不明', 'unknown source'), badge: evidenceBadge(boundaryStatus === 'manual' ? 'unverified' : boundaryStatus) }));
        stack.append(listRow({ title: text('関数名', 'Function name'), subtitle: name || text('シンボル名なし', 'No symbol name'), meta: nameStatus === 'manual' ? text('手動 / User', 'Manual / User') : (nameEvidence?.source || ''), badge: evidenceBadge(nameStatus === 'manual' ? 'unverified' : nameStatus) }));

        const items = Array.isArray(res.value) ? res.value : [];
        items.forEach((item, index) => {
          const itemEvidence = item?.evidence ?? item;
          const status = item?.verdict ?? evidenceStatus(itemEvidence);
          stack.append(listRow({
            title: evidenceTitle(itemEvidence, index),
            subtitle: evidenceSubtitle(itemEvidence),
            badge: evidenceBadge(status),
          }));
        });
        const note = card(text('表示の意味', 'How to read this'), { subtitle: text('「確認済み」はバイナリまたは実行観測に直接結び付いた事実です。推論は「可能性が高い」「未確認」のまま分離します。ランキング点を確率として表示しません。', 'Confirmed is reserved for facts tied directly to binary/runtime evidence. Inference remains Likely or Unverified; ranking scores are not presented as probabilities.') });
        content.replaceChildren(note.root, stack);
        return;
      } catch (err) {
        if (routeSignal.aborted) return;
        throw err;
      }
    }
    const res = await app.analyzeFunctionAt(addr, { signal: routeSignal });
    if (!viewCurrent()) return;
    if (!res || !res.model) { content.replaceChildren(errorState(text('関数を解析できません', 'Could not analyse function'), text('このアドレスは現在のコード領域の関数として解析できませんでした。', 'This address could not be analysed as a function in the current code region.'))); return; }
    renderEvidence(res);
  };

  const renderRuntimeTab = () => {
    const runScope = createChildTaskScope(routeSignal);
    const root = h('div', 'ui-card-grid');
    const c = card(text('実行時に確かめる', 'Verify at runtime'), { subtitle: text('新しいRuntime Analysis Platformで、この関数だけを安全なローカルsandbox上で実行・観測します。', 'Run this function in the Runtime Analysis Platform local sandbox and record evidence.') });
    const resultHost = h('div', 'ui-runtime-result');
    const run = uiButton(text('ローカル実行で観測する', 'Run local observation'), { cls: 'ui-primary-action' });
    run.addEventListener('click', async () => {
      run.disabled = true;
      const runSignal = runScope.spawn('runtime-run-replaced');
      resultHost.replaceChildren(loadingState(text('実行して観測しています…', 'Running and collecting observations…')));
      try {
        const result = await traceAppFunction(app, addr, { signal: runSignal, maxSteps: 12000, timeoutMs: 1500, limit: 4096 });
        if (!viewCurrent() || runSignal.aborted) return;
        const obs = result.observation || {};
        const stop = obs.stop?.kind || 'unknown';
        const direct = stop === 'return' ? 'confirmed' : 'unverified';
        const list = h('div', 'ui-list');
        list.append(listRow({ title: text('停止理由', 'Stop reason'), meta: stop, badge: evidenceBadge(direct) }));
        list.append(listRow({ title: text('実行命令数', 'Executed instructions'), meta: String(obs.steps ?? '—') }));
        list.append(listRow({ title: text('戻り値', 'Return value'), meta: obs.returnValue != null ? addressText(obs.returnValue) : '—', mono: true }));
        list.append(listRow({ title: text('分岐観測', 'Observed branches'), meta: String(obs.branches?.length || 0) }));
        list.append(listRow({ title: text('メモリ書き込み', 'Memory writes'), meta: String(obs.stores?.length || obs.memoryDelta?.length || 0) }));
        list.append(listRow({ title: text('Runtime evidence', 'Runtime evidence'), meta: String(result.evidence?.length || 0), badge: evidenceBadge(result.evidence?.length ? 'confirmed' : 'unverified') }));
        resultHost.replaceChildren(list);
      } catch (error) {
        if (!disposed && !runSignal.aborted && !routeSignal.aborted) {
          resultHost.replaceChildren(errorState(text('ローカル実行を完了できませんでした', 'Local runtime observation could not complete'), String(error?.message || error)));
        }
      } finally {
        if (!disposed && !routeSignal.aborted) run.disabled = false;
      }
    });
    c.body.append(run, resultHost);
    root.append(c.root);

    const capability = card(text('Live Debugger', 'Live Debugger'), { subtitle: text('Safari単体ではiOSプロセスへ任意attachできません。LLDB/Frida互換のlive観測は外部Hex bridge接続時のみ有効です。', 'Safari cannot arbitrarily attach to an iOS process. LLDB/Frida-compatible live observation requires an external Hex bridge.') });
    capability.body.append(uiButton(text('高度なDebuggerを開く', 'Open advanced debugger'), { cls: 'ui-secondary-action', onClick: () => showDebugger(app, addr) }));
    root.append(capability.root);
    content.replaceChildren(root);
  };

  const fallbackRouteController = routeContext.signal ? null : new AbortController();
  const routeSignal = routeContext.signal || fallbackRouteController.signal;

  (async () => {
    try {
      if (tab === 'calls') {
        await renderCalls();
      } else if (tab === 'runtime') {
        renderRuntimeTab();
      } else if (tab === 'pseudocode') {
        await renderPseudocodeTab();
      } else if (tab === 'flow') {
        await renderFlowTab();
      } else if (tab === 'evidence') {
        await renderEvidenceTab();
      } else {
        const res = await app.analyzeFunctionAt(addr, { signal: routeSignal });
        if (!viewCurrent()) return;
        if (!res || !res.model) { content.replaceChildren(errorState(text('関数を解析できません', 'Could not analyse function'), text('このアドレスは現在のコード領域の関数として解析できませんでした。', 'This address could not be analysed as a function in the current code region.'))); return; }
        renderOverview(res);
      }
    } catch (err) {
      if (viewCurrent() && !routeSignal.aborted) content.replaceChildren(errorState(text('表示できませんでした', 'Could not render this view'), String(err && err.message || err)));
    }
  })();

  return { root: s.root, getState: () => ({ scrollTop: s.body.scrollTop }), restoreState: (state) => { if (state) s.body.scrollTop = Number(state.scrollTop) || 0; }, dispose: () => { disposed = true; fallbackRouteController?.abort('function-workspace-disposed'); } };
}

export function findingIdentifier(item, idx) {
  if (item?.id != null && item.id !== '') return String(item.id);
  if (item?.findingId != null && item.findingId !== '') return String(item.findingId);
  if (item?.claimId != null && item.claimId !== '') return String(item.claimId);
  if (item?.key != null && item.key !== '') return String(item.key);
  const goal = item?.goal?.text || item?.goal?.id || item?.goal || item?.title || item?.name || 'finding';
  const addr = item?.addr ?? item?.address ?? item?.functionAddr ?? item?.function;
  const addrStr = addr != null ? BigInt(addr).toString(16) : 'global';
  const kind = item?.kind || item?.type || item?.claimType || item?.verdict || '';
  const evidenceId = item?.evidenceId || item?.evidence?.id || '';
  const rawKey = `${goal}:${addrStr}:${kind}:${evidenceId}`;
  let hash = 5381;
  for (let i = 0; i < rawKey.length; i++) {
    hash = ((hash << 5) + hash) + rawKey.charCodeAt(i);
    hash = hash & hash;
  }
  return 'f-' + (hash >>> 0).toString(16);
}

function renderFindingDetail(app, router, findingId) {
  const report = app.autoReport && app.autoReport.report;
  const findings = (report && (report.findings || report.results || report.goals)) || [];
  const targetId = String(findingId ?? '');
  const item = findings.find((f, idx) => findingIdentifier(f, idx) === targetId || String(f.id ?? f.claimId ?? f.key ?? '') === targetId);
  const s = screen(text('結果の詳細', 'Finding Detail'), {
    id: 'finding',
    subtitle: item ? (item.title || item.label || item.goal?.text || item.goal || text('解析結果', 'Finding')) : text('結果が見つかりません', 'Finding not found'),
  });
  if (!item) {
    s.body.append(emptyState(
      text('結果が見つかりません', 'Finding not found'),
      text('このIDの結果は現在の解析結果に存在しないか、更新されました。', 'This finding ID is not present in current analysis results or has expired.'),
      uiButton(text('結果一覧へ', 'Back to Results'), { cls: 'ui-primary-action', onClick: () => router.navigate('/results') })
    ));
    return { root: s.root };
  }
  const title = item.title || item.label || item.goal?.text || item.goal || text('解析結果', 'Finding');
  const address = item.addr ?? item.address ?? item.functionAddr ?? item.function;
  const c = card(String(title), { subtitle: address != null ? addressText(address) : '' });
  const verdict = item.verdict || (item.confirmed ? 'confirmed' : item.confidence > 0.7 ? 'likely' : 'unverified');
  c.body.append(listRow({
    title: text('確信度 / 状態', 'Verdict / Status'),
    meta: item.confidence != null ? `confidence ${Number(item.confidence).toFixed(2)}` : '',
    badge: evidenceBadge(verdict),
  }));
  if (item.summary || item.description || item.detail) {
    c.body.append(h('p', 'ui-lead', String(item.summary || item.description || item.detail)));
  }
  const actions = h('div', 'ui-actions');
  if (address != null) {
    actions.append(uiButton(text('該当関数を開く', 'Open function overview'), {
      cls: 'ui-primary-action',
      onClick: () => router.navigate('/function/' + BigInt(address).toString() + '/overview'),
    }));
    actions.append(uiButton(text('根拠を確認する', 'Review evidence'), {
      cls: 'ui-secondary-action',
      onClick: () => router.navigate('/function/' + BigInt(address).toString() + '/evidence'),
    }));
  }
  actions.append(uiButton(text('結果一覧に戻る', 'Back to Results'), {
    cls: 'ui-secondary-action',
    onClick: () => router.navigate('/results'),
  }));
  c.body.append(actions);
  s.body.append(c.root);
  return { root: s.root };
}

function renderResults(app, router, route) {
  if (route?.route?.id === 'finding' || route?.params?.id != null) {
    return renderFindingDetail(app, router, route.params.id);
  }
  const s = screen(text('結果', 'Results'), { id: 'results', subtitle: text('確認した答え、根拠、履歴、ピンをここへ集めます。', 'Confirmed answers, evidence, history and pins live here.') });
  const report = app.autoReport && app.autoReport.report;
  const findings = report && (report.findings || report.results || report.goals);
  if (Array.isArray(findings) && findings.length) {
    const renderFinding = (item, index) => {
      const title = item.title || item.label || item.goal?.text || item.goal || text('解析結果', 'Finding');
      const address = item.addr ?? item.address ?? item.functionAddr ?? item.function;
      const findingId = findingIdentifier(item, index);
      const verdict = item.verdict || (item.confirmed ? 'confirmed' : item.confidence > 0.7 ? 'likely' : 'unverified');
      return listRow({
        title: String(title),
        subtitle: address != null ? addressText(address) : '',
        badge: evidenceBadge(verdict),
        onClick: () => router.navigate('/finding/' + encodeURIComponent(String(findingId))),
      });
    };
    if (findings.length > 80) s.body.append(new VirtualList({ items: findings, rowHeight: 64, ariaLabel: text('解析結果', 'Analysis results'), renderRow: renderFinding }).root);
    else {
      const list = h('div', 'ui-list');
      findings.forEach((item, index) => list.append(renderFinding(item, index)));
      s.body.append(list);
    }
  } else {
    s.body.append(emptyState(text('まだ確定した結果がありません', 'No confirmed results yet'), text('「調べる」で目的を入力すると、答えと根拠をここから辿れるようになります。', 'Investigate a goal to create results you can revisit.'), uiButton(text('調べるへ', 'Go to Investigate'), { cls: 'ui-primary-action', onClick: () => router.navigate('/investigate') })));
  }
  return { root: s.root };
}

function pickOneFile(accept='') {
  return new Promise((resolve) => {
    const input=document.createElement('input'); input.type='file'; input.accept=accept;
    input.style.position='fixed'; input.style.left='-10000px'; document.body.append(input);
    const finish=(file)=>{input.remove();resolve(file||null);};
    input.addEventListener('change',()=>finish(input.files?.[0]||null),{once:true});
    input.addEventListener('cancel',()=>finish(null),{once:true});
    input.click();
  });
}
function downloadBlob(blob,name) {
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url;a.download=name||'analysis.hexproj';a.style.display='none';document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function exportProjectFromProduct(app) {
  try { const blob=await app.exportProjectFile(); downloadBlob(blob,(app.store.get('fileInfo')?.name||'analysis')+'.hexproj'); toast(text('プロジェクトを書き出しました。','Project exported.')); }
  catch(error){toast(text('プロジェクトを書き出せませんでした: ','Could not export project: ')+String(error?.message||error));}
}
async function importProjectFromProduct(app) {
  const file=await pickOneFile('.hexproj,application/json'); if(!file)return;
  try { await app.importProjectFile(file); toast(text('プロジェクトを復元しました。','Project restored.')); }
  catch(error){const mismatch=error?.code==='HEX_PROJECT_BINARY_MISMATCH';toast(mismatch?text('このプロジェクトは現在のバイナリ/スライス用ではありません。','This project belongs to a different binary or slice.'):text('プロジェクトを読み込めませんでした: ','Could not import project: ')+String(error?.message||error));}
}

function renderDiff(app,router,routeContext = {}) {
  const s=screen(text('バイナリ差分','Binary Diff'),{id:'diff',subtitle:text('前のバージョンと現在のバージョンを関数単位で比較します。','Compare a previous version with the current binary at function granularity.')});
  const host=h('div','ui-stack');s.body.append(host);
  const fallbackRouteController=routeContext.signal?null:new AbortController();
  const routeSignal=routeContext.signal||fallbackRouteController.signal;
  const compareScope=createChildTaskScope(routeSignal);
  if(!app.store.get('fileInfo')){host.append(emptyState(text('先に現在のバイナリを開いてください','Open the current binary first'),'',uiButton(text('コードへ','Go to Code'),{onClick:()=>router.navigate('/code')})));return {root:s.root};}
  const state=app.getBinaryDiff?.(); const baseline=app.workspace?.baseline;
  const controls=h('div','ui-actions');
  controls.append(uiButton(baseline?text('比較元を変更','Change baseline'):text('前のバージョンを選ぶ','Choose previous version'),{cls:'ui-primary-action',onClick:async()=>{
    const file=await pickOneFile();if(!file||routeSignal.aborted)return;
    const signal=compareScope.spawn('diff-baseline-replaced');
    host.replaceChildren(loadingState(text('比較元を解析しています…','Analysing baseline…')));
    try{
      await app.workspace.loadBaseline(file,{signal});
      await app.workspace.diff({signal});
      if(!signal.aborted&&!routeSignal.aborted)router.navigate('/diff',{replace:true});
    } catch(error){if(!signal.aborted&&!routeSignal.aborted)host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}
  }}));
  if(baseline)controls.append(uiButton(text('再比較','Compare again'),{onClick:async()=>{
    const signal=compareScope.spawn('diff-rerun-replaced');
    host.replaceChildren(loadingState(text('比較しています…','Comparing…')));
    try{await app.workspace.diff({signal});if(!signal.aborted&&!routeSignal.aborted)router.navigate('/diff',{replace:true});}
    catch(error){if(!signal.aborted&&!routeSignal.aborted)host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}
  }}));
  host.append(controls);
  if(!state){host.append(emptyState(text('比較元を選ぶと変更された関数を抽出します','Choose a baseline to find changed functions'),text('同一CPU/スライスだけを比較し、不完全な探索では new/deleted を断定しません。','Only matching architectures/slices are compared; incomplete matching never invents new/deleted certainty.')));return {root:s.root};}
  const counts={same:0,moved:0,changed:0,rewritten:0,new:0,deleted:0,unresolved:0};
  for(const c of state.changes||[])counts[c.changeType]=(counts[c.changeType]||0)+1;
  const summary=card(text('比較結果','Diff summary'));
  summary.body.append(h('p','ui-body',`${counts.changed||0} changed · ${counts.rewritten||0} rewritten · ${counts.moved||0} moved · ${counts.new||0} new · ${counts.deleted||0} deleted · ${counts.unresolved||0} unresolved`));
  summary.body.append(h('p',state.completeness?.complete?'ui-sub':'ui-warning',state.completeness?.complete?text('関数集合とmatchingは完全です。','Function sets and matching are complete.'):text('部分結果です: ','Partial result: ')+(state.completeness?.reasons||[]).join(', ')));
  host.append(summary.root);
  const interesting=(state.changes||[]).filter((c)=>c.changeType!=='same').slice(0,5000);
  const render=(c)=>{const current=c.after?.address??null;const previous=c.before?.address??null;const title=c.after?.name||c.before?.name||(current!=null?functionName(app,current):text('削除された関数','Deleted function'));const tags=c.semanticChange?.tags?.join(', ')||'';return listRow({title,subtitle:[c.changeType,current!=null?addressText(current):previous!=null?'old '+addressText(previous):'',tags].filter(Boolean).join(' · '),badge:evidenceBadge(c.changeType==='unresolved'?'unverified':c.confidence>=0.82?'confirmed':'likely'),onClick:current!=null?()=>router.navigate('/function/'+BigInt(current).toString()+'/overview'):null});};
  if(interesting.length>100)host.append(new VirtualList({items:interesting,rowHeight:64,ariaLabel:text('変更関数','Changed functions'),renderRow:render}).root);else{const list=h('div','ui-list');for(const c of interesting)list.append(render(c));host.append(list);}
  return {root:s.root,dispose:()=>{compareScope.abort('diff-route-disposed');fallbackRouteController?.abort('diff-route-disposed');}};
}

function renderAdvanced(app) {
  const s = screen(text('高度な機能', 'Advanced / Lab'), { id: 'advanced', subtitle: text('通常の調査では不要な低レベル機能だけをまとめています。', 'Low-level tools that are not required for the normal question-to-answer flow.') });
  const list = h('div', 'ui-list');
  list.append(listRow({ title: text('ファイル情報', 'File information'), onClick: () => requireFile(app, () => showFileInfo(app)) }));
  list.append(listRow({ title: text('セクション詳細', 'Section details'), onClick: () => requireFile(app, () => showSections(app)) }));
  list.append(listRow({ title: text('構造 / 生データ', 'Structure / raw data'), onClick: () => requireFile(app, () => showStructure(app)) }));
  list.append(listRow({ title: text('解析ツール一覧', 'Analysis tools'), subtitle: text('パッチ・スクリプト・プラグイン等', 'Patching, scripting, plugins, etc.'), onClick: () => requireFile(app, () => showTools(app)) }));
  list.append(listRow({ title:text('プロジェクトを書き出す (.hexproj)','Export project (.hexproj)'), subtitle:text('名前・メモ・型・patch・解析結果・AI調査・移動履歴を保存','Save names, notes, types, patches, findings, AI investigation and navigation'), onClick:()=>requireFile(app,()=>exportProjectFromProduct(app)) }));
  list.append(listRow({ title:text('プロジェクトを読み込む','Import project'), subtitle:text('現在のバイナリhashとsliceが一致した場合だけ復元します','Restores only when binary hash and slice identity match'), onClick:()=>requireFile(app,()=>importProjectFromProduct(app)) }));
  list.append(listRow({ title:text('バージョン差分','Binary Diff'), subtitle:text('前のバイナリと変更関数を比較','Compare changed functions against a previous binary'), onClick:()=>requireFile(app,()=>window.__hexUi?.router?.navigate('/diff')) }));
  s.body.append(list);
  return { root: s.root };
}

function symbolAddress(app, name) {
  const sym = app.symbols;
  const names = sym && Array.isArray(sym.names) ? sym.names : [];
  const wanted = String(name || '').toLowerCase();
  for (let i = 0; i < names.length; i++) {
    if (String(names[i] || '').toLowerCase() === wanted) return sym.addrs[i];
  }
  const sub = /^sub_?([0-9a-f]+)$/i.exec(wanted);
  if (sub) { try { return BigInt('0x' + sub[1]); } catch { /* not an address */ } }
  return null;
}

/*
 * One omnibox.
 *
 * Search, jump, command palette and "ask the assistant" were four different
 * entry points; they are one field now because the user rarely knows in
 * advance which of the four their question is. The intent is classified as
 * they type (js/ai/interaction/omnibox.js) and shown next to the field, so
 * pressing Enter is never a surprise.
 */
function installCommandCenter(app, router, actions, host, getAssistant) {
  const form = h('form', 'ui-command-center');
  const input = h('input', 'ui-global-command');
  input.type = 'search';
  input.placeholder = text('検索・アドレス・> コマンド・? AIに質問', 'Search, address, > command, ? ask AI');
  input.setAttribute('aria-label', text('検索と移動', 'Search and navigate'));
  input.autocomplete = 'off'; input.autocapitalize = 'off'; input.spellcheck = false;
  const hint = h('span', 'ui-command-hint');
  hint.setAttribute('aria-live', 'polite');
  const go = uiButton(text('実行', 'Go'), { cls: 'ui-command-go' });
  form.append(input, hint, go);

  const refreshHint = () => {
    const intent = classifyOmnibox(input.value);
    hint.textContent = intent.kind === 'empty' ? '' : intentLabel(intent.kind, ja());
    form.dataset.intent = intent.kind;
  };
  input.addEventListener('input', refreshHint);

  const runCommand = (intent) => {
    switch (intent.command) {
      case 'code': router.navigate('/code'); return true;
      case 'explorer': router.navigate('/explorer/functions'); return true;
      case 'results': router.navigate('/results'); return true;
      case 'settings': router.navigate('/settings'); return true;
      case 'help': router.navigate('/help'); return true;
      case 'learn': router.navigate('/learn'); return true;
      case 'advanced': router.navigate('/advanced'); return true;
      case 'ai': getAssistant()?.open(); return true;
      case 'agent': getAssistant()?.ask(text('この一覧から調べたいことを教えてください。', 'Tell me what to investigate.'), { mode: 'agent' }); return true;
      default: return false;
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const intent = classifyOmnibox(input.value);
    if (intent.kind === 'empty') return;
    input.blur();
    if (intent.kind === 'ai') {
      const assistant = getAssistant();
      if (assistant) { assistant.ask(intent.value); input.value = ''; refreshHint(); return; }
      router.navigate('/investigate');
      return;
    }
    if (intent.kind === 'command' && runCommand(intent)) return;
    if (intent.kind === 'address') {
      const addr = parseAddress(intent.value);
      if (addr != null) { app.goToAddress(addr, { announce: true }); router.navigate('/code/' + addr.toString()); return; }
    }
    if (intent.kind === 'symbol') {
      const addr = symbolAddress(app, intent.value);
      if (addr != null) { router.navigate('/function/' + BigInt(addr).toString() + '/overview'); return; }
    }
    if (intent.kind === 'string') {
      router.navigate('/explorer/strings?q=' + encodeURIComponent(intent.value));
      return;
    }
    router.navigate('/explorer/functions?q=' + encodeURIComponent(intent.value));
  });
  host.append(form);
  actions.register('command.focus', () => { input.focus(); input.select(); });
  return input;
}

export function installProductUI(app) {
  if (!app || uiRoot()?.classList.contains('product-ui-ready')) return null;
  const appRoot = document.getElementById('app');
  if (!appRoot) return null;
  const actions = createActionRegistry();
  const routeHost = h('main', 'ui-route-host');
  routeHost.id = 'ui-route-host'; routeHost.tabIndex = -1;
  const chrome = h('div', 'ui-product-chrome');
  const nav = h('nav', 'ui-bottom-nav');
  nav.setAttribute('aria-label', text('主要ナビゲーション', 'Primary navigation'));
  const titlebar = appRoot.querySelector('.titlebar');
  titlebar?.after(chrome);
  const addrbar = appRoot.querySelector('.addrbar');
  if (addrbar) appRoot.insertBefore(routeHost, addrbar); else appRoot.append(routeHost);
  /*
   * The destinations live in the chrome row, not in a rail down the left edge.
   * On a wide screen they are compact tabs beside the omnibox, which returns
   * 76px of width to the disassembly; below 900px the same element is pinned
   * to the bottom of the viewport where a thumb can reach it. `position:
   * fixed` still resolves against the viewport here because the chrome uses a
   * plain background — a backdrop-filter on the parent would have trapped it.
   */
  chrome.append(nav);

  const router = new ProductRouter(ROUTES, {
    /*
     * Code first, including before a file exists: the landing state is the
     * workbench with its compact open/sample card, not a question screen that
     * has nothing to answer questions about yet.
     */
    defaultPath: '/code',
    onRoute: (route, routeContext = {}) => {
      appRoot.classList.toggle('ui-code-route', route.route.id === 'code');
      appRoot.classList.toggle('ui-screen-route', route.route.id !== 'code');
      for (const b of nav.querySelectorAll('[data-route-id]')) b.setAttribute('aria-current', b.dataset.routeId === route.route.id ? 'page' : 'false');
      if (route.route.id === 'code') {
        routeHost.hidden = true;
        const raw = route.params.address;
        if (raw) { try { app.goToAddress(BigInt(raw), { announce: false, history: false }); } catch { /* invalid deep link */ } }
        return codeViewState(app);
      }
      routeHost.hidden = false;
      routeHost.replaceChildren();
      let view;
      if (route.route.id === 'investigate') view = renderInvestigate(app, router, routeContext);
      else if (route.route.id === 'explorer') view = renderExplorer(app, router, route, routeContext);
      else if (route.route.id === 'function') view = renderFunctionWorkspace(app, router, route, routeContext);
      else if (route.route.id === 'results' || route.route.id === 'finding') view = renderResults(app, router, route);
      else if (route.route.id === 'diff') view = renderDiff(app, router, routeContext);
      else if (route.route.id === 'advanced') view = renderAdvanced(app);
      else view = renderSecondaryRoute(app, router, route, routeContext);
      routeHost.append(view.root);
      requestAnimationFrame(() => routeHost.focus({ preventScroll: true }));
      const originalGet = view.getState;
      return {
        ...view,
        getState: () => ({ ...(originalGet ? originalGet() : {}), routeScroll: routeHost.scrollTop }),
        restoreState: (state) => { view.restoreState?.(state); routeHost.scrollTop = Number(state?.routeScroll) || 0; },
      };
    },
  });

  let assistant = null;
  const originalSelectSlice = typeof app.selectSlice === 'function' ? app.selectSlice.bind(app) : null;
  if (originalSelectSlice) {
    app.selectSlice = async (...args) => {
      const beforeEpoch = app.backend?.gen;
      const result = await originalSelectSlice(...args);
      if (app.backend?.gen !== beforeEpoch) {
        router.navigate('/code', { replace: true });
        assistant?.refresh();
        assistant?.collapse();
      }
      return result;
    };
  }
  installCommandCenter(app, router, actions, chrome, () => assistant);
  const more = uiButton('•••', { cls: 'ui-more-button', ariaLabel: text('その他', 'More'), onClick: (event) => {
    const r = event.currentTarget.getBoundingClientRect();
    menu([
      { label: text('設定', 'Settings'), action: () => router.navigate('/settings') },
      { label: text('学ぶ', 'Learn'), action: () => router.navigate('/learn') },
      { label: text('ヘルプ', 'Help'), action: () => router.navigate('/help') },
      '-',
      { label: text('高度な機能', 'Advanced / Lab'), action: () => router.navigate('/advanced') },
    ], r.left + r.width / 2, r.bottom + 4);
  } });
  chrome.append(more);

  for (const item of PRIMARY_NAV) {
    const b = uiButton(item.icon + '\n' + item.label, { cls: 'ui-nav-item', onClick: () => router.navigate(item.route) });
    b.dataset.routeId = item.routeId;
    nav.append(b);
  }
  actions.register('navigate.investigate', () => router.navigate('/investigate'));
  actions.register('navigate.code', () => router.navigate('/code/' + (currentAddress(app)?.toString() || '')));
  actions.register('navigate.explorer', () => router.navigate('/explorer/functions'));
  actions.register('navigate.results', () => router.navigate('/results'));
  actions.register('function.open', (addr, tab = 'overview') => router.navigate('/function/' + BigInt(addr).toString() + '/' + tab));

  const cleanupViewport = installViewportBridge();
  const shortcut = (event) => {
    const target = event.target;
    const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); actions.run('command.focus'); return; }
    if (!typing && event.key === '/') { event.preventDefault(); actions.run('command.focus'); }
  };
  document.addEventListener('keydown', shortcut, true);

  uiRoot()?.classList.add('product-ui-ready');
  router.start();

  /*
   * Code first. Opening a file used to land on the question screen (or behind
   * an overview sheet); the workbench now goes straight to the disassembly,
   * and the assistant is the thing you call when you have a question about it.
   */
  const onFileOpened = () => {
    router.navigate('/code');
    assistant?.refresh();
    /* On a phone or a narrow split the panel covers the code it is about to
       be asked about; step aside and leave the launcher. */
    assistant?.collapse();
  };
  document.addEventListener('hex:file-opened', onFileOpened);

  assistant = installAssistant(app, { router, actions });
  actions.register('ai.open', () => assistant?.open());
  actions.register('ai.ask', (question, options) => assistant?.ask(question, options));

  const destroy = () => {
    router.stop(); cleanupViewport();
    document.removeEventListener('keydown', shortcut, true);
    document.removeEventListener('hex:file-opened', onFileOpened);
    assistant?.destroy();
    if (originalSelectSlice) app.selectSlice = originalSelectSlice;
    chrome.remove(); nav.remove(); routeHost.remove();
    uiRoot()?.classList.remove('product-ui-ready');
  };
  window.addEventListener('pagehide', () => { router.capture(); app.saveWorkspace?.(); }, { passive: true });
  window.__hexUi = { router, actions, destroy, routes: ROUTES, assistant };
  return window.__hexUi;
}

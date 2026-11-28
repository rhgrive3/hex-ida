import { ProductRouter, createChildTaskScope } from './router.js';
import {
  ROUTES, PRIMARY_NAV, EXPLORER_SCOPES, FUNCTION_TABS, createActionRegistry,
} from './registry.js';
import {
  h, uiButton, screen, card, emptyState, loadingState, errorState, evidenceBadge,
  tabs, tabPanel, updateScreenTitle, sectionTitle, listRow, VirtualList, scrollStrip, reasonText, statusNotice,
} from './primitives.js';
import { renderSecondaryRoute } from './secondary.js';
import * as formatMod from '../format.js';
import { pick, isJa as i18nIsJa } from '../i18n.js';
import { menu, copyText, toast, closeAllSheets, closeMenu, Sheet, el, button, alertDialog } from '../ui.js';
import {
  currentFunctionAddr, showTools, showRename, showComment, showDebugger, showGlobals, showPatches,
} from '../tools.js';
import { findGlobals, importList } from '../linkage.js';
import { findCxxClasses } from '../rtti.js';
import { compileGoal } from '../goalc.js';
import { decompile, decompiledText } from '../decompile.js';
import { cfgGraph, callGraph, renderGraph, graphLegend } from '../graphview.js';
import { classifyFunction, discoverSubsystems } from '../recognition/classifier.js';
import { traceAppFunction, runtimeEvidenceForApp } from '../runtime/app-runtime.js';
import { installAssistant } from '../ai/ui/assistant.js';
import {
  classifyOmnibox, intentLabel, COMMANDS,
  rankSearchResults, scoreSearchMatch, matchGoalForQuery,
} from '../ai/interaction/omnibox.js';
import { buildGoalCandidateSummary, findGoalHighlightLines } from './function-analysis-presentation.js';
import { askAiMenuItem, functionAiItems } from '../ai/interaction/contextual.js';
import { productDescriptor } from '../platform/product-descriptor.js';
import * as explorerIndex from './explorer-index.js';
import { reportFile } from './investigation-report.js';
import { setSyncAddress, syncAddressFor, highlightGraphNode } from './view-sync.js';
import { findEntryPaths } from '../analysis/entry-paths.js';
import { markMission, missionSteps, missionFunction } from './mission.js';
import { probeFunction, summarize as summarizeProbe, arityFromPseudocode, formatArgs, formatValue } from '../analysis/io-probe.js';
import { libraryIndexFor, libraryInfoAt, isFoldable, libraryKindLabel, classifyClassName, recognitionVendorContext } from '../analysis/library-code.js';
import { genericEvidenceStatus, ownerEvidence, summaryEvidenceStatus, provenanceStatus } from './evidence-model.js';
import { uiRoot } from '../ui-root.js';
import {
  createDecompilerProvenanceView, appendHighlighted, attachTokenHighlight,
  preludeLength, findSignatureLineIndex,
} from './decompiler-provenance.js';


let _productPanelsPromise = null;
function productPanels() { return _productPanelsPromise ||= import('../panels.js'); }
function lazyProductPanel(name) { return (...args) => productPanels().then((module) => module[name](...args)); }
const showFileInfo = lazyProductPanel('showFileInfo');
const showSections = lazyProductPanel('showSections');
const showStructure = lazyProductPanel('showStructure');
const showCandidates = lazyProductPanel('showCandidates');
const showClass = lazyProductPanel('showClass');
const showJump = lazyProductPanel('showJump');
const showSearchPanel = lazyProductPanel('showSearch');
const showXrefs = lazyProductPanel('showXrefs');

const { addrHex, parseAddress, sizeText } = formatMod;
function isExplicitAddressOrExpr(q) {
  const s = String(q || '').trim();
  if (!s) return false;
  if (/^0x[0-9a-f]+$/i.test(s) || /^sub_[0-9a-f]+$/i.test(s)) return true;
  if (/^[0-9a-f]{6,16}$/i.test(s) && /[0-9]/.test(s)) return true;
  if (/[+-]/.test(s) && /^(?:(?:0x[0-9a-f]+|[0-9a-f]{6,16})\s*[+-]\s*(?:0x[0-9a-f]+|\d+)|[A-Za-z_$][\w$]*(?:(?:::|\.|->)[\w$]+)*\s*(?:\+\s*(?:0x[0-9a-f]+|\d+)|-\s*0x[0-9a-f]+))$/i.test(s)) return true;
  return false;
}

function parseAddressInput(app, q, { allowBareSymbol = true } = {}) {
  const s = String(q || '').trim();
  if (!s) return null;
  if (!allowBareSymbol && !isExplicitAddressOrExpr(s)) return null;
  if (typeof formatMod.parseAddressExpr === 'function') {
    try {
      const resolved = formatMod.parseAddressExpr(s, (name) => symbolAddress(app, name));
      if (resolved != null && BigInt(resolved) >= 0n) return BigInt(resolved);
    } catch { /* fall through */ }
  }
  const direct = parseAddress(q);
  return direct != null && direct >= 0n ? direct : null;
}

const ja = () => {
  const rootLang = uiRoot()?.lang;
  if (rootLang) return String(rootLang).toLowerCase().startsWith('ja');
  return i18nIsJa();
};
const text = (j, e) => (uiRoot()?.lang ? (ja() ? j : e) : pick(j, e));

function addressText(value) {
  try { return addrHex(typeof value === 'bigint' ? value : BigInt(value)); } catch { return String(value || '—'); }
}

function functionName(app, addr) {
  if (addr == null) return text('関数', 'Function');
  const sym = app.symbols;
  const raw = sym && (sym.nameAt?.(addr) || sym.label?.(addr));
  return raw || ('sub_' + BigInt(addr).toString(16).toUpperCase());
}

export function isFunctionStart(app, rawAddr) {
  if (rawAddr == null) return false;
  let big;
  try { big = BigInt(rawAddr); } catch { return false; }
  const regions = app?.store?.get?.('regions') || [];
  const region = regions.find((r) => r && r.size > 0n && big >= r.vmAddr && big < r.vmAddr + r.size);
  if (region && !region.exec) return false;
  const sym = app?.symbols;
  if (!sym) return false;
  try {
    const fn = sym.functionAt?.(big);
    if (fn?.start != null && BigInt(fn.start) === big) return true;
    const start = sym.functionStartAt?.(big);
    if (start != null && BigInt(start) === big) return true;
  } catch { /* ignore */ }
  if ((Array.isArray(sym.funcs) || ArrayBuffer.isView(sym.funcs)) && sym.funcs.length) {
    const idx = lowerBoundBigInt(sym.funcs, big);
    if (idx < sym.funcs.length) {
      try { if (BigInt(sym.funcs[idx]) === big) return true; } catch { /* ignore */ }
    }
  }
  return false;
}

export function bookmarkLabel(app, rawAddr) {
  if (rawAddr == null) return text('アドレス', 'Address');
  let big;
  try { big = BigInt(rawAddr); } catch { return String(rawAddr); }
  const regions = app?.store?.get?.('regions') || [];
  const region = regions.find((r) => r && r.size > 0n && big >= r.vmAddr && big < r.vmAddr + r.size);
  const sym = app?.symbols;
  const exactSym = sym && (sym.nameAt?.(big) || sym.label?.(big)) || null;
  if (!region || region.exec) {
    let start = null;
    try { start = sym?.functionAt?.(big)?.start ?? sym?.functionStartAt?.(big) ?? null; } catch { start = null; }
    if (start != null) {
      const startBig = BigInt(start);
      const fnName = functionName(app, startBig);
      const offset = big - startBig;
      return offset > 0n ? `${fnName}+0x${offset.toString(16).toUpperCase()}` : fnName;
    }
    if (exactSym) return exactSym;
  }
  if (exactSym) return exactSym;
  const regName = region?.section || region?.name || text('データ', 'Data');
  return `${regName} @ ${addressText(big)}`;
}

export function openAddressTarget(app, router, rawAddr, { preferTab } = {}) {
  if (rawAddr == null || !router) return false;
  let big;
  try { big = BigInt(rawAddr); } catch { return false; }
  const regions = app?.store?.get?.('regions') || [];
  const region = regions.find((r) => r && r.size > 0n && big >= r.vmAddr && big < r.vmAddr + r.size);
  const isExec = !region || !!region.exec;
  if (isExec && isFunctionStart(app, big)) {
    const verified = app?.validatedFunctionRange?.(big);
    if (!verified || verified.ok) {
      const tab = preferTab || app?.uiResume?.lastFunctionTab || 'overview';
      const safeTab = FUNCTION_TABS.some((t) => t.id === tab) ? tab : 'overview';
      return router.navigate('/function/' + big.toString() + '/' + safeTab);
    }
  }
  return router.navigate('/code/' + big.toString());
}

export function syncRouteNavigation(app, router, route, routeContext = {}) {
  if (!route) return;
  const id = route.route?.id;
  let label = '';
  let navAddr = null;
  if (id === 'code') {
    if (route.params?.address) {
      try { navAddr = BigInt(route.params.address); } catch { navAddr = null; }
    }
    const addr = navAddr ?? currentAddress(app);
    label = addr != null ? bookmarkLabel(app, addr) : text('コード', 'Code');
  } else if (id === 'function') {
    if (route.params?.address) {
      try { navAddr = BigInt(route.params.address); } catch { navAddr = null; }
    }
    label = navAddr != null ? functionName(app, navAddr) : text('関数', 'Function');
  } else if (id === 'explorer') {
    label = text('索引', 'Explorer');
  } else if (id === 'results' || id === 'finding') {
    label = text('結果', 'Results');
  } else if (id === 'investigate') {
    label = text('調べる', 'Investigate');
  } else if (id === 'diff') {
    label = text('バイナリ差分', 'Binary Diff');
  } else {
    label = id || '';
  }
  router?.setCurrentLabel?.(label);
  if (!routeContext?.historyNavigation && (id === 'code' || id === 'function') && navAddr != null) {
    const entry = app?.navigationEntry?.(navAddr, label) || {
      key: route.fullPath || (`/${id}/${navAddr.toString()}`),
      addr: navAddr,
      label,
    };
    app?.navigation?.visit?.(entry);
  }
  if (app?.store?.get?.('fileInfo') && !app._applyingDelta) {
    app.scheduleDeltaSave?.();
  }
}

function bookmarkListOf(app) {
  try {
    const raw = app?.bookmarks?.list?.();
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function editBookmarkNote(app, addr, name) {
  const sheet = new Sheet(text('ブックマークメモを編集', 'Edit bookmark note'));
  const existing = app.bookmarks?.get?.(addr)
    ?? bookmarkListOf(app).find((b) => { try { return BigInt(b.addr) === BigInt(addr); } catch { return false; } });
  const field = el('div', 'field');
  const input = el('input');
  input.type = 'text';
  input.value = String(existing?.note || '');
  input.placeholder = text('メモを入力…', 'Enter note…');
  const save = () => {
    if (!app.bookmarks?.has?.(addr)) app.bookmarks?.toggle?.(addr, { name });
    app.bookmarks?.setNote?.(addr, { note: input.value.trim(), name });
    sheet.close();
    toast(text('ブックマークメモを保存しました。', 'Bookmark note saved.'));
  };
  field.append(input, button(text('保存', 'Save'), 'chip', save));
  sheet.body.append(field);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  setTimeout(() => input.focus(), 50);
}

export function makeStarButton(app, addr, name, { cls = 'ui-icon-action ui-star-btn', stopPropagation = false, onToggled = null } = {}) {
  const isSaved = () => !!app.bookmarks?.has?.(addr);
  const starTitle = (saved) => saved
    ? text('ブックマークを解除 (B)', 'Remove bookmark (B)')
    : text('ブックマークに追加 (B)', 'Bookmark function (B)');
  const btn = uiButton(isSaved() ? '★' : '☆', {
    cls,
    ariaLabel: isSaved() ? text('ブックマークを解除', 'Remove bookmark') : text('ブックマークに追加', 'Bookmark function'),
    pressed: isSaved(),
    onClick: (event) => {
      if (stopPropagation) event.stopPropagation();
      app.bookmarks?.toggle?.(addr, { name });
      sync();
      onToggled?.(isSaved());
    },
  });
  btn.title = starTitle(isSaved());
  const sync = () => {
    const saved = isSaved();
    btn.textContent = saved ? '★' : '☆';
    btn.setAttribute('aria-pressed', String(saved));
    btn.setAttribute('aria-label', saved ? text('ブックマークを解除', 'Remove bookmark') : text('ブックマークに追加', 'Bookmark function'));
    btn.title = starTitle(saved);
  };
  btn._syncStar = sync;
  return btn;
}

function deltaCountOf(info) {
  if (!info || typeof info !== 'object') return 0;
  const raw = info.savedCount ?? info.count ?? info.total ?? info.applied ?? info.deltaCount ?? info.changes;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (Array.isArray(raw)) return raw.length;
  return 0;
}

function formatRecentTime(ts) {
  if (ts == null) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString(ja() ? 'ja-JP' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
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

function noFileActions(app) {
  const actions = h('div', 'ui-actions');
  actions.append(
    uiButton(text('ファイルを開く', 'Open file'), {
      cls: 'ui-primary-action',
      onClick: () => {
        const registry = window.__hexUi?.actions;
        if (registry?.has?.('file.open') && typeof registry.run === 'function') registry.run('file.open');
        else document.getElementById('file-input')?.click();
      },
    }),
    uiButton(text('サンプルで試す', 'Try sample'), {
      cls: 'ui-secondary-action',
      onClick: () => app.openSample?.(),
    }),
  );
  return actions;
}

export function formatBlockCount(blocks, { instructions = null, size = null } = {}) {
  const hasCode = (Number(instructions) > 0) || (Number(size) > 0);
  if (blocks == null) return hasCode ? text('計算中', 'Computing...') : '—';
  const n = Number(blocks);
  if (Number.isFinite(n) && n === 0 && hasCode) return text('計算中', 'Computing...');
  return String(blocks);
}

export function isBinaryUnboundError(error) {
  const msg = String(error?.message || error || '');
  return msg.includes('analysis-query-binary-unbound');
}

export function renderBinaryUnboundCard(app, { title = null, subtitle = null } = {}) {
  const openPicker = () => {
    const registry = window.__hexUi?.actions;
    if (registry?.has?.('file.open') && typeof registry.run === 'function') registry.run('file.open');
    else document.getElementById('file-input')?.click();
  };
  const actions = h('div', 'ui-actions');
  const prevBtn = uiButton(text('前回のファイルを開く', 'Open previous file'), {
    cls: 'ui-primary-action ui-open-previous-btn',
    onClick: async () => {
      try {
        const saved = typeof app?.analysisResume?.loadLastFile === 'function'
          ? await Promise.resolve(app.analysisResume.loadLastFile())
          : null;
        if (saved?.file && typeof app.openFile === 'function') {
          await app.openFile(saved.file, { restored: true });
          return;
        }
      } catch { /* fall through to picker */ }
      openPicker();
    },
  });
  actions.append(
    prevBtn,
    uiButton(text('ファイルを開く', 'Open file'), { cls: 'ui-secondary-action', onClick: openPicker }),
    uiButton(text('サンプルで試す', 'Try sample'), { cls: 'ui-secondary-action', onClick: () => app?.openSample?.() }),
  );
  const state = emptyState(
    title || text('前回のファイルがまだ開かれていません', 'Previous file is not open yet'),
    subtitle || text(
      'ページを再読み込みした後はバイナリをもう一度開く必要があります。「前回のファイルを開く」から続きを再開できます。',
      'After reloading, reopen the binary to continue viewing this function or code. Use "Open previous file" to resume.',
    ),
    actions,
  );
  state.classList.add('ui-binary-unbound-card');
  return state;
}

function collectFrequentFunctions(app, limit = 5) {
  const out = [];
  const seen = new Set();
  const pushFn = (addr, name, callCount = null) => {
    if (addr == null) return;
    let big;
    try { big = BigInt(addr); } catch { return; }
    const key = big.toString();
    if (seen.has(key)) return;
    seen.add(key);
    if (isFoldable(libraryInfoAt(app, big))) return;
    out.push({ addr: big, name: String(name || functionName(app, big)), callCount });
  };
  const hot = app?.appMap?.hotFunctions || app?.autoReport?.report?.notable || null;
  if (Array.isArray(hot)) {
    for (const item of hot) {
      if (out.length >= limit) break;
      const addr = item?.addr ?? item?.address ?? item?.start;
      pushFn(addr, item?.name, item?.callCount ?? item?.calls ?? null);
    }
  }
  if (out.length < limit && app?.symbols) {
    const funcs = Array.isArray(app.symbols.funcs) ? app.symbols.funcs : [];
    const scored = [];
    const maxScan = Math.min(funcs.length, 400);
    for (let i = 0; i < maxScan; i++) {
      const f = funcs[i];
      const addr = f?.start ?? f?.addr ?? (typeof f === 'bigint' || typeof f === 'number' ? f : null);
      if (addr == null) continue;
      let big;
      try { big = BigInt(addr); } catch { continue; }
      const calls = typeof app.program?.callCountOf === 'function' ? Number(app.program.callCountOf(big) || 0) : 0;
      const name = app.symbols.nameAt?.(big) || f?.name || '';
      if (calls > 0 || name) scored.push({ addr: big, name: name || functionName(app, big), callCount: calls });
    }
    scored.sort((a, b) => (b.callCount - a.callCount) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of scored) {
      if (out.length >= limit) break;
      pushFn(item.addr, item.name, item.callCount > 0 ? item.callCount : null);
    }
  }
  return out.slice(0, limit);
}

function buildMissionSection(app, router) {
  const wrap = h('div', 'ui-quickstart-section ui-mission');
  const render = () => {
    const steps = missionSteps(app);
    const doneCount = steps.filter((x) => x.done).length;
    const heading = h('h3', 'ui-quickstart-heading', text(`ミッション ${doneCount} / ${steps.length}`, `Mission ${doneCount} / ${steps.length}`));
    const list = h('ol', 'ui-mission-steps');
    const next = steps.find((x) => !x.done) || null;
    const fn = missionFunction(app);
    for (const step of steps) {
      const li = h('li', 'ui-mission-step' + (step.done ? ' is-done' : '') + (step === next ? ' is-next' : ''));
      li.append(h('span', 'ui-mission-mark', step.done ? '✓' : ''), h('span', 'ui-mission-label', text(step.ja, step.en)));
      if (step === next) {
        let action = null;
        if (step.id === 'open') {
          action = fn != null
            ? uiButton(text('開く', 'Open'), { cls: 'ui-secondary-action', onClick: () => router?.navigate?.('/function/' + fn.toString() + '/overview') })
            : uiButton(text('索引', 'Explorer'), { cls: 'ui-secondary-action', onClick: () => router?.navigate?.('/explorer/functions') });
        } else if (step.id === 'pseudo' && fn != null) {
          action = uiButton(text('読む', 'Read'), { cls: 'ui-secondary-action', onClick: () => router?.navigate?.('/function/' + fn.toString() + '/pseudocode') });
        } else if (step.id === 'name' && fn != null) {
          action = uiButton(text('名前を付ける', 'Rename'), { cls: 'ui-secondary-action', onClick: () => showRename(app, fn) });
        } else if (step.id === 'note' && fn != null) {
          action = uiButton(text('書く', 'Write'), { cls: 'ui-secondary-action', onClick: () => showComment(app, fn) });
        } else if (step.id === 'report') {
          action = uiButton(text('書き出す', 'Export'), { cls: 'ui-secondary-action', onClick: () => exportReportFromProduct(app, 'html') });
        }
        if (action) li.append(action);
      }
      list.append(li);
    }
    wrap.replaceChildren(heading, list);
  };
  render();
  const refresh = () => {
    if (!wrap.isConnected) { if (wrap.dataset.mounted) cleanup(); return; }
    wrap.dataset.mounted = '1';
    render();
  };
  const unsubNotes = app?.notes?.subscribe?.(refresh) || null;
  const doc = globalThis.document;
  const win = globalThis.window;
  const cleanup = () => {
    doc?.removeEventListener?.('hex:mission', refresh);
    win?.removeEventListener?.('hashchange', refresh);
    if (typeof unsubNotes === 'function') unsubNotes();
  };
  doc?.addEventListener?.('hex:mission', refresh);
  win?.addEventListener?.('hashchange', refresh);
  return wrap;
}

function collectTopClassesOrModules(app, limit = 5) {
  const out = [];
  const seen = new Set();
  const pushItem = (name, meta = '', onClick = null) => {
    const clean = String(name || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    if (isFoldable(classifyClassName(app, clean))) return;
    out.push({ name: clean, meta, onClick });
  };
  const mapClasses = app?.appMap?.classes || app?.appMap?.modules;
  if (Array.isArray(mapClasses)) {
    for (const item of mapClasses) {
      if (out.length >= limit) break;
      const name = typeof item === 'string' ? item : (item?.name || item?.className || item?.module);
      const count = typeof item === 'object' && item != null ? (item.methods?.length ?? item.functions?.length ?? item.count ?? null) : null;
      pushItem(name, count != null ? text(`${count}件`, `${count} items`) : '');
    }
  }
  if (out.length < limit) {
    try {
      const classes = classItems(app, '');
      for (const item of classes) {
        if (out.length >= limit) break;
        pushItem(item.name, item.meta || '');
      }
    } catch { /* ignore */ }
  }
  if (out.length < limit) {
    try {
      const sections = sectionItems(app, '');
      for (const sec of sections) {
        if (out.length >= limit) break;
        pushItem(sec.name, sec.size != null ? `${sec.size} B` : '');
      }
    } catch { /* ignore */ }
  }
  return out.slice(0, limit);
}

export function buildInitialLandingCard(app, router, { onDismiss = null } = {}) {
  const fileInfo = app?.store?.get?.('fileInfo') || {};
  const fileName = String(fileInfo.name || fileInfo.fileName || text('開いたバイナリ', 'Opened binary'));
  const fnCount = Number(app?.symbols?.functionCount ?? app?.symbols?.funcs?.length ?? 0);
  const subtitleParts = [
    fnCount > 0 ? text(`関数 ${fnCount.toLocaleString()} 件`, `${fnCount.toLocaleString()} functions`) : null,
    text('まずは気になる目的やクラス・関数から選んで解析を始められます。', 'Pick a goal, class, or frequently called function to get started.'),
  ].filter(Boolean);
  const c = card(text(`${fileName} — クイックスタート`, `${fileName} — Quick Start`), {
    subtitle: subtitleParts.join(' · '),
    className: 'ui-quickstart-card',
  });
  if (typeof onDismiss === 'function') {
    const dismissBtn = uiButton(text('閉じる', 'Dismiss'), {
      cls: 'ui-secondary-action ui-quickstart-dismiss',
      ariaLabel: text('クイックスタートを閉じる', 'Dismiss quick start'),
      onClick: onDismiss,
    });
    c.body.append(dismissBtn);
  }

  const goalsWrap = h('div', 'ui-quickstart-section ui-quickstart-goals');
  goalsWrap.append(h('h3', 'ui-quickstart-heading', text('目的から探す', 'Start by goal')));
  const goalBar = h('div', 'ui-goal-suggestions');
  for (const preset of [
    { label: text('HP・体力', 'HP / health'), query: text('HPを書き換える処理', 'where HP is written') },
    { label: text('攻撃力', 'Attack power'), query: text('攻撃力を決める・書き換える処理', 'where attack power is calculated or written') },
    { label: text('所持金・コイン', 'Money / coins'), query: text('所持金・コインを増減する処理', 'where money or coins are changed') },
    { label: text('通信・API', 'Network / API'), query: text('通信している場所', 'network') },
  ]) {
    goalBar.append(uiButton(preset.label, {
      cls: 'ui-suggestion ui-quickstart-goal-btn',
      onClick: () => runInvestigation(app, preset.query),
    }));
  }
  goalBar.append(uiButton(text('アプリ全体を解析', 'Full overview'), {
    cls: 'ui-primary-action ui-quickstart-overview-btn',
    onClick: () => {
      if (typeof app?.openOverview === 'function') app.openOverview();
      else router?.navigate?.('/investigate');
    },
  }));
  goalsWrap.append(goalBar);
  c.body.append(goalsWrap);
  c.body.append(buildMissionSection(app, router));

  const classes = collectTopClassesOrModules(app, 5);
  if (classes.length) {
    const classWrap = h('div', 'ui-quickstart-section ui-quickstart-classes');
    classWrap.append(h('h3', 'ui-quickstart-heading', text('主なクラス・モジュール', 'Top classes & modules')));
    const list = h('div', 'ui-list');
    for (const item of classes) {
      list.append(listRow({
        title: item.name,
        meta: item.meta,
        onClick: () => router?.navigate?.('/explorer/types?q=' + encodeURIComponent(item.name)),
      }));
    }
    classWrap.append(list);
    c.body.append(classWrap);
  }

  const hotFns = collectFrequentFunctions(app, 5);
  if (hotFns.length) {
    const fnWrap = h('div', 'ui-quickstart-section ui-quickstart-functions');
    fnWrap.append(h('h3', 'ui-quickstart-heading', text('よく呼ばれる関数', 'Frequently called functions')));
    const list = h('div', 'ui-list');
    for (const fn of hotFns) {
      list.append(listRow({
        title: fn.name,
        subtitle: addressText(fn.addr),
        meta: fn.callCount != null ? text(`${fn.callCount}回呼ばれる`, `${fn.callCount} calls`) : '',
        onClick: () => router?.navigate?.('/function/' + fn.addr.toString() + '/pseudocode'),
      }));
    }
    fnWrap.append(list);
    c.body.append(fnWrap);
  }

  return c.root;
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
  const isStickyOrFixedChrome = (node) => {
    for (let el = node; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const pos = getComputedStyle(el).position;
      if (pos === 'sticky') return true;
      if (pos === 'fixed') return !node.closest('.sheet-body, .ai-messages, .ai-composer, .ai-panel-foot');
    }
    return false;
  };
  let focusTimer = 0;
  const focus = (event) => {
    const target = event.target;
    if (!target || !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (isStickyOrFixedChrome(target)) return;
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      focusTimer = 0;
      if (document.activeElement !== target) return;
      const rect = target.getBoundingClientRect();
      const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      if (rect.top >= 0 && rect.bottom <= vh) return;
      target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }, 120);
  };
  document.addEventListener('focusin', focus);
  return () => {
    if (focusTimer) { clearTimeout(focusTimer); focusTimer = 0; }
    window.removeEventListener('resize', sync);
    window.removeEventListener('orientationchange', sync);
    viewport?.removeEventListener('resize', sync);
    viewport?.removeEventListener('scroll', sync);
    document.removeEventListener('focusin', focus);
  };
}

function recentQueriesKey(app) {
  const file = app?.store?.get?.('fileInfo');
  const id = file?.name || file?.path || 'global';
  return `hex.ui.recentQueries:${String(id).slice(0, 80)}`;
}

function recentQueries(app) {
  try { return JSON.parse(sessionStorage.getItem(recentQueriesKey(app)) || '[]'); } catch { return []; }
}

function rememberQuery(query, app) {
  const q = String(query || '').trim();
  if (!q) return;
  const next = [q, ...recentQueries(app).filter((x) => x !== q)].slice(0, 6);
  try { sessionStorage.setItem(recentQueriesKey(app), JSON.stringify(next)); } catch { /* private mode */ }
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

function renderInvestigate(app, router, route = null) {
  const s = screen(text('何を知りたい？', 'What do you want to know?'), {
    id: 'investigate',
    subtitle: text('探したい処理や値を入力すると、候補関数を自動で絞り込みます。',
      'Enter what you want to find to rank candidate routines automatically.'),
  });
  const hero = card(null, { className: 'ui-investigate-hero' });
  const form = h('form', 'ui-goal-form');
  const input = h('input', 'ui-command-input');
  input.type = 'search';
  input.placeholder = text('例: 戦闘終了時に経験値が増える場所', 'e.g. where experience increases after a battle');
  input.autocomplete = 'off'; input.autocapitalize = 'off'; input.spellcheck = false;
  const submit = uiButton(text('調べる', 'Investigate'), { cls: 'ui-primary-action' });
  submit.type = 'submit';
  form.append(input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    rememberQuery(q, app);
    runInvestigation(app, q);
  });
  hero.body.append(form);
  const suggestions = h('div', 'ui-goal-suggestions');
  for (const q of [
    text('経験値が増える場所', 'where experience increases'),
    text('通信している場所', 'network'),
    text('ガチャの結果を決める処理', 'where gacha results are decided'),
  ]) suggestions.append(uiButton(q, { cls: 'ui-suggestion', onClick: () => { input.value = q; rememberQuery(q, app); runInvestigation(app, q); } }));
  const commonGoals = h('div', 'ui-goal-suggestions ui-purpose-presets');
for (const preset of [
  { label:text('HP・体力', 'HP / health'), query:text('HPを書き換える処理', 'where HP is written') },
  { label:text('攻撃力', 'Attack power'), query:text('攻撃力を決める・書き換える処理', 'where attack power is calculated or written') },
  { label:text('ダメージ計算', 'Damage calculation'), query:text('ダメージを計算して適用する処理', 'where damage is calculated and applied') },
  { label:text('所持金・コイン', 'Money / coins'), query:text('所持金・コインを増減する処理', 'where money or coins are changed') },
  { label:text('アイテム・所持品', 'Items / inventory'), query:text('アイテム・所持品を増減する処理', 'where inventory items are changed') },
  { label:text('広告・課金', 'Ads / IAP'), query:text('広告表示や課金・購入を判定する処理', 'where ads or in-app purchases are checked') },
  { label:text('無敵・クールダウン', 'Invincible / Cooldown'), query:text('無敵やクールダウン・移動速度を決める処理', 'where invincibility, cooldown, or speed is controlled') },
]) {
  commonGoals.append(uiButton(preset.label, {
    cls:'ui-suggestion ui-purpose-chip',
    onClick:() => { input.value = preset.query; rememberQuery(preset.query, app); runInvestigation(app, preset.query); },
  }));
}
hero.body.append(suggestions, sectionTitle(text('よくある目的', 'Common goals')), commonGoals);
let disposed = false;
if (!app.store?.get?.('fileInfo')) {
  s.body.append(emptyState(
    text('ファイルが開かれていません', 'No binary open'),
    text('まずは解析したいバイナリを開くか、サンプルで操作を試してみてください。', 'Open a binary to investigate, or try the built-in sample first.'),
    noFileActions(app),
  ));
  if (typeof app.listRecentDeltaBinaries === 'function') {
    const recentDeltaHost = h('div', 'ui-recent-delta-host');
    s.body.append(recentDeltaHost);
    const lastFilePromise = typeof app.analysisResume?.loadLastFile === 'function'
      ? Promise.resolve(app.analysisResume.loadLastFile()).catch(() => null)
      : Promise.resolve(null);
    Promise.all([
      Promise.resolve(app.listRecentDeltaBinaries({ onlyWithDelta: true, limit: 8 })),
      lastFilePromise,
    ]).then(([entries, saved]) => {
      if (disposed || !Array.isArray(entries) || !entries.length) return;
      const recentCard = card(text('最近のバイナリ（差分あり）', 'Recent binaries (with saved delta)'), {
        className: 'ui-recent-delta-card',
        subtitle: text('同じバイナリを開くと保存した差分を自動で復元します。', 'Open the matching binary to restore your saved changes automatically.'),
      });
      const list = h('div', 'ui-list');
      const savedFile = saved?.file || null;
      const savedName = savedFile?.name || saved?.name || '';
      const savedHash = String(saved?.sha256 || saved?.meta?.sha256 || saved?.binaryId || saved?.meta?.binaryId || '');
      for (const entry of entries.slice(0, 8)) {
        const name = String(entry?.name || entry?.filename || entry?.fileName || text('バイナリ', 'Binary'));
        const rawHash = String(entry?.sha256 || entry?.fingerprint || entry?.deltaKey || entry?.id || '');
        const fp = rawHash.slice(0, 12);
        const count = deltaCountOf(entry);
        const ts = formatRecentTime(entry?.lastOpenedAt ?? entry?.lastOpened ?? entry?.updatedAt ?? entry?.timestamp);
        const subParts = [
          fp ? fp : null,
          text(`${count}件の差分`, `${count} changes`),
          ts || null,
        ].filter(Boolean);
        const matchesSaved = Boolean(savedFile && (
          (savedHash && rawHash
            ? (savedHash === rawHash || rawHash.includes(savedHash) || savedHash.includes(rawHash))
            : (savedName && savedName === name))
        ));
        const instantBadge = matchesSaved
          ? h('span', 'ui-badge ui-badge-confirmed', text('すぐ再開', 'Instant resume'))
          : null;
        list.append(listRow({
          title: name,
          subtitle: subParts.join(' · '),
          meta: matchesSaved ? '' : text('ローカルファイルを再選択', 'Re-select local file'),
          badge: instantBadge,
          onClick: () => {
            if (matchesSaved && typeof app.openFile === 'function') {
              void app.openFile(savedFile, { restored: true });
              return;
            }
            toast(text(`「${name}」を選択すると前回の差分を自動で復元します。`, `Select "${name}" to restore its saved delta automatically.`));
            const registry = window.__hexUi?.actions;
            if (registry?.has?.('file.open') && typeof registry.run === 'function') registry.run('file.open');
            else document.getElementById('file-input')?.click();
          },
        }));
      }
      recentCard.body.append(list);
      recentDeltaHost.replaceChildren(recentCard.root);
    }).catch(() => {});
  }
}
s.body.append(hero.root);
if (app.store?.get?.('fileInfo')) {
  const missionCard = card(null, { className: 'ui-mission-card' });
  missionCard.body.append(buildMissionSection(app, router));
  s.body.append(missionCard.root);
}

  const overview = card(text('自動で分かったこと', 'Automatic overview'), {
    subtitle: text('ファイル全体の地図を作り、候補・根拠・未確認点をまとめます。',
      'Build a map of the binary and summarize candidates, evidence and unknowns.'),
  });
  overview.body.append(uiButton(text('概要を更新する', 'Refresh overview'), {
    cls: 'ui-secondary-action', onClick: () => requireFile(app, () => app.openOverview()),
  }));
  s.body.append(overview.root);

  const initialQuery = route?.query?.get?.('q') || '';
  if (initialQuery) {
    input.value = initialQuery;
    if (app.store?.get?.('fileInfo')) {
      rememberQuery(initialQuery, app);
      queueMicrotask(() => { if (!disposed) runInvestigation(app, initialQuery); });
    }
  }
  const recent = recentQueries(app);
  if (recent.length) {
    s.body.append(sectionTitle(text('最近の調査', 'Recent investigations')));
    const list = h('div', 'ui-list');
    for (const q of recent) list.append(listRow({ title: q, onClick: () => { input.value = q; runInvestigation(app, q); } }));
    s.body.append(list);
  }
  return { root: s.root, focus: () => input.focus(), dispose: () => { disposed = true; } };
}

function lowerBoundBigInt(array, value) {
  let lo = 0, hi = array.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (array[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const VALID_EXPLORER_FILTERS = new Set(['all', 'saved', 'edited']);
const VALID_EXPLORER_SORTS = new Set(['address', 'name', 'size', 'priority']);

function resolveFunctionStart(app, rawAddr) {
  if (rawAddr == null || rawAddr === '') return null;
  let big;
  try { big = BigInt(rawAddr); } catch { return null; }
  try {
    const fn = app?.symbols?.functionAt?.(big);
    if (fn?.start != null) return BigInt(fn.start);
    const start = app?.symbols?.functionStartAt?.(big);
    if (start != null) return BigInt(start);
  } catch { /* fall back to raw address */ }
  return big;
}

export function collectEditedFunctions(app) {
  const map = new Map();
  const touch = (rawAddr, reason, commentText = null, preferComment = false) => {
    const start = resolveFunctionStart(app, rawAddr);
    if (start == null) return;
    const key = start.toString();
    let entry = map.get(key);
    if (!entry) {
      entry = { addr: start, reasons: new Set(), comment: null };
      map.set(key, entry);
    }
    entry.reasons.add(reason);
    if (commentText) {
      if (!entry.comment || preferComment) entry.comment = String(commentText).trim();
    }
  };
  const notes = app?.notes;
  if (notes) {
    if (notes.names instanceof Map) {
      for (const [k, v] of notes.names) {
        if (v) touch(k, 'rename');
      }
    } else if (typeof notes.nameEntries === 'function') {
      for (const item of notes.nameEntries() || []) {
        if (item?.name) touch(item.addr, 'rename');
      }
    }
    if (notes.comments instanceof Map) {
      for (const [k, v] of notes.comments) {
        if (!v) continue;
        const start = resolveFunctionStart(app, k);
        let isStart = false;
        try { isStart = start != null && BigInt(k) === start; } catch { isStart = false; }
        touch(k, 'comment', v, isStart);
      }
    }
    if (notes.vars instanceof Map) {
      for (const [k, v] of notes.vars) {
        if (!v) continue;
        const sep = String(k).indexOf(':');
        if (sep > 0) touch(String(k).slice(0, sep), 'var');
      }
    }
    if (notes.types instanceof Map) {
      for (const [k, v] of notes.types) {
        if (!v) continue;
        const sep = String(k).indexOf(':');
        if (sep > 0) touch(String(k).slice(0, sep), 'type');
      }
    }
  }
  const patchList = typeof app?.patches?.list === 'function' ? app.patches.list() : [];
  if (Array.isArray(patchList)) {
    for (const patch of patchList) {
      if (patch?.addr != null) touch(patch.addr, 'patch');
    }
  }
  return map;
}

function sortFunctionItems(items, sortMode, app, editedMap = null) {
  if (!Array.isArray(items) || items.length <= 1) return items;
  const mode = VALID_EXPLORER_SORTS.has(sortMode) ? sortMode : 'address';
  const compareAddr = (a, b) => {
    try {
      const aa = BigInt(a.addr);
      const bb = BigInt(b.addr);
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    } catch { return 0; }
  };
  if (mode === 'address') {
    items.sort(compareAddr);
    return items;
  }
  if (mode === 'name') {
    items.sort((a, b) => {
      const an = String(a.name || '').toLowerCase();
      const bn = String(b.name || '').toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return compareAddr(a, b);
    });
    return items;
  }
  if (mode === 'size') {
    items.sort((a, b) => {
      const as = a.size != null && Number.isFinite(Number(a.size)) ? Number(a.size) : -1;
      const bs = b.size != null && Number.isFinite(Number(b.size)) ? Number(b.size) : -1;
      if (bs !== as) return bs - as;
      return compareAddr(a, b);
    });
    return items;
  }
  if (mode === 'priority') {
    const edited = editedMap || collectEditedFunctions(app);
    const scoreOf = (item) => {
      let score = Number.isFinite(Number(item?.priority ?? item?.score)) ? Number(item.priority ?? item.score) : 0;
      try {
        const big = BigInt(item.addr);
        if (app?.bookmarks?.has?.(big)) score += 1000;
        if (edited.has(big.toString())) score += 500;
      } catch { /* ignore */ }
      if (item.size != null && Number.isFinite(Number(item.size))) score += Math.min(200, Math.log2(1 + Math.max(0, Number(item.size))) * 10);
      return score;
    };
    items.sort((a, b) => {
      const diff = scoreOf(b) - scoreOf(a);
      return diff !== 0 ? diff : compareAddr(a, b);
    });
  }
  return items;
}

async function matchingFunctionItems(app, query, options = {}) {
  const q = String(query || '').trim();
  const sortMode = VALID_EXPLORER_SORTS.has(options?.sort) ? options.sort : 'address';
  const offset = Number.isSafeInteger(options?.offset) && options.offset >= 0 ? options.offset : 0;
  const limit = Number.isSafeInteger(options?.limit) && options.limit > 0 ? options.limit : 200;
  if (typeof explorerIndex.queryFunctionsFast === 'function') {
    try {
      let prioritySet = options?.prioritySet || null;
      let savedSet = options?.savedSet || null;
      let editedSet = options?.editedSet || null;
      if (sortMode === 'priority') {
        if (!savedSet) {
          savedSet = new Set();
          for (const bm of bookmarkListOf(app)) {
            if (bm?.addr != null) {
              try { savedSet.add(BigInt(bm.addr).toString()); } catch { /* ignore */ }
            }
          }
        }
        if (!editedSet) {
          editedSet = new Set(collectEditedFunctions(app).keys());
        }
        if (!prioritySet) {
          prioritySet = new Set([...savedSet, ...editedSet]);
        }
      }
      const fast = await explorerIndex.queryFunctionsFast(app, q, {
        ...options,
        offset,
        limit,
        sort: sortMode,
        prioritySet,
        savedSet,
        editedSet,
      });
      if (Array.isArray(fast)) return fast;
      if (fast && Array.isArray(fast.items)) {
        const rows = fast.items;
        const total = Number.isSafeInteger(fast.total) && fast.total >= 0 ? fast.total : rows.length;
        const next = offset + rows.length < total ? offset + rows.length : null;
        Object.defineProperty(rows, 'queryPage', {
          value: { offset, limit, returned: rows.length, total, next },
          enumerable: false,
          configurable: true,
        });
        Object.defineProperty(rows, 'completeness', {
          value: fast.complete === false ? 'partial' : 'complete',
          enumerable: false,
          configurable: true,
        });
        const fastReason = fast.reason || fast.truncationReason || fast.status?.reason || (fast.complete === false ? 'function-discovery-incomplete' : null);
        if (fastReason) {
          Object.defineProperty(rows, 'truncationReason', {
            value: fastReason,
            enumerable: false,
            configurable: true,
          });
        }
        return rows;
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
    }
  }
  const items = await explorerIndex.queryFunctions(app, q, options);
  if (Array.isArray(items) && sortMode !== 'address') {
    sortFunctionItems(items, sortMode, app);
  }
  return items;
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
  return explorerIndex.queryStrings(rows || [], query, options);
}
let cachedClassesRef = null;
let cachedClassEntities = null;

function getClassEntities(app) {
  const classes = app.fields?.classes || app.objcModel?.classes || null;
  const swiftTypes = app.swiftModel?.types || app.swiftRuntime?.types || null;
  const il2cppTypes = app.il2cppModel?.types || app.il2cpp?.types || null;
  const symbols = app.symbols || null;
  const symbolsGen = symbols?.gen ?? null;
  const isJapanese = ja();

  if (
    cachedClassesRef
    && cachedClassesRef.classes === classes
    && cachedClassesRef.swift === swiftTypes
    && cachedClassesRef.il2cpp === il2cppTypes
    && cachedClassesRef.symbols === symbols
    && cachedClassesRef.symbolsGen === symbolsGen
    && cachedClassesRef.isJapanese === isJapanese
    && cachedClassEntities
  ) {
    return cachedClassEntities;
  }

  const cxxClasses = symbols ? findCxxClasses(symbols) : null;

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

  cachedClassesRef = { classes, swift: swiftTypes, il2cpp: il2cppTypes, symbols, symbolsGen, isJapanese };
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

let cachedDataRef = null;
let cachedDataEntities = null;

function getDataEntities(app) {
  const regions = app.store?.get?.('regions') || [];
  const symbols = app.symbols || null;
  const symbolsGen = symbols?.gen ?? null;
  const program = app.program || null;
  const structs = app.structs || app.types?.structs || [];
  const schemas = app.schemas || app.store?.get?.('schemas') || [];
  const isJapanese = ja();

  if (
    cachedDataRef
    && cachedDataRef.regions === regions
    && cachedDataRef.symbols === symbols
    && cachedDataRef.symbolsGen === symbolsGen
    && cachedDataRef.program === program
    && cachedDataRef.structs === structs
    && cachedDataRef.schemas === schemas
    && cachedDataRef.isJapanese === isJapanese
    && cachedDataEntities
  ) {
    return cachedDataEntities;
  }

  const items = [];
  const seen = new Set();
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

  cachedDataRef = { regions, symbols, symbolsGen, program, structs, schemas, isJapanese };
  cachedDataEntities = items;
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
  const symbolsGen = symbols?.gen ?? null;
  const program = app.program || null;
  const isJapanese = ja();
  if (
    cachedExternalDescriptor
    && cachedExternalDescriptor.fileInfo === fileInfo
    && cachedExternalDescriptor.slice === slice
    && cachedExternalDescriptor.symbols === symbols
    && cachedExternalDescriptor.symbolsGen === symbolsGen
    && cachedExternalDescriptor.program === program
    && cachedExternalDescriptor.isJapanese === isJapanese
    && cachedExternalItems
  ) {
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
  cachedExternalDescriptor = { fileInfo, slice, symbols, symbolsGen, program, isJapanese };
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
    subtitle: text('関数・文字列・型・データ・外部API・セクションを、ここでまとめて探せます。',
      'Browse functions, strings, types, data, external APIs and sections with one search.'),
  });
  const controls = h('div', 'ui-explorer-controls');
  const scopes = tabs(EXPLORER_SCOPES, scope, (id) => router.navigate('/explorer/' + id + (search.value.trim() ? '?q=' + encodeURIComponent(search.value.trim()) : '')), { panelId: 'ui-explorer-panel', label: text('索引の種類', 'Explorer categories') });
  scopes.classList.add('ui-scope-tabs');
  scopes.setAttribute('aria-label', text('索引の種類', 'Explorer categories'));
  for (const button of scopes.querySelectorAll('button')) button.classList.add('ui-scope');
  const search = h('input', 'ui-search-field');
  search.type = 'search'; search.placeholder = text('名前・文字列・アドレスで検索', 'Search names, strings or addresses');
  search.setAttribute('aria-label', text('索引を検索', 'Search explorer'));
  const restored = routeContext.restoredState;
  search.value = restored?.query ?? route.query.get('q') ?? '';
  const pageSize = 200;
  let queryOffset = Number.isSafeInteger(restored?.offset) && restored.offset >= 0 ? restored.offset : 0;
  let pendingVirtualState = restored?.virtual ?? null;
  const resumedFilter = app.uiResume?.explorerFilter;
  const initialFilter = restored?.filterMode
    ?? (restored?.savedOnly ? 'saved' : null)
    ?? (VALID_EXPLORER_FILTERS.has(resumedFilter) ? resumedFilter : 'all');
  let filterMode = scope === 'functions' && VALID_EXPLORER_FILTERS.has(initialFilter) ? initialFilter : 'all';
  const resumedSort = app.uiResume?.explorerSort;
  const initialSort = restored?.sortMode ?? (VALID_EXPLORER_SORTS.has(resumedSort) ? resumedSort : 'address');
  let sortMode = VALID_EXPLORER_SORTS.has(initialSort) ? initialSort : 'address';
  let allChip = null;
  let savedChip = null;
  let editedChip = null;
  let libraryChip = null;
  let hideLibrary = app.uiResume?.explorerHideLibrary !== false;
  let sortSelect = null;
  const searchRow = h('div', 'ui-explorer-search-row');
  searchRow.append(search);
  const syncFilterChips = () => {
    if (allChip) {
      allChip.textContent = text('すべて', 'All');
      allChip.setAttribute('aria-pressed', String(filterMode === 'all'));
    }
    if (savedChip) {
      const count = bookmarkListOf(app).length;
      savedChip.textContent = text(`保存済み (★ ${count})`, `Saved (★ ${count})`);
      savedChip.setAttribute('aria-pressed', String(filterMode === 'saved'));
    }
    if (editedChip) {
      const count = collectEditedFunctions(app).size;
      editedChip.textContent = text(`編集済み (✎ ${count})`, `Edited (✎ ${count})`);
      editedChip.setAttribute('aria-pressed', String(filterMode === 'edited'));
    }
    if (libraryChip) {
      libraryChip.textContent = text('ライブラリを隠す', 'Hide libraries');
      libraryChip.setAttribute('aria-pressed', String(hideLibrary));
    }
  };
  const setHideLibrary = (next) => {
    hideLibrary = Boolean(next);
    queryOffset = 0;
    pendingVirtualState = null;
    app.setUiResume?.({ explorerHideLibrary: hideLibrary });
    syncFilterChips();
    void update();
  };
  const setFilterMode = (next) => {
    if (!VALID_EXPLORER_FILTERS.has(next) || filterMode === next) return;
    filterMode = next;
    queryOffset = 0;
    pendingVirtualState = null;
    app.setUiResume?.({ explorerFilter: filterMode });
    syncFilterChips();
    void update();
  };
  controls.append(scopes, searchRow);
  if (scope === 'functions') {
    const filterBar = h('div', 'ui-explorer-filter-bar');
    allChip = uiButton('', {
      cls: 'ui-secondary-action ui-explorer-filter-chip',
      pressed: filterMode === 'all',
      onClick: () => setFilterMode('all'),
    });
    savedChip = uiButton('', {
      cls: 'ui-secondary-action ui-explorer-filter-chip ui-saved-filter-chip',
      pressed: filterMode === 'saved',
      onClick: () => setFilterMode(filterMode === 'saved' ? 'all' : 'saved'),
    });
    editedChip = uiButton('', {
      cls: 'ui-secondary-action ui-explorer-filter-chip ui-edited-filter-chip',
      pressed: filterMode === 'edited',
      onClick: () => setFilterMode(filterMode === 'edited' ? 'all' : 'edited'),
    });
    libraryChip = uiButton('', {
      cls: 'ui-secondary-action ui-explorer-filter-chip ui-library-filter-chip',
      pressed: hideLibrary,
      onClick: () => setHideLibrary(!hideLibrary),
    });
    sortSelect = h('select', 'ui-explorer-sort');
    sortSelect.setAttribute('aria-label', text('並び順', 'Sort functions'));
    for (const [val, lbl] of [
      ['address', text('アドレス順', 'Address')],
      ['name', text('名前順', 'Name')],
      ['size', text('サイズ順', 'Size')],
      ['priority', text('優先度順', 'Priority')],
    ]) {
      const opt = h('option', null, lbl);
      opt.value = val;
      if (val === sortMode) opt.selected = true;
      sortSelect.append(opt);
    }
    sortSelect.addEventListener('change', () => {
      const next = sortSelect.value;
      if (!VALID_EXPLORER_SORTS.has(next)) return;
      sortMode = next;
      queryOffset = 0;
      pendingVirtualState = null;
      app.setUiResume?.({ explorerSort: sortMode });
      void update();
    });
    syncFilterChips();
    filterBar.append(allChip, savedChip, editedChip, libraryChip, sortSelect);
    controls.append(filterBar);
  }
  s.body.append(controls);
  const content = tabPanel(scopes, 'ui-explorer-content');
  s.body.append(content);
  let disposed = false;
  let virtual = null;
  let timer = 0;
  let querySerial = 0;
  const fallbackRouteController = routeContext.signal ? null : new AbortController();
  const routeSignal = routeContext.signal || fallbackRouteController.signal;
  const queryScope = createChildTaskScope(routeSignal);

  const showRows = (items, renderRow, emptyText, emptyAction = null) => {
    virtual?.dispose(); virtual = null;
    content.replaceChildren();
    const page = items?.queryPage;
    if (page) {
      const status = h('p', 'ui-hint');
      status.setAttribute('role', 'status');
      const start = items.length ? page.offset + 1 : 0;
      const end = page.offset + items.length;
      const total = Number.isSafeInteger(page.total) && page.total >= 0 ? page.total : null;
      const continuation = Number.isSafeInteger(page.next) && page.next > page.offset;
      status.textContent = !items.length ? text('0 件', '0 results') : total != null
        ? text(`${start.toLocaleString()}–${end.toLocaleString()} / ${total.toLocaleString()} 件`, `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} results`)
        : text(`${start.toLocaleString()}–${end.toLocaleString()} 件${continuation ? '（続きがあります）' : ''}`, `${start.toLocaleString()}–${end.toLocaleString()} results${continuation ? ' (more available)' : ''}`);
      content.append(status);
      if (continuation || page.offset > 0) {
        const pager = h('form', 'ui-explorer-pagination');
        pager.setAttribute('aria-label', text('索引のページ移動', 'Explorer pagination'));
        const go = (offset) => { queryOffset = offset; pendingVirtualState = null; void update(); };
        const previous = uiButton(text('前のページ', 'Previous page'), { cls:'ui-secondary-action', onClick:() => go(Math.max(0, page.offset - pageSize)) });
        previous.disabled = page.offset === 0;
        const next = uiButton(text('次のページ', 'Next page'), { cls:'ui-secondary-action', onClick:() => go(page.next) });
        next.disabled = !continuation;
        const number = h('input', 'ui-explorer-page');
        number.type = 'number'; number.min = '1'; number.step = '1';
        number.setAttribute('aria-label', text('ページ番号', 'Page number'));
        number.value = String(Math.floor(page.offset / pageSize) + 1);
        if (total != null) number.max = String(Math.max(1, Math.ceil(total / pageSize)));
        const jump = uiButton(text('移動', 'Go'), { cls:'ui-secondary-action' });
        jump.type = 'submit';
        pager.append(previous, next, number, jump);
        pager.addEventListener('submit', (event) => {
          event.preventDefault();
          if (!number.reportValidity()) return;
          const offset = (Number(number.value) - 1) * pageSize;
          if (Number.isSafeInteger(offset) && offset >= 0) go(offset);
        });
        content.append(pager);
      }
    }
    const partialReason = items?.truncationReason || items?.status?.reason || null;
    if ((items?.completeness && items.completeness !== 'complete') || items?.complete === false) {
      const codes = partialReason ? [partialReason] : ['function-discovery-incomplete'];
      const canContinue = codes.some((c) => String(c).includes('function-discovery-incomplete'))
        && (typeof app.discoverMoreFunctions === 'function' || typeof app.resumeDiscovery === 'function' || scope === 'functions');
      content.append(statusNotice(codes, {
        actionLabel: text('続きを調べる', 'Continue scanning'),
        onAction: canContinue ? () => {
          if (typeof app.discoverMoreFunctions === 'function') Promise.resolve(app.discoverMoreFunctions()).finally(() => void update());
          else if (typeof app.resumeDiscovery === 'function') Promise.resolve(app.resumeDiscovery()).finally(() => void update());
          else void update();
        } : null,
      }));
    }
    if (!items || !Number(items.length)) {
      const q = String(search.value || '').trim();
      const fallbackAction = (!emptyAction && q)
        ? uiButton(text(`「${q}」を自動解析で探す`, `Auto-investigate "${q}"`), {
            cls: 'ui-primary-action',
            onClick: () => runInvestigation(app, q),
          })
        : emptyAction;
      content.append(emptyState(text('見つかりません', 'Nothing found'), emptyText, fallbackAction));
      return;
    }
    virtual = new VirtualList({ items, rowHeight: 64, ariaLabel: text('索引の結果', 'Explorer results'), renderRow });
    content.append(virtual.root);
    if (pendingVirtualState) { virtual.restoreState(pendingVirtualState); pendingVirtualState = null; }
  };

  const update = async () => {
    if (disposed) return;
    if (!app.store?.get?.('fileInfo')) {
      virtual?.dispose(); virtual = null;
      content.replaceChildren(emptyState(
        text('ファイルが開かれていません', 'No binary open'),
        text('バイナリを開くと、関数・文字列・型・データ・外部API・セクションをまとめて探せます。', 'Open a binary or try the sample to browse functions, strings, types, data, external APIs, and sections.'),
        noFileActions(app),
      ));
      return;
    }
    const signal = queryScope.spawn('explorer-query-replaced');
    const serial = ++querySerial;
    const current = () => !disposed && !routeSignal.aborted && !signal.aborted && serial === querySerial;
    const q = search.value.trim();
    const parsed = parseAddressInput(app, q, { allowBareSymbol: false });
    if (parsed != null && q) {
      showRows([{ addr: parsed }], (item) => listRow({ title: addressText(item.addr), subtitle: text('このアドレスへ移動', 'Jump to this address'), onClick: () => router.navigate('/code/' + item.addr.toString()) }), '');
      return;
    }
    if (scope === 'functions') {
      const editedMap = collectEditedFunctions(app);
      const bookmarkMap = new Map();
      for (const bm of bookmarkListOf(app)) {
        if (bm?.addr == null) continue;
        try { bookmarkMap.set(BigInt(bm.addr).toString(), bm); } catch { /* ignore */ }
      }
      const previewClip = (val, max = 48) => {
        const sVal = String(val || '').replace(/\s+/g, ' ').trim();
        if (!sVal) return '';
        return sVal.length > max ? sVal.slice(0, max - 1) + '…' : sVal;
      };
      const makeEditedBadge = (keyStr) => {
        if (!editedMap.has(keyStr)) return null;
        const badge = h('span', 'ui-edited-badge', '✎');
        badge.title = text('編集済み', 'Edited');
        badge.setAttribute('aria-label', text('編集済み', 'Edited'));
        return badge;
      };
      const buildFnSubtitle = (addrBig, bm = null) => {
        const keyStr = addrBig.toString();
        const bmEntry = bm || bookmarkMap.get(keyStr);
        const bmNote = previewClip(bmEntry?.note);
        const editEntry = editedMap.get(keyStr);
        const cmt = previewClip(editEntry?.comment || app.notes?.comment?.(addrBig));
        const preview = bmNote ? ('★ ' + bmNote) : (cmt ? ('✎ ' + cmt) : '');
        return [addressText(addrBig), preview].filter(Boolean).join(' · ');
      };
      const fnSizeOf = (addrBig) => {
        try {
          const fn = app.symbols?.functionAt?.(addrBig);
          if (fn?.end != null && fn?.start != null && fn.end > fn.start) return Number(fn.end - fn.start);
        } catch { /* ignore */ }
        return null;
      };

      const makeFnRowAction = (rowAddr, rowName, onToggled) => {
        const isSaved = !!app.bookmarks?.has?.(rowAddr);
        const star = makeStarButton(app, rowAddr, rowName, {
          cls: 'ui-icon-action ui-star-btn ui-row-star',
          stopPropagation: true,
          onToggled,
        });
        if (!isSaved) return star;
        const wrap = h('span', 'ui-row-actions');
        const noteBtn = uiButton(text('メモ', 'Edit note'), {
          cls: 'ui-secondary-action ui-row-note-btn',
          ariaLabel: text('ブックマークメモを編集', 'Edit bookmark note'),
          onClick: (event) => {
            event.stopPropagation();
            editBookmarkNote(app, rowAddr, rowName);
          },
        });
        noteBtn.title = text('ブックマークメモを編集', 'Edit bookmark note');
        wrap.append(noteBtn, star);
        return wrap;
      };

      if (filterMode === 'saved') {
        const ql = q.toLowerCase();
        const saved = bookmarkListOf(app).filter((bm) => {
          if (bm?.addr == null) return false;
          const bAddr = BigInt(bm.addr);
          const liveName = isFunctionStart(app, bAddr)
            ? (app.symbols?.nameAt?.(bAddr) || bm.name || functionName(app, bAddr))
            : (bm.name || bookmarkLabel(app, bAddr));
          if (!ql) return true;
          const tags = Array.isArray(bm?.tags) ? bm.tags.join(' ') : String(bm?.tag || '');
          const hay = [liveName, bm?.name, bm?.note, tags, addressText(bAddr)].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(ql);
        }).map((bm) => {
          const bAddr = BigInt(bm.addr);
          const liveName = isFunctionStart(app, bAddr)
            ? (app.symbols?.nameAt?.(bAddr) || bm.name || functionName(app, bAddr))
            : (bm.name || bookmarkLabel(app, bAddr));
          return { ...bm, addr: bAddr, name: liveName, size: fnSizeOf(bAddr) };
        });
        sortFunctionItems(saved, sortMode, app, editedMap);
        showRows(saved, (bm) => {
          const bAddr = BigInt(bm.addr);
          const bName = bm.name || bookmarkLabel(app, bAddr);
          const action = makeFnRowAction(bAddr, bName, () => { syncFilterChips(); if (filterMode === 'saved') void update(); });
          const tags = Array.isArray(bm?.tags) ? bm.tags.join(', ') : String(bm?.tag || '');
          return listRow({
            title: bName,
            subtitle: buildFnSubtitle(bAddr, bm),
            meta: tags || (bm.size != null ? String(bm.size) + ' B' : ''),
            badge: makeEditedBadge(bAddr.toString()),
            action,
            onClick: () => openAddressTarget(app, router, bAddr),
          });
        }, text('保存済みの関数はありません。関数の ☆ を押すとここに追加されます。', 'No saved functions yet. Tap ☆ on any function to bookmark it.'));
        return;
      }

      if (filterMode === 'edited') {
        const ql = q.toLowerCase();
        const editedRows = [];
        for (const entry of editedMap.values()) {
          const eAddr = entry.addr;
          const eName = functionName(app, eAddr);
          const bmEntry = bookmarkMap.get(eAddr.toString());
          if (ql) {
            const hay = [eName, addressText(eAddr), entry.comment, bmEntry?.note].filter(Boolean).join(' ').toLowerCase();
            if (!hay.includes(ql)) continue;
          }
          editedRows.push({ addr: eAddr, name: eName, size: fnSizeOf(eAddr) });
        }
        sortFunctionItems(editedRows, sortMode, app, editedMap);
        showRows(editedRows, (item) => {
          const itemAddr = BigInt(item.addr);
          const action = makeFnRowAction(itemAddr, item.name, () => syncFilterChips());
          return listRow({
            title: item.name,
            subtitle: buildFnSubtitle(itemAddr),
            meta: item.size != null ? String(item.size) + ' B' : '',
            badge: makeEditedBadge(itemAddr.toString()),
            action,
            onClick: () => openAddressTarget(app, router, itemAddr),
          });
        }, text('編集済みの関数はありません。名前の変更・メモ・型設定・パッチを行うとここに表示されます。', 'No edited functions yet. Rename, comment, type, or patch a function to see it here.'));
        return;
      }

      content.replaceChildren(loadingState(text('索引を検索しています…', 'Searching index…')));
      try {
        let library = null;
        try { library = await libraryIndexFor(app, { signal }); } catch (err) { if (err?.name === 'AbortError') throw err; library = null; }
        if (!current()) return;
        const excludeSet = hideLibrary && library?.folded?.size ? library.folded : null;
        const items = await matchingFunctionItems(app, q, { signal, offset: queryOffset, limit: pageSize, sort: sortMode, excludeSet });
        if (!current()) return;
        let hiddenCount = 0;
        if (excludeSet && typeof explorerIndex.queryFunctionsFast === 'function' && app.symbols?.funcs) {
          try {
            const shownTotal = Number(items?.queryPage?.total);
            const all = await explorerIndex.queryFunctionsFast(app, q, { signal, offset: 0, limit: 0, sort: 'address' });
            if (Number.isSafeInteger(shownTotal) && Number.isSafeInteger(all?.total)) hiddenCount = Math.max(0, all.total - shownTotal);
          } catch (err) { if (err?.name === 'AbortError') throw err; }
          if (!current()) return;
        }
        const libraryLabel = (addrBig) => {
          const info = library?.byAddr?.get(addrBig.toString());
          if (!isFoldable(info)) return '';
          return `${text('ライブラリ', 'Library')}: ${info.vendor}`;
        };
        if (!items?.length && app.store?.get?.('symbolsReady') === false && Boolean(app.analysisBaseSymbolsReady)) {
          virtual?.dispose(); virtual = null;
          content.replaceChildren(loadingState(text('関数一覧をバックグラウンドで復元しています…', 'Recovering functions in the background…')));
          return;
        }
        showRows(items, (item) => {
          const itemAddr = BigInt(item.addr);
          const action = makeFnRowAction(itemAddr, item.name, () => syncFilterChips());
          return listRow({
            title: item.name,
            subtitle: [buildFnSubtitle(itemAddr), libraryLabel(itemAddr)].filter(Boolean).join(' · '),
            meta: item.size != null ? String(item.size) + ' B' : '',
            badge: makeEditedBadge(itemAddr.toString()),
            action,
            onClick: () => openAddressTarget(app, router, itemAddr),
          });
        }, hiddenCount ? text(`ライブラリに ${hiddenCount.toLocaleString()} 件あります。`, `${hiddenCount.toLocaleString()} matches are in libraries.`) : text('関数名がまだ復元されていない可能性があります。', 'Function names may not be recovered yet.'),
          hiddenCount
            ? uiButton(text('ライブラリも表示', 'Show libraries'), { cls: 'ui-secondary-action', onClick: () => setHideLibrary(false) })
            // A word that is not a function name is often in a string: offer that search.
            : (q ? uiButton(text(`「${q}」を文字列から探す`, `Search strings for "${q}"`), { cls: 'ui-secondary-action', onClick: () => router.navigate('/explorer/strings?q=' + encodeURIComponent(q)) }) : null));
        if (hiddenCount && items?.length) {
          const note = h('p', 'ui-hint ui-library-hidden-note');
          note.append(text(`ライブラリ ${hiddenCount.toLocaleString()} 件を非表示 `, `${hiddenCount.toLocaleString()} library functions hidden `));
          note.append(uiButton(text('表示', 'Show'), { cls: 'ui-secondary-action', onClick: () => setHideLibrary(false) }));
          const status = content.querySelector('[role="status"]');
          if (status) status.after(note); else content.prepend(note);
        }
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
    const makeAddrRowAction = (rawAddr, label) => {
      if (rawAddr == null) return null;
      let big;
      try { big = BigInt(rawAddr); } catch { return null; }
      const wrap = h('span', 'ui-row-actions');
      const xrefBtn = uiButton('Xrefs', {
        cls: 'ui-secondary-action ui-row-xrefs',
        ariaLabel: text('参照元を見る', 'Show cross-references'),
        onClick: (event) => {
          event.stopPropagation();
          requireFile(app, () => showXrefs(app, big));
        },
      });
      xrefBtn.title = text('参照元を見る (X)', 'Show cross-references (X)');
      const star = makeStarButton(app, big, label || bookmarkLabel(app, big), {
        cls: 'ui-icon-action ui-star-btn ui-row-star',
        stopPropagation: true,
      });
      wrap.append(xrefBtn, star);
      return wrap;
    };
    if (scope === 'strings') {
      content.replaceChildren(loadingState(text('文字列を集めています…', 'Collecting strings…')));
      try {
        const items = await stringItems(app, q, { signal, offset:queryOffset, limit:pageSize });
        if (!current()) return;
        showRows(items, (item) => listRow({
          title: item.text,
          subtitle: addressText(item.addr),
          action: makeAddrRowAction(item.addr, bookmarkLabel(app, item.addr)),
          onClick: () => { app.goToStringAddress(item.region, item.addr); router.navigate('/code/' + BigInt(item.addr).toString()); },
        }), text('文字列が見つかりません。', 'No strings were found.'));
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
        action: item.addr != null ? makeAddrRowAction(item.addr, item.name || bookmarkLabel(app, item.addr)) : null,
        onClick: item.addr != null ? () => router.navigate('/code/' + BigInt(item.addr).toString()) : () => requireFile(app, () => showGlobals(app)),
      }), text('データ構造・グローバル変数情報がありません。', 'No data structures or global variables found.'));
      return;
    }
  };

  const unsubBookmarks = scope === 'functions' ? (app.bookmarks?.subscribe?.(() => {
    if (disposed) return;
    syncFilterChips();
    if (filterMode === 'saved' || filterMode === 'all' || filterMode === 'edited') void update();
  }) || null) : null;
  let unsubNotes = null;
  const bindNotes = () => {
    if (typeof unsubNotes === 'function') { unsubNotes(); unsubNotes = null; }
    if (scope !== 'functions') return;
    unsubNotes = app.notes?.subscribe?.(() => {
      if (disposed) return;
      syncFilterChips();
      void update();
    }) || null;
  };
  bindNotes();
  const onNotesAttached = () => {
    if (disposed) return;
    bindNotes();
    if (scope === 'functions') { syncFilterChips(); void update(); }
  };
  document.addEventListener('hex:notes-attached', onNotesAttached);
  const isSymbolReactiveScope = scope === 'functions' || scope === 'classes' || scope === 'data' || scope === 'external';
  const unsubStore = isSymbolReactiveScope ? (app.store?.subscribe?.((_state, patch) => {
    if (disposed || !patch) return;
    if ('symbolsGen' in patch || 'symbolsReady' in patch) {
      if (scope === 'functions') syncFilterChips();
      void update();
      return;
    }
    if (scope === 'functions' && 'patches' in patch) {
      syncFilterChips();
      if (filterMode === 'edited' || filterMode === 'all') void update();
    }
  }) || null) : null;
  search.addEventListener('input', () => { queryOffset = 0; pendingVirtualState = null; clearTimeout(timer); timer = setTimeout(update, 120); });
  update();
  return {
    root: s.root,
    getState: () => ({ query: search.value, offset: queryOffset, savedOnly: filterMode === 'saved', filterMode, sortMode, virtual: virtual?.getState() || null }),
    restoreState: (state) => {
      if (!state) return;
      if (virtual) virtual.restoreState(state.virtual);
      else pendingVirtualState = state.virtual ?? null;
    },
    dispose: () => {
      disposed = true;
      document.removeEventListener('hex:notes-attached', onNotesAttached);
      if (typeof unsubBookmarks === 'function') unsubBookmarks();
      if (typeof unsubNotes === 'function') unsubNotes();
      if (typeof unsubStore === 'function') unsubStore();
      queryScope.abort('explorer-disposed');
      fallbackRouteController?.abort('explorer-disposed');
      clearTimeout(timer);
      virtual?.dispose();
    },
  };
}

function codeViewState(app) {
  return {
    getState: () => {
      const topRow = app.viewer.topRow();
      const selectedRow = app.viewer.selectedRow;
      let topAddress = null;
      let selectedAddress = null;
      try {
        if (Number.isFinite(topRow) && topRow >= 0 && typeof app.viewer.rowAddress === 'function') {
          const a = app.viewer.rowAddress(topRow);
          if (a != null) topAddress = BigInt(a).toString();
        }
      } catch { /* ignore */ }
      try {
        if (Number.isFinite(selectedRow) && selectedRow >= 0 && typeof app.viewer.rowAddress === 'function') {
          const a = app.viewer.rowAddress(selectedRow);
          if (a != null) selectedAddress = BigInt(a).toString();
        }
      } catch { /* ignore */ }
      return {
        topRow,
        selectedRow,
        topAddress,
        selectedAddress,
        mode: app.store.get('displayMode'),
        regionId: app.store.get('currentRegion')?.id || null,
      };
    },
    restoreState: (state) => {
      if (!state) return;
      if (state.regionId && app.store?.get?.('currentRegion')?.id !== state.regionId) {
        const region = (app.store?.get?.('regions') || []).find((r) => r?.id === state.regionId);
        if (region) app.selectRegion?.(region, { silent: true });
      }
      if (state.mode) app.setMode(state.mode);
      let topRow = Number.isFinite(state.topRow) ? state.topRow : null;
      if (state.topAddress != null && typeof app.viewer.rowOfAddress === 'function') {
        try {
          const mapped = app.viewer.rowOfAddress(BigInt(state.topAddress));
          if (mapped != null && mapped >= 0) topRow = mapped;
        } catch { /* ignore */ }
      }
      if (topRow != null && Number.isFinite(topRow)) app.viewer.goToRow(topRow, 'top');
      let selectedRow = Number.isFinite(state.selectedRow) && state.selectedRow >= 0 ? state.selectedRow : null;
      if (state.selectedAddress != null && typeof app.viewer.rowOfAddress === 'function') {
        try {
          const mapped = app.viewer.rowOfAddress(BigInt(state.selectedAddress));
          if (mapped != null && mapped >= 0) selectedRow = mapped;
        } catch { /* ignore */ }
      }
      if (selectedRow != null && selectedRow >= 0) {
        app.viewer.select(selectedRow, false);
        app.store?.set?.({ selectedRow });
      }
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
  if (!app.store?.get?.('fileInfo')) {
    const s = screen(text('関数', 'Function'), { id: 'function', subtitle: addr != null ? addressText(addr) : '' });
    s.body.append(renderBinaryUnboundCard(app));
    return { root: s.root };
  }
  if (addr == null) {
    const s = screen(text('関数', 'Function'), { id: 'function' });
    s.body.append(emptyState(text('関数が選択されていません', 'No function selected'), text('コードまたは索引から関数を開いてください。', 'Open a function from Code or Explorer.')));
    return { root: s.root };
  }
  const verifiedRange=app.validatedFunctionRange?.(addr);
  const tab = FUNCTION_TABS.some((x) => x.id === route.params.tab) ? route.params.tab : 'overview';
  app.setUiResume?.({ lastFunctionTab: tab });
  if(verifiedRange && !verifiedRange.ok){
    /* Keep the tab bar: this used to replace the whole workspace, so the user
       was stuck on one tab with only a reason code and no way forward. */
    const s=screen(functionName(app,addr),{id:'function',subtitle:addressText(addr)});
    const tabbar = tabs(FUNCTION_TABS, tab, (next) => router.navigate('/function/' + addr.toString() + '/' + next), { panelId: 'ui-function-panel', label: text('関数の表示', 'Function views') });
    s.body.append(tabbar);
    const content=tabPanel(tabbar,'ui-workspace-content');
    const buildUnverifiedState = (reasonCode) => {
      const actions = h('div', 'ui-actions');
      actions.append(
        uiButton(text('アセンブリで開く', 'Open in Assembly'), { cls: 'ui-primary-action', onClick: () => router.navigate('/code/' + addr.toString()) }),
        uiButton(text('関数一覧を開く', 'Browse Functions'), { cls: 'ui-secondary-action', onClick: () => router.navigate('/explorer/functions') }),
      );
      return emptyState(
        text('関数境界を検証できません', 'Function boundary could not be verified'),
        reasonText(reasonCode) || text('このアドレスでは関数境界を検証できませんでした。アセンブリ表示または関数一覧から確認できます。', 'The function boundary could not be verified at this address. You can inspect it in Assembly or pick a function from Explorer.'),
        actions,
      );
    };
    const waitingForBaseSymbols = verifiedRange.reason === 'function-symbol-missing'
      && app.store?.get?.('symbolsReady') === false
      && Boolean(app.analysisBaseSymbolsReady);
    if (waitingForBaseSymbols) {
      let disposedWait = false;
      let settledWait = false;
      let unsubWait = null;
      const cleanupWait = () => {
        if (typeof unsubWait === 'function') { unsubWait(); unsubWait = null; }
      };
      const onSymbolsSettled = () => {
        if (disposedWait || settledWait) return;
        const rechecked = app.validatedFunctionRange?.(addr);
        if (rechecked?.ok) {
          settledWait = true;
          cleanupWait();
          router.navigate(route.fullPath || ('/function/' + addr.toString() + '/' + tab), { replace: true, forcePush: true });
          return;
        }
        if (app.store?.get?.('symbolsReady') !== false) {
          settledWait = true;
          cleanupWait();
          content.replaceChildren(buildUnverifiedState(rechecked?.reason || verifiedRange.reason || 'unverified-function-range'));
        }
      };
      content.append(loadingState(text('シンボル復元を待機しています…', 'Waiting for symbol recovery…')));
      unsubWait = app.store?.subscribe?.((_st, patch) => {
        if (!patch || (!('symbolsReady' in patch) && !('symbolsGen' in patch))) return;
        onSymbolsSettled();
      }) || null;
      Promise.resolve(app.analysisBaseSymbolsReady).then(onSymbolsSettled, onSymbolsSettled);
      s.body.append(content);
      return {
        root: s.root,
        dispose: () => {
          disposedWait = true;
          cleanupWait();
        },
      };
    }
    content.append(buildUnverifiedState(verifiedRange.reason || 'unverified-function-range'));
    s.body.append(content);
    return {root:s.root};
  }
  const actions = h('div', 'ui-screen-actions');
  const starBtn = makeStarButton(app, addr, functionName(app, addr));
  const unsubBookmarks = app.bookmarks?.subscribe?.(() => starBtn._syncStar?.()) || null;
  actions.append(starBtn, uiButton('•••', { cls: 'ui-icon-action', ariaLabel: text('関数の操作', 'Function actions'), onClick: (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const assistant = window.__hexAi;
    menu([
      ...(assistant ? [askAiMenuItem(assistant, functionAiItems(assistant, { address: addr, name: functionName(app, addr) }), { x: r.left + r.width / 2, y: r.bottom + 4 })] : []),
      { label: text('ブックマークメモを編集', 'Edit bookmark note'), action: () => editBookmarkNote(app, addr, functionName(app, addr)) },
      { label: text('名前を付ける', 'Rename'), action: () => showRename(app, addr) },
      { label: text('メモを書く', 'Comment'), action: () => showComment(app, addr) },
      { label: text('パッチ（命令の書き換え）', 'Patch instructions'), action: () => requireFile(app, () => showPatches(app, addr)) },
      { label: text('アセンブリへ', 'Open assembly'), action: () => router.navigate('/code/' + addr.toString()) },
    ], r.left + r.width / 2, r.bottom + 4);
  } }));
  const s = screen(functionName(app, addr), { id: 'function', subtitle: addressText(addr), actions });
  markMission(app, 'open-function', addr);
  const libInfo = libraryInfoAt(app, addr);
  if (isFoldable(libInfo)) {
    s.body.append(h('p', 'ui-hint ui-library-note', text(
      `ライブラリ: ${libInfo.vendor}（${libraryKindLabel(libInfo.kind, true)}）`,
      `Library: ${libInfo.vendor} (${libraryKindLabel(libInfo.kind, false)})`,
    )));
  }
  const tabbar = tabs(FUNCTION_TABS, tab, (next) => router.navigate('/function/' + addr.toString() + '/' + next), { panelId: 'ui-function-panel', label: text('関数の表示', 'Function views') });
  s.body.append(tabbar);
  const content = tabPanel(tabbar, 'ui-workspace-content');
  content.append(loadingState(text('関数を解析しています…', 'Analysing function…')));
  s.body.append(content);
  let disposed = false;
  let pendingPseudoState = routeContext?.restoredState || null;
  let activeProvenanceView = null;
  let activeFallbackTokHl = null;
  let activeFindBar = null;
  let activeDecompileCleanup = null;
  let unsubNotes = null;
  const syncLiveName = () => {
    if (disposed) return;
    const liveName = functionName(app, addr);
    if (s.heading) s.heading.textContent = liveName;
    updateScreenTitle(s.root);
    router.setCurrentLabel?.(liveName);
  };
  const bindNotesSub = () => {
    if (typeof unsubNotes === 'function') { unsubNotes(); unsubNotes = null; }
    unsubNotes = app.notes?.subscribe?.(syncLiveName) || null;
  };
  bindNotesSub();
  const onNotesAttached = () => { if (!disposed) { bindNotesSub(); syncLiveName(); } };
  document.addEventListener('hex:notes-attached', onNotesAttached);
  const viewEpoch = app.backend?.gen;
  const viewSlice = app.store.get('sliceIndex');
  const viewCurrent = () => !disposed && app.backend?.gen === viewEpoch && app.store.get('sliceIndex') === viewSlice;

  const selectedPseudocodeAddress = () => {
    if (typeof activeProvenanceView?.selectedAddress === 'function') {
      try {
        const a = activeProvenanceView.selectedAddress();
        if (a != null) return BigInt(a);
      } catch { /* ignore */ }
    }
    const codeEl = content.querySelector('.ui-pseudocode');
    if (codeEl) {
      const selLine = codeEl.querySelector('.ui-pseudocode-line.selected');
      const dataAddr = selLine?.dataset?.addr || selLine?.querySelector?.('[data-addr]')?.getAttribute?.('data-addr');
      if (dataAddr) {
        try { return BigInt(dataAddr); } catch { /* ignore */ }
      }
      const firstAddrBtn = content.querySelector('.ui-decompiler-provenance .ui-provenance-details button');
      if (firstAddrBtn && /^0x[0-9a-f]+$/i.test(firstAddrBtn.textContent?.trim() || '')) {
        try { return BigInt(firstAddrBtn.textContent.trim()); } catch { /* ignore */ }
      }
    }
    return addr;
  };
  s.root._selectedCodeAddress = selectedPseudocodeAddress;

  const createPseudocodeFindBar = (codeEl) => {
    const bar = h('div', 'ui-pseudocode-find');
    bar.hidden = true;
    const findInput = h('input', 'ui-pseudocode-find-input');
    findInput.type = 'search';
    findInput.placeholder = text('関数内を検索…', 'Find in function…');
    findInput.setAttribute('aria-label', text('関数内を検索', 'Find in function'));
    const countEl = h('span', 'ui-hint ui-pseudocode-find-count', '0/0');
    let matches = [];
    let matchIdx = -1;
    const clearHighlights = () => {
      for (const node of matches) node.classList.remove('ui-find-match', 'ui-find-active');
      matches = [];
      matchIdx = -1;
      countEl.textContent = '0/0';
    };
    const focusMatch = (nextIdx) => {
      if (!matches.length) { countEl.textContent = '0/0'; return; }
      if (matchIdx >= 0 && matches[matchIdx]) matches[matchIdx].classList.remove('ui-find-active');
      matchIdx = ((nextIdx % matches.length) + matches.length) % matches.length;
      const node = matches[matchIdx];
      node.classList.add('ui-find-active');
      node.scrollIntoView?.({ block: 'center' });
      countEl.textContent = `${matchIdx + 1}/${matches.length}`;
    };
    const runFind = () => {
      clearHighlights();
      const q = findInput.value.trim().toLowerCase();
      if (!q || !codeEl) return;
      const lines = codeEl.querySelectorAll('.ui-pseudocode-line');
      for (const line of lines) {
        if ((line.textContent || '').toLowerCase().includes(q)) {
          line.classList.add('ui-find-match');
          matches.push(line);
        }
      }
      if (matches.length) focusMatch(0);
    };
    const closeBar = () => {
      clearHighlights();
      bar.hidden = true;
    };
    const openBar = () => {
      bar.hidden = false;
      findInput.focus();
      findInput.select();
      if (findInput.value.trim()) runFind();
    };
    const prevBtn = uiButton('↑', { cls: 'ui-icon-action', ariaLabel: text('前の一致', 'Previous match'), onClick: () => focusMatch(matchIdx - 1) });
    const nextBtn = uiButton('↓', { cls: 'ui-icon-action', ariaLabel: text('次の一致', 'Next match'), onClick: () => focusMatch(matchIdx + 1) });
    const closeBtn = uiButton('×', { cls: 'ui-icon-action ui-find-close', ariaLabel: text('検索を閉じる', 'Close find'), onClick: closeBar });
    findInput.addEventListener('input', runFind);
    findInput.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeBar(); return; }
      if (event.key === 'Enter') { event.preventDefault(); focusMatch(event.shiftKey ? matchIdx - 1 : matchIdx + 1); }
    });
    bar.append(findInput, countEl, prevBtn, nextBtn, closeBtn);
    return { root: bar, open: openBar, close: closeBar };
  };
  s.root._openPseudocodeFind = () => activeFindBar?.open?.();

  const applyPseudoState = (state) => {
    if (!state) return;
    const bodyTop = Number(state.bodyScrollTop ?? state.scrollTop) || 0;
    s.body.scrollTop = bodyTop;
    const codeEl = content.querySelector('.ui-pseudocode');
    if (!codeEl) { pendingPseudoState = state; return; }
    pendingPseudoState = null;
    if (Number.isFinite(state.codeScrollTop)) codeEl.scrollTop = state.codeScrollTop;
    if (Number.isSafeInteger(state.selectedLineIndex) && state.selectedLineIndex >= 0) {
      const lineNodes = codeEl.querySelectorAll('.ui-pseudocode-line');
      const targetLine = lineNodes[state.selectedLineIndex];
      if (targetLine) {
        for (const n of lineNodes) {
          n.classList.toggle('selected', n === targetLine);
          n.setAttribute('aria-current', n === targetLine ? 'true' : 'false');
        }
      }
    }
  };

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
    const recognition = classifyFunction(recognitionInput(app, addr, res), recognitionVendorContext(app, addr));
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
      for (const candidate of ownerFact.candidates.slice(0, 8)) summary.body.append(listRow({ title: candidate.className || text('不明なクラス', 'Unknown class'), subtitle: candidate.sel || text('メソッド名不明', 'Unknown selector'), badge: evidenceBadge('likely') }));
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
    const insnCount = res.instructions || res.model?.instructions?.length || 0;
    const fnSize = res.size || (res.model?.end != null && res.model?.start != null ? Number(res.model.end - res.model.start) : 0);
    facts.body.append(listRow({ title: text('命令数', 'Instructions'), meta: String(insnCount) }));
    facts.body.append(listRow({ title: text('ブロック数', 'Basic blocks'), meta: formatBlockCount(res.model?.blocks?.length || 0, { instructions: insnCount, size: fnSize }) }));
    facts.body.append(listRow({ title: text('アドレス', 'Address'), meta: addressText(addr), mono: true }));
    facts.body.append(listRow({ title: text('アーキテクチャ', 'Architecture'), meta: architectureOf(app) }));
    grid.append(facts.root);
    const next = card(text('次に見る', 'Next steps'));
    for (const [dest, label] of [
      ['/function/' + addr.toString() + '/pseudocode', text('疑似Cで読む', 'Read pseudocode')],
      ['/code/' + addr.toString(), text('アセンブリへ', 'Open assembly')],
      ['/function/' + addr.toString() + '/flow', text('分岐とループを見る', 'Inspect branches and loops')],
      ['/function/' + addr.toString() + '/calls', text('呼び出し', 'Call graph')],
      ['/function/' + addr.toString() + '/evidence', text('なぜそう言えるか', 'Review evidence')],
      ['/function/' + addr.toString() + '/runtime', text('実行して確かめる', 'Verify at runtime')],
    ]) next.body.append(listRow({ title: label, onClick: () => router.navigate(dest) }));
    grid.append(next.root);
    content.replaceChildren(grid);
  };

  const resolveMatchingGoalContext = () => {
    const stored = app?.lastGoalContext && typeof app.lastGoalContext === 'object'
      ? app.lastGoalContext
      : null;
    if (!stored) return null;
    const ctxAddr = stored.targetAddr ?? stored.addr ?? stored.address ?? stored.candidate?.addr ?? null;
    if (ctxAddr == null || addr == null) return null;
    try {
      if (BigInt(ctxAddr) !== BigInt(addr)) return null;
    } catch {
      return null;
    }
    return stored;
  };

  const applyGoalLineHighlight = (lineEl, lineIndex) => {
    lineEl.classList.add('hex-goal-highlight');
    lineEl.setAttribute('data-line-index', String(lineIndex));
    if (lineEl.style) {
      lineEl.style.borderLeft = '3px solid var(--accent, #f59e0b)';
      lineEl.style.background = 'rgba(245, 158, 11, 0.14)';
      lineEl.style.paddingLeft = '8px';
      lineEl.style.marginLeft = '-11px';
      lineEl.style.display = 'block';
    }
  };

  const buildGoalBanner = (summary, highlightLines, firstHighlighted) => {
    const banner = h('section', 'goal-candidate-summary');
    if (banner.style) {
      banner.style.borderLeft = '3px solid var(--accent, #f59e0b)';
      banner.style.background = 'rgba(245, 158, 11, 0.08)';
      banner.style.padding = '10px 12px';
      banner.style.borderRadius = '6px';
      banner.style.marginBottom = '10px';
    }
    const topRow = h('div', 'goal-summary-head');
    if (topRow.style) {
      topRow.style.display = 'flex';
      topRow.style.alignItems = 'center';
      topRow.style.justifyContent = 'space-between';
      topRow.style.gap = '8px';
      topRow.style.marginBottom = '4px';
    }
    const titleText = summary.goalLabel
      ? text(`目的との関連: ${summary.goalLabel}`, `Goal context: ${summary.goalLabel}`)
      : text('目的候補の要約', 'Goal candidate summary');
    const title = h('div', 'goal-summary-title', titleText);
    if (title.style) {
      title.style.fontSize = '12px';
      title.style.fontWeight = '600';
      title.style.opacity = '0.85';
    }
    topRow.append(title);
    if (summary.verdictLabel) {
      const badge = h('span', 'goal-summary-verdict', summary.verdictLabel);
      if (badge.style) {
        badge.style.fontSize = '11px';
        badge.style.fontWeight = '600';
        badge.style.padding = '2px 6px';
        badge.style.borderRadius = '4px';
        badge.style.background = 'rgba(245, 158, 11, 0.18)';
      }
      topRow.append(badge);
    }
    banner.append(topRow);
    const headline = h('div', 'goal-summary-headline', summary.headline);
    if (headline.style) {
      headline.style.fontWeight = '600';
      headline.style.marginBottom = summary.bullets.length ? '6px' : '0';
    }
    banner.append(headline);
    if (summary.bullets.length) {
      const ul = h('ul', 'goal-summary-list');
      if (ul.style) {
        ul.style.margin = '0';
        ul.style.paddingLeft = '18px';
      }
      for (const item of summary.bullets) {
        ul.append(h('li', 'goal-summary-item', item));
      }
      banner.append(ul);
    }
    if (Array.isArray(highlightLines) && highlightLines.length && highlightLines[0] >= 4 && firstHighlighted) {
      const jumpBtn = uiButton(text('該当箇所へ移動', 'Jump to match'), {
        cls: 'ui-secondary-action goal-jump-btn',
        onClick: () => firstHighlighted.scrollIntoView?.({ behavior: 'smooth', block: 'center' }),
      });
      if (jumpBtn.style) jumpBtn.style.marginTop = '8px';
      banner.append(jumpBtn);
    }
    return banner;
  };

  const renderPseudocode = (res) => {
    const map = rowMapper();
    if (!map.supported) {
      content.replaceChildren(emptyState(text('このアーキテクチャの疑似Cは未対応です', 'Pseudocode is unavailable for this architecture'), text('疑似Cへの変換は、いまは ARM64 だけに対応しています。ほかの CPU の命令を ARM64 として読み違えないよう、表示を止めています。', 'The Semantic Decompiler currently targets ARM64; Hex will not reinterpret another CPU as ARM64.')));
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
    const rawText = decompiledText(out);
    const rawLines = rawText.split('\n');
    const sigIdx = findSignatureLineIndex(rawLines);
    const prelude = preludeLength(rawLines);
    const goalCtx = resolveMatchingGoalContext();
    const highlightLines = goalCtx && rawText ? findGoalHighlightLines(rawText, goalCtx) : [];
    const highlightSet = new Set(highlightLines);
    const goalSummary = goalCtx
      ? buildGoalCandidateSummary({
        goal: goalCtx.goal,
        candidate: goalCtx.candidate,
        pinpoint: goalCtx.pinpoint,
        fields: goalCtx.fields,
        pseudocode: rawText || null,
        disasm: goalCtx.disasm ?? res?.model?.instructions ?? null,
      })
      : null;
    let firstGoalHighlight = null;
    const calleeOpts = {
      resolveCallee: (name) => symbolAddress(app, name),
      onOpenCallee: (targetAddr) => router.navigate('/function/' + BigInt(targetAddr).toString() + '/pseudocode'),
      onOpenAddress: (targetAddr) => router.navigate('/code/' + BigInt(targetAddr).toString()),
    };
    if (prelude > 0) code.classList.add('fold-prelude');
    for (let index = 0; index < rawLines.length; index++) {
      const lineText = rawLines[index];
      const rowClasses = ['ui-pseudocode-line'];
      if (index < prelude) rowClasses.push('prelude');
      const isSig = index === sigIdx;
      if (isSig) rowClasses.push('is-sig');
      const row = h('span', rowClasses.join(' '));
      if (highlightSet.has(index)) {
        applyGoalLineHighlight(row, index);
        if (!firstGoalHighlight) firstGoalHighlight = row;
      }
      appendHighlighted(row, lineText, { ...calleeOpts, isSig });
      if (index + 1 < rawLines.length) row.append(h('span', null, '\n'));
      code.append(row);
    }
    const hlBadge = h('span', 'ui-highlight-nav');
    hlBadge.hidden = true;
    const hlCount = h('span', 'ui-hint ui-highlight-count', '');
    let tokHl = null;
    const hlPrev = uiButton('↑', { cls: 'ui-icon-action', ariaLabel: text('前の出現', 'Previous occurrence'), onClick: () => tokHl?.prev?.() });
    const hlNext = uiButton('↓', { cls: 'ui-icon-action', ariaLabel: text('次の出現', 'Next occurrence'), onClick: () => tokHl?.next?.() });
    hlBadge.append(hlCount, hlPrev, hlNext);
    tokHl = attachTokenHighlight(code, {
      onHighlightChange: (info) => {
        const count = Number(info?.count || 0);
        if (!info || count <= 0) { hlBadge.hidden = true; return; }
        const idx = Number.isSafeInteger(info.index) ? info.index + 1 : 1;
        hlCount.textContent = `${idx}/${count}`;
        hlBadge.hidden = false;
      },
    });
    let wrap = false;
    activeProvenanceView?.tokenHighlight?.destroy?.();
    activeProvenanceView = null;
    activeFallbackTokHl?.destroy?.();
    activeFallbackTokHl = tokHl;
    const findBar = createPseudocodeFindBar(code);
    activeFindBar = findBar;
    const findBtn = uiButton(text('検索', 'Find'), { cls: 'ui-secondary-action', onClick: () => findBar.open() });
    findBtn.title = text('関数内を検索 (Ctrl+F)', 'Find in function (Ctrl+F)');
    const asmBtn = uiButton(text('アセンブリへ', 'Assembly'), { cls: 'ui-secondary-action', onClick: () => router.navigate('/code/' + selectedPseudocodeAddress().toString()) });
    asmBtn.title = text('アセンブリへ切り替え (Space)', 'Switch to assembly (Space)');
    toolbar.append(
      uiButton(text('コピー', 'Copy'), { cls: 'ui-secondary-action', onClick: () => copyText(code.textContent, text('疑似C', 'Pseudocode')) }),
      uiButton(text('折り返し', 'Wrap'), { cls: 'ui-secondary-action', pressed: false, onClick: (e) => { wrap = !wrap; code.classList.toggle('wrap', wrap); e.currentTarget.setAttribute('aria-pressed', String(wrap)); } }),
      findBtn,
      asmBtn,
      hlBadge,
    );
    if (prelude > 0) {
      const toggle = uiButton(text(`型の定義を表示（${prelude} 行）`, `Show type definitions (${prelude} lines)`), {
        cls: 'ui-secondary-action',
        pressed: false,
        onClick: () => {
          const shown = !code.classList.contains('show-prelude');
          code.classList.toggle('show-prelude', shown);
          toggle.setAttribute('aria-pressed', String(shown));
          toggle.textContent = shown ? text('型の定義をたたむ', 'Hide type definitions') : text(`型の定義を表示（${prelude} 行）`, `Show type definitions (${prelude} lines)`);
        },
      });
      toolbar.append(toggle);
    }
    const goalBanner = goalSummary ? buildGoalBanner(goalSummary, highlightLines, firstGoalHighlight) : null;
    content.replaceChildren(...(goalBanner ? [goalBanner] : []), toolbar, findBar.root, code);
    if (pendingPseudoState) applyPseudoState(pendingPseudoState);
  };

  const renderPseudocodeTab = async () => {
    activeDecompileCleanup?.();
    activeDecompileCleanup = null;
    if (!viewCurrent() || routeSignal.aborted) return;

    if (!app.analysisQueries) {
      const map = rowMapper();
      if (!map.supported) {
        content.replaceChildren(emptyState(text('このアーキテクチャの疑似Cは未対応です', 'Pseudocode is unavailable for this architecture'), text('疑似Cへの変換は、いまは ARM64 だけに対応しています。ほかの CPU の命令を ARM64 として読み違えないよう、表示を止めています。', 'The Semantic Decompiler currently targets ARM64; Hex will not reinterpret another CPU as ARM64.')));
        return;
      }
    }

    const localController = new AbortController();
    const localSignal = localController.signal;
    let cancelledByUser = false;
    let timerId = null;

    const clearTimer = () => {
      if (timerId != null) {
        clearInterval(timerId);
        timerId = null;
      }
    };
    const onRouteAbort = () => {
      clearTimer();
      if (!localController.signal.aborted) localController.abort(routeSignal.reason || 'route-aborted');
    };
    const cleanup = () => {
      clearTimer();
      routeSignal.removeEventListener('abort', onRouteAbort);
      if (activeDecompileCleanup === teardown) activeDecompileCleanup = null;
    };
    const teardown = () => {
      cleanup();
      if (!localController.signal.aborted) localController.abort('superseded');
    };
    activeDecompileCleanup = teardown;
    routeSignal.addEventListener('abort', onRouteAbort, { once: true });

    const baseLabel = text('関数を解析しています…', 'Analysing function…');
    const loadingEl = loadingState(baseLabel);
    const labelEl = loadingEl.querySelector('span:last-child');
    const cancelBtn = uiButton(text('キャンセル', 'Cancel'), {
      cls: 'ui-secondary-action',
      onClick: () => {
        if (localController.signal.aborted) return;
        cancelledByUser = true;
        cleanup();
        localController.abort('user-cancelled');
        if (viewCurrent() && !routeSignal.aborted) {
          content.replaceChildren(emptyState(
            text('逆コンパイルをキャンセルしました', 'Decompilation cancelled'),
            text('解析を中断しました。必要なときに再試行できます。', 'Analysis was stopped. You can retry whenever you are ready.'),
            uiButton(text('再試行', 'Retry'), {
              cls: 'ui-primary-action',
              onClick: () => {
                void renderPseudocodeTab().catch((retryErr) => {
                  if (viewCurrent() && !routeSignal.aborted) {
                    content.replaceChildren(errorState(text('表示できませんでした', 'Could not render this view'), String(retryErr && retryErr.message || retryErr)));
                  }
                });
              },
            }),
          ));
        }
      },
    });
    loadingEl.append(cancelBtn);
    content.replaceChildren(loadingEl);

    const renderUnavailablePseudocode = (reason) => {
      const actions = h('div', 'ui-actions');
      actions.append(
        uiButton(text('アセンブリで開く', 'Open in Assembly'), {
          cls: 'ui-primary-action',
          onClick: () => router.navigate('/code/' + addr.toString()),
        }),
        uiButton(text('関数一覧を開く', 'Browse Functions'), {
          cls: 'ui-secondary-action',
          onClick: () => router.navigate('/explorer/functions'),
        }),
      );
      const body = reasonText(reason) || text(
        'このアドレスの関数情報を取得できませんでした。アセンブリ表示または関数一覧から確認できます。',
        'Function information could not be resolved at this address. You can inspect it in Assembly or pick a function from Explorer.',
      );
      content.replaceChildren(emptyState(
        text('このアドレスの疑似Cを表示できません', 'Pseudocode is unavailable at this address'),
        body,
        actions,
      ));
    };

    let activeLoadingBase = baseLabel;
    const startedAt = Date.now();
    timerId = setInterval(() => {
      if (disposed || routeSignal.aborted || localSignal.aborted || !viewCurrent()) {
        clearTimer();
        return;
      }
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsedSec >= 2 && labelEl) {
        labelEl.textContent = text(`${activeLoadingBase} (${elapsedSec}秒)`, `${activeLoadingBase} (${elapsedSec}s)`);
      }
    }, 500);

    try {
      if (app.store?.get?.('symbolsReady') === false && app.analysisBaseSymbolsReady) {
        if (localSignal.aborted) return;
        const waitingLabel = text('シンボル復元を待機しています…', 'Waiting for symbol recovery…');
        activeLoadingBase = waitingLabel;
        if (labelEl) labelEl.textContent = waitingLabel;
        let onSymbolWaitAbort = null;
        try {
          await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            onSymbolWaitAbort = finish;
            if (localSignal.aborted) {
              finish();
              return;
            }
            localSignal.addEventListener('abort', onSymbolWaitAbort, { once: true });
            Promise.resolve(app.analysisBaseSymbolsReady).then(finish, finish);
          });
        } finally {
          if (onSymbolWaitAbort) localSignal.removeEventListener('abort', onSymbolWaitAbort);
        }
        if (!viewCurrent() || localSignal.aborted || routeSignal.aborted) return;
        activeLoadingBase = baseLabel;
        if (labelEl) labelEl.textContent = baseLabel;
      }

      if (app.analysisQueries) {
        const snapshot = await app.analysisQueries.snapshot({ signal: localSignal });
        if (!viewCurrent() || localSignal.aborted || routeSignal.aborted) return;
        const res = await app.analysisQueries.decompile(snapshot, addr, { signal: localSignal });
        if (!viewCurrent() || localSignal.aborted || routeSignal.aborted) return;
        if (res.completeness === 'unsupported' || !res.value) {
          const reason = res?.status?.reason || '';
          if (reason.startsWith('function-analysis-unsupported-architecture:') || (!reason && !rowMapper().supported)) {
            content.replaceChildren(emptyState(text('このアーキテクチャの疑似Cは未対応です', 'Pseudocode is unavailable for this architecture'), text('疑似Cへの変換は、いまは ARM64 だけに対応しています。ほかの CPU の命令を ARM64 として読み違えないよう、表示を止めています。', 'The Semantic Decompiler currently targets ARM64; Hex will not reinterpret another CPU as ARM64.')));
            return;
          }
          renderUnavailablePseudocode(reason);
          return;
        }
        let initialAddr = null;
        const rawInitial = route.query?.get?.('addr');
        if (rawInitial) {
          try { initialAddr = BigInt(rawInitial); } catch { initialAddr = null; }
        }
        if (initialAddr == null) initialAddr = syncAddressFor(app, addr);
        const functionComment = app.notes?.comment?.(addr) || '';
        let wrap = false;
        let codeRef = null;
        let findBarRef = null;

        const copyBtn = uiButton(text('コピー', 'Copy'), { cls: 'ui-secondary-action', onClick: () => { if (codeRef) copyText(codeRef.textContent, text('疑似C', 'Pseudocode')); } });
        const wrapBtn = uiButton(text('折り返し', 'Wrap'), { cls: 'ui-secondary-action', pressed: false, onClick: (e) => { wrap = !wrap; codeRef?.classList.toggle('wrap', wrap); e.currentTarget.setAttribute('aria-pressed', String(wrap)); } });
        const findBtn = uiButton(text('検索', 'Find'), { cls: 'ui-secondary-action', onClick: () => findBarRef?.open?.() });
        findBtn.title = text('関数内を検索 (Ctrl+F)', 'Find in function (Ctrl+F)');
        const asmBtn = uiButton(text('アセンブリへ', 'Assembly'), { cls: 'ui-secondary-action', onClick: () => router.navigate('/code/' + selectedPseudocodeAddress().toString()) });
        asmBtn.title = text('アセンブリへ切り替え (Space)', 'Switch to assembly (Space)');
        const extraToolbarActions = [copyBtn, wrapBtn, findBtn, asmBtn];

        const provenanceView = createDecompilerProvenanceView(res, {
          text, signal:routeSignal,
          isCurrent:() => viewCurrent() && !routeSignal.aborted,
          currentSnapshot:() => app.analysisQueries.snapshot({ signal:routeSignal }),
          onNavigate:address => router.navigate('/code/' + address.toString()),
          resolveCallee:(name) => symbolAddress(app, name),
          onOpenCallee:(targetAddr) => router.navigate('/function/' + BigInt(targetAddr).toString() + '/pseudocode'),
          extraToolbarActions,
          functionComment,
          initialAddr,
          onSelectAddress:(selected) => setSyncAddress(app, addr, selected),
          onBookmarkAddress:(targetAddr) => {
            if (targetAddr == null) return;
            const big = BigInt(targetAddr);
            const name = bookmarkLabel(app, big);
            app.bookmarks?.toggle?.(big, { name });
            const saved = !!app.bookmarks?.has?.(big);
            toast(saved
              ? text(`★「${name}」をブックマークしました。`, `★ Bookmarked "${name}".`)
              : text(`☆「${name}」のブックマークを解除しました。`, `☆ Removed bookmark "${name}".`));
          },
        });
        activeProvenanceView?.tokenHighlight?.destroy?.();
        activeFallbackTokHl?.destroy?.();
        activeFallbackTokHl = null;
        activeProvenanceView = provenanceView;
        markMission(app, 'read-pseudo');
        const code = provenanceView.code;
        codeRef = code;
        const findBar = createPseudocodeFindBar(code);
        findBarRef = findBar;
        activeFindBar = findBar;
        if (!provenanceView.root.contains(copyBtn)) {
          const innerToolbar = provenanceView.root.querySelector('.ui-code-toolbar');
          if (innerToolbar) innerToolbar.prepend(copyBtn, wrapBtn, findBtn, asmBtn);
        }
        code.before(findBar.root);
        const goalCtx = resolveMatchingGoalContext();
        let goalBanner = null;
        if (goalCtx) {
          const lineNodes = [...code.querySelectorAll('.ui-pseudocode-line')].filter((n) => !n.classList.contains('is-fn-comment'));
          const renderedText = lineNodes.map((n) => String(n.textContent || '').replace(/\n$/, '')).join('\n');
          const highlightLines = renderedText ? findGoalHighlightLines(renderedText, goalCtx) : [];
          let firstGoalHighlight = null;
          for (const idx of highlightLines) {
            const lineEl = lineNodes[idx];
            if (lineEl) {
              applyGoalLineHighlight(lineEl, idx);
              if (!firstGoalHighlight) firstGoalHighlight = lineEl;
            }
          }
          const goalSummary = buildGoalCandidateSummary({
            goal: goalCtx.goal,
            candidate: goalCtx.candidate,
            pinpoint: goalCtx.pinpoint,
            fields: goalCtx.fields,
            pseudocode: renderedText || null,
            disasm: goalCtx.disasm ?? res?.value?.model?.instructions ?? null,
          });
          if (goalSummary) goalBanner = buildGoalBanner(goalSummary, highlightLines, firstGoalHighlight);
        }
        content.replaceChildren(...(goalBanner ? [goalBanner] : []), provenanceView.root);
        const notice = decompileNotice(res);
        if (notice) {
          const innerToolbar = provenanceView.root.querySelector('.ui-code-toolbar');
          if (innerToolbar) innerToolbar.after(notice);
          else provenanceView.root.prepend(notice);
        }
        if (pendingPseudoState) applyPseudoState(pendingPseudoState);
        return;
      }

      const res = await app.analyzeFunctionAt(addr, { signal: localSignal });
      if (!viewCurrent() || localSignal.aborted || routeSignal.aborted) return;
      if (!res || !res.model) { content.replaceChildren(errorState(text('関数を解析できません', 'Could not analyse function'), text('このアドレスは現在のコード領域の関数として解析できませんでした。', 'This address could not be analysed as a function in the current code region.'))); return; }
      renderPseudocode(res);
    } catch (err) {
      if (cancelledByUser || localSignal.aborted || routeSignal.aborted) return;
      if (reasonText(err?.message)) {
        renderUnavailablePseudocode(err.message);
        return;
      }
      throw err;
    } finally {
      cleanup();
    }
  };

  const renderFlow = (res) => {
    const map = rowMapper();
    if (!map.supported) {
      content.replaceChildren(emptyState(text('このアーキテクチャのCFG表示は未対応です', 'CFG view is unavailable for this architecture'), text('このファイルの命令の長さが固定ではないため、図を正しく描けません。表示を止めています。', 'This view is disabled rather than assuming fixed four-byte instruction rows.')));
      return;
    }
    const graph = cfgGraph(res.model, {
      rowOfAddress: map.rowOfAddress,
      text: (insn) => insn.mnemonic + ' ' + insn.operands,
      onNode: (_block, target) => { setSyncAddress(app, addr, target); router.navigate('/code/' + BigInt(target).toString()); },
    });
    if (!graph.nodes.length) { content.replaceChildren(emptyState(text('フローを作れませんでした', 'No control flow available'), text('この関数には図にできるブロック情報がありません。', 'This function has no graphable block information.'))); return; }
    const mode = h('div', 'ui-graph-shell');
    const graphHost = h('div', 'ui-graph-host');
    graphHost.append(renderGraph(graph.nodes, graph.edges, {}));
    highlightGraphNode(graphHost, graph.nodes, syncAddressFor(app, addr));
    const list = h('details', 'ui-graph-text');
    list.append(h('summary', null, text('テキスト一覧でも見る', 'View as text list')));
    const rows = h('div', 'ui-list');
    graph.nodes.forEach((node, index) => rows.append(listRow({
      title: String(node.label || node.title || node.id || `Block ${index + 1}`),
      subtitle: node.addr != null ? addressText(node.addr) : '',
      // Same destination as tapping the block in the graph.
      onClick: node.addr != null ? () => router.navigate('/code/' + BigInt(node.addr).toString()) : null,
    })));
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
        const canonical = res.completeness !== 'unsupported' && !!res.value;
        if (!canonical && !rowMapper().supported) {
          content.replaceChildren(emptyState(text('このアーキテクチャのCFG表示は未対応です', 'CFG view is unavailable for this architecture'), text('このファイルの命令の長さが固定ではないため、図を正しく描けません。表示を止めています。', 'This view is disabled rather than assuming fixed four-byte instruction rows.')));
          return;
        }
        /* No canonical CFG for this function (the fast route does not always
           build one) on an ARM64 file: fall through to the local model below
           instead of wrongly saying the architecture is unsupported. */
        if (canonical) {
          const cfg = res.value;
          const parseBlockAddr = (value) => {
            if (value == null) return null;
            if (typeof value === 'bigint') return value >= 0n ? value : null;
            if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
            if (typeof value === 'string') {
              const trimmed = value.trim();
              if (!trimmed) return null;
              try {
                const parsed = BigInt(trimmed);
                return parsed >= 0n ? parsed : null;
              } catch { return null; }
            }
            return null;
          };
          const originAddr = (origin) => {
            if (!origin || typeof origin !== 'object') return null;
            for (const candidate of [
              origin.address, origin.virtualAddress, origin.vmAddress,
              origin.virtualRange?.start, origin.addressRange?.start, origin.addresses?.[0],
            ]) {
              const parsed = parseBlockAddr(candidate);
              if (parsed != null) return parsed;
            }
            return null;
          };
          const blockAddrOf = (b, id) => {
            const direct = parseBlockAddr(b?.startAddress ?? b?.address ?? b?.addr ?? b?.start);
            if (direct != null) return direct;
            const fromOrigin = originAddr(b?.origin);
            if (fromOrigin != null) return fromOrigin;
            const insts = Array.isArray(b?.insts) ? b.insts : (Array.isArray(b?.instructions) ? b.instructions : null);
            if (insts?.length) {
              const first = parseBlockAddr(insts[0]?.address) ?? originAddr(insts[0]?.origin);
              if (first != null) return first;
            }
            const idMatch = /^(?:(?:bb|block|blk|b)[_:-]?)?(0x[0-9a-f]+)$/i.exec(id);
            if (idMatch) {
              const parsed = parseBlockAddr(idMatch[1]);
              if (parsed != null) return parsed;
            }
            if (cfg.entryBlockId != null && id === String(cfg.entryBlockId)) {
              return parseBlockAddr(addr);
            }
            return null;
          };
          const blockLinesOf = (b) => {
            if (Array.isArray(b?.lines)) return b.lines.map((line) => String(line));
            const insts = Array.isArray(b?.insts) ? b.insts : (Array.isArray(b?.instructions) ? b.instructions : null);
            if (!insts?.length) return [];
            return insts.slice(0, 24).map((inst) => {
              const mnemonic = String(inst?.mnemonic ?? '').trim();
              const operands = String(inst?.operands ?? '').trim();
              if (mnemonic) return operands ? `${mnemonic} ${operands}` : mnemonic;
              const op = String(inst?.op ?? inst?.kind ?? '').trim();
              const sub = String(inst?.sub ?? '').trim();
              return sub ? `${op}.${sub}` : op;
            }).filter(Boolean);
          };
          const edgeStyle = (rawKind, explicitLabel = null) => {
            switch (rawKind) {
              case 'conditional-true': return { kind:'true', label:explicitLabel ?? text('成り立つ', 'true') };
              case 'conditional-false': return { kind:'false', label:explicitLabel ?? text('成り立たない', 'false') };
              case 'true': return { kind:'true', label:explicitLabel };
              case 'false': return { kind:'false', label:explicitLabel };
              case 'back': return { kind:'back', label:explicitLabel };
              case 'exception': return { kind:'jump', label:explicitLabel ?? text('例外', 'exception') };
              case 'indirect-candidate': return { kind:'jump', label:explicitLabel ?? text('間接候補', 'indirect') };
              case 'unknown': return { kind:'jump', label:explicitLabel ?? text('未確定', 'unknown') };
              case 'call': return { kind:'call', label:explicitLabel ?? text('呼び出し', 'call') };
              case 'tail-call': return { kind:'call', label:explicitLabel ?? text('末尾呼び出し', 'tail call') };
              default: return { kind:'jump', label:explicitLabel };
            }
          };

          const rawBlocks = Array.isArray(cfg.blocks) ? cfg.blocks : [];
          const nodes = rawBlocks.map((b, index) => {
            const id = String(b?.id ?? `b${index}`);
            const nodeAddr = blockAddrOf(b, id);
            const displayTitle = String(b?.title || b?.label || b?.name || (nodeAddr != null ? addressText(nodeAddr) : id));
            const kind = b?.kind || (cfg.entryBlockId != null && id === String(cfg.entryBlockId) ? 'entry' : '');
            return {
              id,
              title: displayTitle,
              label: displayTitle,
              lines: blockLinesOf(b),
              kind,
              addr: nodeAddr,
              onTap: nodeAddr != null ? () => { setSyncAddress(app, addr, nodeAddr); router.navigate('/code/' + nodeAddr.toString()); } : null,
            };
          });
          const nodeIds = new Set(nodes.map((n) => n.id));
          const edges = [];
          const seenEdges = new Set();
          const pushEdge = (fromRaw, toRaw, rawKind, explicitLabel = null) => {
            if (fromRaw == null || toRaw == null) return;
            const from = String(fromRaw);
            const to = String(toRaw);
            if (!nodeIds.has(from) || !nodeIds.has(to)) return;
            const style = edgeStyle(rawKind, explicitLabel);
            const key = JSON.stringify([from, to, style.kind, style.label ?? '']);
            if (seenEdges.has(key)) return;
            seenEdges.add(key);
            edges.push({ from, to, kind:style.kind, label:style.label });
          };
          rawBlocks.forEach((b, index) => {
            const from = String(b?.id ?? `b${index}`);
            const outgoing = Array.isArray(b?.successors)
              ? b.successors
              : (Array.isArray(b?.succs) ? b.succs : (Array.isArray(b?.outEdges) ? b.outEdges : []));
            for (const edge of outgoing) {
              if (typeof edge === 'string' || typeof edge === 'number') {
                pushEdge(from, edge, 'branch', null);
              } else if (edge && typeof edge === 'object') {
                pushEdge(from, edge.to ?? edge.target ?? edge.id, edge.kind, edge.label ?? null);
              }
            }
          });
          if (Array.isArray(cfg.edges)) {
            for (const e of cfg.edges) {
              if (e && typeof e === 'object') {
                pushEdge(e.from ?? e.source, e.to ?? e.target, e.kind, e.label ?? null);
              }
            }
          }
          if (!nodes.length) {
            content.replaceChildren(emptyState(text('フローを作れませんでした', 'No control flow available'), text('この関数には図にできるブロック情報がありません。', 'This function has no graphable block information.')));
            return;
          }
          const mode = h('div', 'ui-graph-shell');
          const graphHost = h('div', 'ui-graph-host');
          graphHost.append(renderGraph(nodes, edges, {}));
          highlightGraphNode(graphHost, nodes, syncAddressFor(app, addr));
          const list = h('details', 'ui-graph-text');
          list.append(h('summary', null, text('テキスト一覧でも見る', 'View as text list')));
          const rows = h('div', 'ui-list');
          nodes.forEach((node, index) => rows.append(listRow({
            title: String(node.title || node.label || node.id || `Block ${index + 1}`),
            subtitle: node.addr != null ? addressText(node.addr) : '',
            onClick: node.addr != null ? () => router.navigate('/code/' + BigInt(node.addr).toString()) : null,
          })));
          list.append(rows);
          mode.append(graphHost, graphLegend('cfg'), list);
          content.replaceChildren(mode);
          return;
        }
      } catch (err) {
        if (routeSignal.aborted) return;
        throw err;
      }
    }
    const map = rowMapper();
    if (!map.supported) {
      content.replaceChildren(emptyState(text('このアーキテクチャのCFG表示は未対応です', 'CFG view is unavailable for this architecture'), text('このファイルの命令の長さが固定ではないため、図を正しく描けません。表示を止めています。', 'This view is disabled rather than assuming fixed four-byte instruction rows.')));
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
        onNode: (a) => openAddressTarget(app, router, a),
      });
      const shell = h('div', 'ui-graph-shell');
      const callsActions = h('div', 'ui-actions');
      callsActions.append(uiButton(text('すべての参照元 (Xrefs)', 'All cross-references (Xrefs)'), {
        cls: 'ui-secondary-action',
        onClick: () => requireFile(app, () => showXrefs(app, addr)),
      }));
      const origin = card(text('どこから来る？', 'Where it comes from'));
      const { paths, complete } = findEntryPaths(app.program, (a) => app.symbols?.nameAt?.(a) || null, addr);
      if (!paths.length) {
        origin.body.append(h('p', 'ui-sub', text('入口までの道は見つかりませんでした。', 'No path from a known entry point.')));
      } else {
        for (const path of paths) {
          const row = h('div', 'ui-entry-path');
          row.append(h('span', 'ui-entry-kind', ja() ? path.ja : path.en));
          path.nodes.forEach((node, index) => {
            if (index) row.append(h('span', 'ui-entry-arrow', '→'));
            const isSelf = node === addr;
            const step = uiButton(functionName(app, node), { cls: 'ui-secondary-action ui-entry-step' + (isSelf ? ' is-self' : '') });
            if (!isSelf) step.addEventListener('click', () => openAddressTarget(app, router, node));
            else step.disabled = true;
            row.append(step);
          });
          origin.body.append(row);
        }
      }
      if (!complete) origin.body.append(h('p', 'ui-hint', text('一部のみ探索', 'Partial search')));
      shell.append(origin.root, callsActions, renderGraph(graph.nodes, graph.edges, {}), graphLegend('call'));

      const listsGrid = h('div', 'ui-card-grid');
      const callers = typeof app.program.callersOf === 'function' ? (app.program.callersOf(addr, 50) || []) : [];
      const fnInfo = app.symbols?.functionAt?.(addr) || null;
      const callees = typeof app.program.calleesOf === 'function'
        ? (app.program.calleesOf(fnInfo?.start ?? addr, fnInfo?.end ?? null, 50) || [])
        : [];
      const callersCard = card(text(`呼び出し元 (${callers.length})`, `Callers (${callers.length})`));
      if (!callers.length) {
        callersCard.body.append(h('p', 'ui-sub', text('呼び出し元は見つかりませんでした。', 'No callers found.')));
      } else {
        const list = h('div', 'ui-list');
        for (const item of callers) {
          const target = item.addr != null ? BigInt(item.addr) : (item.site != null ? BigInt(item.site) : null);
          if (target == null) continue;
          list.append(listRow({
            title: item.addr != null ? functionName(app, target) : bookmarkLabel(app, target),
            subtitle: addressText(target),
            meta: item.count > 1 ? `×${item.count}` : '',
            onClick: () => (item.addr != null ? openAddressTarget(app, router, target) : router.navigate('/code/' + target.toString())),
          }));
        }
        callersCard.body.append(list);
      }
      const calleesCard = card(text(`呼び出し先 (${callees.length})`, `Callees (${callees.length})`));
      if (!callees.length) {
        calleesCard.body.append(h('p', 'ui-sub', text('呼び出し先は見つかりませんでした。', 'No callees found.')));
      } else {
        const list = h('div', 'ui-list');
        for (const item of callees) {
          const target = item.addr != null ? BigInt(item.addr) : null;
          if (target == null) continue;
          list.append(listRow({
            title: functionName(app, target),
            subtitle: addressText(target),
            meta: item.count > 1 ? `×${item.count}` : '',
            onClick: () => openAddressTarget(app, router, target),
          }));
        }
        calleesCard.body.append(list);
      }
      listsGrid.append(callersCard.root, calleesCard.root);
      shell.append(listsGrid);
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
    const c = card(text('実行時に確かめる', 'Verify at runtime'), { subtitle: text('この関数だけを、端末の中の安全な実行環境（サンドボックス）で動かして、何が起きるかを記録します。', 'Run this function in the Runtime Analysis Platform local sandbox and record evidence.') });
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
        list.append(listRow({ title: text('実行で得た根拠', 'Runtime evidence'), meta: String(result.evidence?.length || 0), badge: evidenceBadge(result.evidence?.length ? 'confirmed' : 'unverified') }));
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

    const io = card(text('入力と出力', 'Inputs and outputs'));
    const ioHost = h('div', 'ui-io-result');
    const ioRun = uiButton(text('試す', 'Try'), { cls: 'ui-primary-action ui-io-run' });
    ioRun.addEventListener('click', async () => {
      ioRun.disabled = true;
      const ioSignal = runScope.spawn('io-probe-replaced');
      ioHost.replaceChildren(loadingState(text('実行しています…', 'Running…')));
      try {
        let arity = null;
        try {
          const snap = await app.analysisQueries.snapshot({ signal: ioSignal });
          const dec = await app.analysisQueries.decompile(snap, addr, { signal: ioSignal });
          arity = arityFromPseudocode(dec?.value?.pseudocode ?? dec?.value?.code ?? '');
        } catch (err) { if (ioSignal.aborted) return; }
        const { rows } = await probeFunction(app, addr, { trace: traceAppFunction, arity, signal: ioSignal });
        if (!viewCurrent() || ioSignal.aborted) return;
        const rule = summarizeProbe(rows, { ja: ja() });
        const table = h('table', 'ui-io-table');
        const head = h('tr');
        for (const label of [text('入力', 'Input'), text('出力', 'Output'), text('状態', 'Status')]) head.append(h('th', null, label));
        const thead = h('thead'); thead.append(head); table.append(thead);
        const body = h('tbody');
        const stopText = (r) => r.stop === 'return'
          ? (r.writes ? text(`終了・書き込み ${r.writes}`, `returned · ${r.writes} writes`) : text('終了', 'returned'))
          : r.stop === 'timeout' ? text('時間切れ', 'timeout') : r.stop === 'error' ? text('エラー', 'error') : text('途中で停止', 'stopped');
        for (const r of rows) {
          const tr = h('tr');
          tr.append(h('td', 'mono', formatArgs(r.args)), h('td', 'mono', formatValue(r.out)), h('td', null, stopText(r)));
          body.append(tr);
        }
        table.append(body);
        const parts = [];
        if (rule) parts.push(h('p', 'ui-io-rule', text(`きまり（試した範囲）: ${rule}`, `Rule (tested inputs): ${rule}`)));
        parts.push(table);
        ioHost.replaceChildren(...parts);
      } catch (error) {
        if (!disposed && !ioSignal.aborted && !routeSignal.aborted) ioHost.replaceChildren(errorState(text('実行できませんでした', 'Could not run'), String(error?.message || error)));
      } finally {
        if (!disposed && !routeSignal.aborted) ioRun.disabled = false;
      }
    });
    io.body.append(ioRun, ioHost);
    root.append(io.root, c.root);

    const capability = card(text('実機のデバッガ', 'Live Debugger'), { subtitle: text('ブラウザだけでは、動いている iOS アプリに接続できません。実機での観測は、外部の Hex bridge に接続したときだけ使えます。', 'Safari cannot arbitrarily attach to an iOS process. LLDB/Frida-compatible live observation requires an external Hex bridge.') });
    capability.body.append(uiButton(text('デバッガを開く', 'Open advanced debugger'), { cls: 'ui-secondary-action', onClick: () => showDebugger(app, addr) }));
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
      if (viewCurrent() && !routeSignal.aborted) {
        if (isBinaryUnboundError(err) || !app.store?.get?.('fileInfo')) content.replaceChildren(renderBinaryUnboundCard(app));
        else content.replaceChildren(errorState(text('表示できませんでした', 'Could not render this view'), String(err && err.message || err)));
      }
    }
  })();

  return {
    root: s.root,
    getState: () => {
      const codeEl = content.querySelector('.ui-pseudocode');
      let selectedLineIndex = null;
      if (codeEl) {
        const lineNodes = codeEl.querySelectorAll('.ui-pseudocode-line');
        for (let i = 0; i < lineNodes.length; i++) {
          if (lineNodes[i].classList.contains('selected')) { selectedLineIndex = i; break; }
        }
      }
      return {
        scrollTop: s.body.scrollTop,
        bodyScrollTop: s.body.scrollTop,
        codeScrollTop: codeEl ? codeEl.scrollTop : 0,
        selectedLineIndex,
      };
    },
    restoreState: (state) => {
      if (!state) return;
      if (tab === 'pseudocode') applyPseudoState(state);
      else s.body.scrollTop = Number(state.bodyScrollTop ?? state.scrollTop) || 0;
    },
    dispose: () => {
      disposed = true;
      activeProvenanceView?.tokenHighlight?.destroy?.();
      activeProvenanceView = null;
      activeFallbackTokHl?.destroy?.();
      activeFallbackTokHl = null;
      activeFindBar = null;
      activeDecompileCleanup?.();
      activeDecompileCleanup = null;
      document.removeEventListener('hex:notes-attached', onNotesAttached);
      if (typeof unsubBookmarks === 'function') unsubBookmarks();
      if (typeof unsubNotes === 'function') unsubNotes();
      fallbackRouteController?.abort('function-workspace-disposed');
    },
  };
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
  if (!app.store?.get?.('fileInfo')) {
    s.body.append(emptyState(
      text('ファイルが開かれていません', 'No binary open'),
      text('バイナリを開いて自動解析を実行すると、見つかった結果と根拠がここに並びます。', 'Open a binary or try the sample to see analysis findings and evidence here.'),
      noFileActions(app),
    ));
    return { root: s.root };
  }
  const report = app.autoReport && app.autoReport.report;
  const findings = report && (report.findings || report.results || report.goals);
  let virtualList = null;
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
    if (findings.length > 80) { virtualList = new VirtualList({ items: findings, rowHeight: 64, ariaLabel: text('解析結果', 'Analysis results'), renderRow: renderFinding }); s.body.append(virtualList.root); }
    else {
      const list = h('div', 'ui-list');
      findings.forEach((item, index) => list.append(renderFinding(item, index)));
      s.body.append(list);
    }
  } else {
    s.body.append(emptyState(text('まだ確定した結果がありません', 'No confirmed results yet'), text('「調べる」で目的を入力すると、答えと根拠をここから辿れるようになります。', 'Investigate a goal to create results you can revisit.'), uiButton(text('調べるへ', 'Go to Investigate'), { cls: 'ui-primary-action', onClick: () => router.navigate('/investigate') })));
  }
  return { root: s.root, dispose: () => { virtualList?.dispose?.(); } };
}

function pickOneFile(accept='') {
  return new Promise((resolve) => {
    const input=document.createElement('input'); input.type='file'; input.accept=accept;
    input.style.position='fixed'; input.style.left='-10000px'; document.body.append(input);
    let settled=false;
    const onFocus=()=>{ setTimeout(()=>{ if(!settled) finish(input.files?.[0]||null); }, 300); };
    const finish=(file)=>{ if(settled)return; settled=true; window.removeEventListener('focus',onFocus); input.remove(); resolve(file||null); };
    input.addEventListener('change',()=>finish(input.files?.[0]||null),{once:true});
    input.addEventListener('cancel',()=>finish(null),{once:true});
    window.addEventListener('focus',onFocus,{once:true});
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
function exportReportFromProduct(app, format) {
  try { const { blob, name } = reportFile(app, format, { ja: ja() }); downloadBlob(blob, name); markMission(app, 'report'); toast(text('レポートを書き出しました。', 'Report exported.')); }
  catch (error) { toast(text('レポートを書き出せませんでした。', 'Could not export the report.')); console.error(error); }
}
async function importProjectFromProduct(app) {
  const file=await pickOneFile('.hexproj,application/json'); if(!file)return;
  try { await app.importProjectFile(file); toast(text('プロジェクトを復元しました。','Project restored.')); }
  catch(error){const mismatch=error?.code==='HEX_PROJECT_BINARY_MISMATCH';toast(mismatch?text('このプロジェクトは現在のバイナリ/スライス用ではありません。','This project belongs to a different binary or slice.'):text('プロジェクトを読み込めませんでした: ','Could not import project: ')+String(error?.message||error));}
}
async function exportDeltaFromProduct(app) {
  if (typeof app.exportDeltaJson !== 'function') { toast(text('差分セッション機能は利用できません。', 'Delta session export is unavailable.')); return; }
  try {
    const data = await app.exportDeltaJson();
    const filename = (data && typeof data === 'object' && typeof data.filename === 'string' && data.filename)
      ? data.filename
      : ((app.store.get('fileInfo')?.name || 'analysis') + '.hexdelta.json');
    const body = data instanceof Blob ? data : (data && typeof data === 'object' && typeof data.json === 'string' ? data.json : (typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
    const blob = body instanceof Blob ? body : new Blob([body], { type: 'application/json' });
    downloadBlob(blob, filename);
    toast(text('差分を書き出しました。', 'Delta exported.'));
  } catch (error) {
    toast(text('差分を書き出せませんでした: ', 'Could not export delta: ') + String(error?.message || error));
  }
}
function confirmActionDialog(title, message, confirmLabel, cancelLabel) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (settled) return; settled = true; resolve(value); };
    try {
      alertDialog(title, message, {
        confirmLabel,
        cancelLabel,
        onConfirm: () => done(true),
        onCancel: () => done(false),
      });
    } catch {
      done(typeof globalThis.confirm === 'function' ? globalThis.confirm(message) : false);
    }
  });
}

async function importDeltaFromProduct(app, router = null) {
  if (typeof app.importDeltaJson !== 'function') { toast(text('差分セッション機能は利用できません。', 'Delta session import is unavailable.')); return false; }
  const file = await pickOneFile('.json,application/json');
  if (!file) return false;
  try {
    const raw = await file.text();
    let res = await app.importDeltaJson(raw);
    if (res?.hashMismatch) {
      const importedName = String(res?.record?.fingerprint?.name || file.name || text('不明', 'unknown'));
      const importedHash = String(res?.record?.fingerprint?.sha256 || '').slice(0, 12) || '—';
      const currentName = String(app.store?.get?.('fileInfo')?.name || text('現在', 'current'));
      const currentHash = String(app._currentDeltaFingerprint?.()?.sha256 || app.store?.get?.('fileInfo')?.sha256 || '').slice(0, 12) || '—';
      const msg = text(
        `この差分は別のバイナリで作成されています。強制的に読み込みますか？\n\n差分: ${importedName} (${importedHash})\n現在: ${currentName} (${currentHash})`,
        `This delta was created for a different binary. Import anyway?\n\nDelta: ${importedName} (${importedHash})\nCurrent: ${currentName} (${currentHash})`,
      );
      const proceed = await confirmActionDialog(
        text('別のバイナリの差分です', 'Binary hash mismatch'),
        msg,
        text('強制的に読み込む', 'Import anyway'),
        text('キャンセル', 'Cancel'),
      );
      if (!proceed) {
        toast(text('差分の読み込みをキャンセルしました。', 'Delta import cancelled.'));
        return false;
      }
      res = await app.importDeltaJson(raw, { allowMismatch: true });
    }
    if (!res?.ok) {
      toast(text('差分を読み込めませんでした: ', 'Could not import delta: ') + String(res?.error || text('無効な差分ファイルです。', 'Invalid delta file.')));
      return false;
    }
    toast(text('差分を読み込みました。', 'Delta imported.'));
    const activeRouter = router || window.__hexUi?.router || null;
    if (activeRouter?.current?.fullPath) {
      if (activeRouter.current.route?.id === 'code') app.viewer?.render?.();
      else activeRouter._render(activeRouter.current.fullPath, { replace: true, restoredState: null });
    }
    return true;
  } catch (error) {
    toast(text('差分を読み込めませんでした: ', 'Could not import delta: ') + String(error?.message || error));
    return false;
  }
}
async function resetDeltaFromProduct(app) {
  if (typeof app.resetDeltaSession !== 'function') { toast(text('差分セッション機能は利用できません。', 'Delta session reset is unavailable.')); return false; }
  const confirmed = await confirmActionDialog(
    text('差分セッションをリセットしますか？', 'Reset delta session?'),
    text('このバイナリに自動保存されたブックマーク・名前・メモ・パッチの差分を削除します。この操作は元に戻せません。', 'This permanently deletes auto-saved bookmarks, renames, comments, and patch deltas for this binary. This cannot be undone.'),
    text('リセット', 'Reset'),
    text('キャンセル', 'Cancel'),
  );
  if (!confirmed) {
    toast(text('リセットをキャンセルしました。', 'Reset cancelled.'));
    return false;
  }
  try {
    await app.resetDeltaSession();
    toast(text('差分セッションをリセットしました。', 'Delta session reset.'));
    return true;
  } catch (error) {
    toast(text('差分セッションをリセットできませんでした: ', 'Could not reset delta session: ') + String(error?.message || error));
    return false;
  }
}

function renderDiff(app,router,routeContext = {}) {
  const s=screen(text('バイナリ差分','Binary Diff'),{id:'diff',subtitle:text('前のバージョンと現在のバージョンを関数単位で比較します。','Compare a previous version with the current binary at function granularity.')});
  const host=h('div','ui-stack');s.body.append(host);
  const fallbackRouteController=routeContext.signal?null:new AbortController();
  const routeSignal=routeContext.signal||fallbackRouteController.signal;
  const compareScope=createChildTaskScope(routeSignal);
  let virtual=null;
  const disposeVirtual=()=>{virtual?.dispose();virtual=null;};
  const renderContent=()=>{
    disposeVirtual();
    host.replaceChildren();
    if(!app.store.get('fileInfo')){host.append(emptyState(text('先に現在のバイナリを開いてください','Open the current binary first'),'',uiButton(text('コードへ','Go to Code'),{onClick:()=>router.navigate('/code')})));return;}
    const state=app.getBinaryDiff?.(); const baseline=app.workspace?.baseline;
    const controls=h('div','ui-actions');
    controls.append(uiButton(baseline?text('比較元を変更','Change baseline'):text('前のバージョンを選ぶ','Choose previous version'),{cls:'ui-primary-action',onClick:async()=>{
      const file=await pickOneFile();if(!file||routeSignal.aborted)return;
      const signal=compareScope.spawn('diff-baseline-replaced');
      disposeVirtual();
      host.replaceChildren(loadingState(text('比較元を解析しています…','Analysing baseline…')));
      try{
        await app.workspace.loadBaseline(file,{signal});
        await app.workspace.diff({signal});
        if(!signal.aborted&&!routeSignal.aborted)renderContent();
      } catch(error){if(!signal.aborted&&!routeSignal.aborted)host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}
    }}));
    if(baseline)controls.append(uiButton(text('再比較','Compare again'),{onClick:async()=>{
      const signal=compareScope.spawn('diff-rerun-replaced');
      disposeVirtual();
      host.replaceChildren(loadingState(text('比較しています…','Comparing…')));
      try{await app.workspace.diff({signal});if(!signal.aborted&&!routeSignal.aborted)renderContent();}
      catch(error){if(!signal.aborted&&!routeSignal.aborted)host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}
    }}));
    host.append(controls);
    if(!state){host.append(emptyState(text('比較元を選ぶと変更された関数を抽出します','Choose a baseline to find changed functions'),text('同じ CPU 向けのファイルどうしだけを比べます。比較が途中までのときは「新しい」「削除された」と決めつけません。','Only matching architectures/slices are compared; incomplete matching never invents new/deleted certainty.')));return;}
    const counts={same:0,moved:0,changed:0,rewritten:0,new:0,deleted:0,unresolved:0};
    for(const c of state.changes||[])counts[c.changeType]=(counts[c.changeType]||0)+1;
    const summary=card(text('比較結果','Diff summary'));
    summary.body.append(h('p','ui-body',text(`変更 ${counts.changed||0} · 書き直し ${counts.rewritten||0} · 移動 ${counts.moved||0} · 新規 ${counts.new||0} · 削除 ${counts.deleted||0} · 未確定 ${counts.unresolved||0}`,`${counts.changed||0} changed · ${counts.rewritten||0} rewritten · ${counts.moved||0} moved · ${counts.new||0} new · ${counts.deleted||0} deleted · ${counts.unresolved||0} unresolved`)));
    if (state.completeness?.complete) {
      summary.body.append(h('p', 'ui-sub', text('すべての関数を比較しました。', 'Function sets and matching are complete.')));
    } else {
      summary.body.append(statusNotice(state.completeness?.reasons || ['function-discovery-incomplete']));
    }
    host.append(summary.root);
    const interesting=(state.changes||[]).filter((c)=>c.changeType!=='same').slice(0,5000);
    const render=(c)=>{const current=c.after?.address??null;const previous=c.before?.address??null;const title=c.after?.name||c.before?.name||(current!=null?functionName(app,current):text('削除された関数','Deleted function'));const tags=c.semanticChange?.tags?.join(', ')||'';return listRow({title,subtitle:[c.changeType,current!=null?addressText(current):previous!=null?'old '+addressText(previous):'',tags].filter(Boolean).join(' · '),badge:evidenceBadge(c.changeType==='unresolved'?'unverified':c.confidence>=0.82?'confirmed':'likely'),onClick:current!=null?()=>router.navigate('/function/'+BigInt(current).toString()+'/overview'):null});};
    if(interesting.length>100){virtual=new VirtualList({items:interesting,rowHeight:64,ariaLabel:text('変更関数','Changed functions'),renderRow:render});host.append(virtual.root);}else{const list=h('div','ui-list');for(const c of interesting)list.append(render(c));host.append(list);}
  };
  renderContent();
  return {root:s.root,dispose:()=>{disposeVirtual();compareScope.abort('diff-route-disposed');fallbackRouteController?.abort('diff-route-disposed');}};
}

function renderAdvanced(app) {
  const s = screen(text('高度な機能', 'Advanced / Lab'), { id: 'advanced', subtitle: text('通常の調査では不要な低レベル機能だけをまとめています。', 'Low-level tools that are not required for the normal question-to-answer flow.') });
  const list = h('div', 'ui-list');
  list.append(listRow({ title: text('ファイル情報', 'File information'), onClick: () => requireFile(app, () => showFileInfo(app)) }));
  list.append(listRow({ title: text('セクション詳細', 'Section details'), onClick: () => requireFile(app, () => showSections(app)) }));
  list.append(listRow({ title: text('構造 / 生データ', 'Structure / raw data'), onClick: () => requireFile(app, () => showStructure(app)) }));
  list.append(listRow({ title: text('解析ツール一覧', 'Analysis tools'), subtitle: text('パッチ・スクリプト・プラグイン等', 'Patching, scripting, plugins, etc.'), onClick: () => requireFile(app, () => showTools(app)) }));
  list.append(listRow({ title:text('プロジェクトを書き出す (.hexproj)','Export project (.hexproj)'), subtitle:text('名前・メモ・型・パッチ・解析結果・AI調査・移動履歴を保存','Save names, notes, types, patches, findings, AI investigation and navigation'), onClick:()=>requireFile(app,()=>exportProjectFromProduct(app)) }));
  list.append(listRow({ title:text('プロジェクトを読み込む','Import project'), subtitle:text('いま開いているファイルと同じファイルのときだけ復元します','Restores only when binary hash and slice identity match'), onClick:()=>requireFile(app,()=>importProjectFromProduct(app)) }));
  list.append(listRow({ title:text('差分を書き出し (.json)','Export delta (.json)'), subtitle:text('ブックマーク・名前・メモの軽量差分を書き出します','Export lightweight delta of bookmarks, renames, and comments'), onClick:()=>requireFile(app,()=>exportDeltaFromProduct(app)) }));
  list.append(listRow({ title:text('差分を読み込み (.json)','Import delta (.json)'), subtitle:text('保存した差分 JSON を現在のバイナリに適用します','Apply a saved delta JSON file to the current binary'), onClick:()=>requireFile(app,()=>importDeltaFromProduct(app)) }));
  list.append(listRow({ title:text('差分セッションをリセット','Reset delta session'), subtitle:text('このバイナリに自動保存された差分を初期化します','Clear auto-saved delta session for this binary'), onClick:()=>requireFile(app,()=>resetDeltaFromProduct(app)) }));
  list.append(listRow({ title:text('バージョン差分','Binary Diff'), subtitle:text('前のバイナリと変更関数を比較','Compare changed functions against a previous binary'), onClick:()=>requireFile(app,()=>window.__hexUi?.router?.navigate('/diff')) }));
  s.body.append(list);
  return { root: s.root };
}

/*
 * Which producer made this pseudocode, and whether it is whole. The result
 * already carries both (value.semantic, completeness, warnings); the tab
 * used to show neither, so a fallback or a partial result looked identical
 * to a complete Semantic IR decompilation.
 */
const DECOMPILE_WARNING_TEXT = [
  [/^Semantic IR is explicitly truncated/, ['意味解析の範囲が途中で切れています。関数の後ろのほうは含まれていないことがあります。', 'The Semantic IR is truncated; later parts of the function may be missing.']],
  [/^Semantic IR covers (\d+)\/(\d+) Basic Blocks/, ['意味解析がすべての基本ブロックを扱えなかったため、簡易版の逆コンパイラで出しています。', 'Semantic IR did not cover every basic block, so the simpler fallback decompiler was used.']],
  [/^Semantic IR decompiler fallback/, ['意味解析の途中でエラーが出たため、簡易版の逆コンパイラで出しています。', 'Semantic IR failed, so the simpler fallback decompiler was used.']],
  [/^Semantic IR is unavailable/, ['この関数は意味解析ができないため、簡易版の逆コンパイラで出しています。', 'Semantic IR is unavailable, so the simpler fallback decompiler was used.']],
];

function decompileNotice(res) {
  const value = res?.value || {};
  const warnings = Array.isArray(value.warnings) ? value.warnings.map(String) : [];
  const partial = res?.completeness && res.completeness !== 'complete';
  const fallback = value.semantic === false;
  if (!partial && !fallback && !warnings.length) return null;
  const root = h('div', 'ui-decompile-notice');
  root.setAttribute('role', 'note');
  const lines = [];
  lines.push(fallback
    ? text('簡易版の逆コンパイラの結果です（意味解析の結果ではありません）。', 'Produced by the fallback decompiler, not the Semantic IR pipeline.')
    : text('意味解析（Semantic IR）の結果です。', 'Produced by the Semantic IR pipeline.'));
  if (partial) {
    const reason = res?.status?.reason;
    const mappedReason = reason ? reasonText(reason) : null;
    lines.push(mappedReason || text('一部だけの結果です。', 'Partial result.'));
  }
  for (const warning of warnings.slice(0, 6)) {
    const hit = DECOMPILE_WARNING_TEXT.find(([pattern]) => pattern.test(warning));
    if (hit) lines.push(text(hit[1][0], hit[1][1]));
  }
  for (const line of [...new Set(lines)]) root.append(h('p', null, line));
  if (warnings.length || res?.status?.reason) {
    const raw = h('details', 'ui-decompile-notice-raw');
    raw.append(h('summary', null, text('くわしい情報', 'Details')));
    raw.append(h('pre', 'mono', [res?.status?.reason ? `reason: ${res.status.reason}` : null, `completeness: ${res?.completeness ?? '—'}`, ...warnings].filter(Boolean).join('\n')));
    root.append(raw);
  }
  return root;
}

/*
 * The address bar used to be read-only text. Each part now does what it
 * shows: the address jumps, the section name switches sections, the function
 * name opens that function, and 検索 reaches instruction / byte / number
 * search, which had no entry point once the old toolbar buttons were retired.
 */
function addressIsMapped(app, addr) {
  try {
    const target = BigInt(addr);
    return (app.store.get('regions') || []).some((r) => r.size > 0n && target >= r.vmAddr && target < r.vmAddr + r.size);
  } catch { return false; }
}

function installAddressBar(app, router, addrbar) {
  if (!addrbar) return { refreshLanguage() {}, destroy() {} };
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const sigOpts = ac ? { signal: ac.signal } : undefined;
  const detachFns = [];
  const cur = addrbar.querySelector('#addr-cur');
  const regionLabel = addrbar.querySelector('#addr-region');
  const actionable = (node, label, onActivate) => {
    if (!node) return;
    node.classList.add('addr-action');
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.setAttribute('aria-label', label);
    node.title = label;
    const onKeyDown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onActivate(event); }
    };
    node.addEventListener('click', onActivate, sigOpts);
    node.addEventListener('keydown', onKeyDown, sigOpts);
    detachFns.push(() => {
      node.removeEventListener?.('click', onActivate);
      node.removeEventListener?.('keydown', onKeyDown);
    });
  };
  actionable(cur, text('アドレスへジャンプ', 'Jump to address'), () => requireFile(app, () => showJump(app)));
  actionable(regionLabel, text('区画を切り替える', 'Switch section'), (event) => requireFile(app, () => {
    const regions = (app.store.get('regions') || []).filter((r) => r.size > 0n);
    const current = app.store.get('currentRegion');
    const r = event.currentTarget.getBoundingClientRect();
    const items = [...regions].sort((a, b) => Number(!!b.exec) - Number(!!a.exec)).slice(0, 40).map((region) => ({
      label: (current?.id === region.id ? '✓ ' : '') + region.name + (region.exec ? '' : text('（データ）', ' (data)')),
      action: () => {
        app.selectRegion(region, { silent: true });
        router.navigate('/code/' + region.vmAddr.toString());
      },
    }));
    if (items.length) menu(items, r.left + r.width / 2, r.bottom + 4);
  }));

  const fn = uiButton('', { cls: 'addr-fn addr-action', ariaLabel: text('この関数を開く', 'Open this function') });
  fn.hidden = true;
  cur?.after(fn);
  const star = uiButton('☆', { cls: 'addr-star addr-action ui-star-btn', ariaLabel: text('ブックマークに追加', 'Bookmark address'), pressed: false });
  star.hidden = true;
  fn.after(star);
  let fnStart = null;
  let curAddr = null;
  const syncAddrStar = () => {
    if (curAddr == null) { star.hidden = true; return; }
    const saved = !!app.bookmarks?.has?.(curAddr);
    const lbl = bookmarkLabel(app, curAddr);
    star.textContent = saved ? '★' : '☆';
    star.setAttribute('aria-pressed', String(saved));
    star.setAttribute('aria-label', saved
      ? text(`${lbl} のブックマークを解除`, `Remove bookmark: ${lbl}`)
      : text(`${lbl} をブックマークに追加`, `Bookmark: ${lbl}`));
    star.title = `${lbl} (B)`;
    star.hidden = false;
  };
  const onStarClick = () => {
    if (curAddr == null) return;
    app.bookmarks?.toggle?.(curAddr, { name: bookmarkLabel(app, curAddr) });
    syncAddrStar();
  };
  star.addEventListener('click', onStarClick, sigOpts);
  detachFns.push(() => star.removeEventListener?.('click', onStarClick));
  const unsubAddrBookmarks = app.bookmarks?.subscribe?.(syncAddrStar) || null;
  const onFnClick = () => { if (fnStart != null) openAddressTarget(app, router, fnStart); };
  fn.addEventListener('click', onFnClick, sigOpts);
  detachFns.push(() => fn.removeEventListener?.('click', onFnClick));

  const pseudo = uiButton(text('疑似C', 'Pseudo-C'), {
    cls: 'addr-pseudo',
    ariaLabel: text('現在の関数を疑似Cで開く', 'Open current function as pseudocode'),
    onClick: () => requireFile(app, () => {
      const target = fnStart ?? currentFunctionAddr(app);
      if (target == null) {
        toast(text('この位置の関数を特定できませんでした。', 'Could not identify a function at this address.'));
        return;
      }
      const targetBig = BigInt(target);
      const query = curAddr != null && BigInt(curAddr) !== targetBig ? ('?addr=' + BigInt(curAddr).toString()) : '';
      if (curAddr != null) setSyncAddress(app, targetBig, curAddr);
      router.navigate('/function/' + targetBig.toString() + '/pseudocode' + query);
    }),
  });
  pseudo.hidden = true;
  pseudo.title = text('現在の関数を疑似Cで開く (Space)', 'Open current function as pseudocode (Space)');

  const search = uiButton(text('バイト検索', 'Find bytes'), {
    cls: 'addr-search',
    ariaLabel: text('命令・バイト列・数値を検索（コード内）', 'Search instructions, bytes, or numbers in code'),
    onClick: () => requireFile(app, () => showSearchPanel(app)),
  });
  search.title = text('命令・バイト列・数値を検索（コード内）', 'Search instructions, bytes, or numbers in code');
  addrbar.append(pseudo, search);

  const refreshLanguage = () => {
    const jumpLabel = text('アドレスへジャンプ', 'Jump to address');
    if (cur) { cur.setAttribute('aria-label', jumpLabel); cur.title = jumpLabel; }
    const sectionLabel = text('区画を切り替える', 'Switch section');
    if (regionLabel) { regionLabel.setAttribute('aria-label', sectionLabel); regionLabel.title = sectionLabel; }
    fn.setAttribute('aria-label', text('この関数を開く', 'Open this function'));
    syncAddrStar();
    const pseudoTitle = text('現在の関数を疑似Cで開く (Space)', 'Open current function as pseudocode (Space)');
    pseudo.textContent = text('疑似C', 'Pseudo-C');
    pseudo.setAttribute('aria-label', pseudoTitle);
    pseudo.title = pseudoTitle;
    const searchTitle = text('命令・バイト列・数値を検索（コード内）', 'Search instructions, bytes, or numbers in code');
    search.textContent = text('バイト検索', 'Find bytes');
    search.setAttribute('aria-label', searchTitle);
    search.title = searchTitle;
  };

  let frame = 0;
  const update = () => {
    frame = 0;
    const region = app.store.get('currentRegion');
    // Describe the focused line: the selected row while it is on screen,
    // otherwise the top line (what the bar showed before).
    const viewer = app.viewer;
    const row = app.store.get('selectedRow');
    let addr = null;
    if (row != null && row >= 0 && viewer?.rowAddress && typeof viewer.topRow === 'function') {
      const top = Number(viewer.topRow());
      const visible = Number(viewer.visibleRows?.() ?? 0);
      if (Number(row) >= top && Number(row) < top + visible) addr = viewer.rowAddress(row);
    }
    if (addr == null) addr = app.store.get('currentAddress') ?? null;
    curAddr = addr;
    if (addr != null && cur) cur.textContent = addrHex(addr);
    const sym = app.symbols;
    let start = null;
    if (addr != null && region?.exec && sym?.functionCount) {
      try { start = sym.functionAt?.(addr)?.start ?? sym.functionStartAt?.(addr) ?? null; } catch { start = null; }
    }
    fnStart = start;
    syncAddrStar();
    if (start == null) { fn.hidden = true; pseudo.hidden = true; return; }
    const offset = BigInt(addr) - BigInt(start);
    fn.textContent = functionName(app, start) + (offset > 0n ? '+0x' + offset.toString(16).toUpperCase() : '');
    fn.hidden = false;
    pseudo.hidden = false;
  };
  const scheduleUpdate = () => { if (!frame) frame = requestAnimationFrame(update); };
  const unsubscribe = app.store.subscribe((_state, patch) => {
    if (!patch || !('currentAddress' in patch || 'selectedRow' in patch || 'currentRegion' in patch || 'fileInfo' in patch)) return;
    scheduleUpdate();
  });
  let unsubAddrNotes = null;
  const bindAddrNotes = () => {
    if (typeof unsubAddrNotes === 'function') { unsubAddrNotes(); unsubAddrNotes = null; }
    unsubAddrNotes = app.notes?.subscribe?.(scheduleUpdate) || null;
  };
  bindAddrNotes();
  const onAddrNotesAttached = () => { bindAddrNotes(); scheduleUpdate(); };
  document.addEventListener('hex:notes-attached', onAddrNotesAttached);
  update();
  const destroy = () => {
    ac?.abort();
    for (const off of detachFns) off();
    unsubscribe();
    document.removeEventListener('hex:notes-attached', onAddrNotesAttached);
    if (typeof unsubAddrNotes === 'function') unsubAddrNotes();
    if (typeof unsubAddrBookmarks === 'function') unsubAddrBookmarks();
    if (frame) cancelAnimationFrame(frame);
    fn.remove();
    star.remove();
    pseudo.remove();
    search.remove();
  };
  return { refreshLanguage, destroy };
}

const symbolLookupCache = new WeakMap();

function getSymbolLookupEntry(sym) {
  const gen = sym.gen ?? 0;
  const renameEntries = sym.renames instanceof Map
    ? [...sym.renames.entries()]
    : (sym.renames && typeof sym.renames === 'object' ? Object.entries(sym.renames) : []);
  const renameSize = renameEntries.length;
  const cached = symbolLookupCache.get(sym);
  if (cached && cached.gen === gen && cached.renameSize === renameSize) return cached;

  const map = new Map();
  const exact = new Map();
  const addExact = (lower, addr) => {
    if (!lower || addr == null) return;
    let big;
    try { big = BigInt(addr); } catch { return; }
    let set = exact.get(lower);
    if (!set) { set = new Set(); exact.set(lower, set); }
    set.add(big);
  };
  const addAliases = (rawName, addr, overwrite = false, indexExact = true) => {
    const lower = String(rawName || '').trim().toLowerCase();
    if (!lower) return;
    if (indexExact) addExact(lower, addr);
    if (overwrite || !map.has(lower)) map.set(lower, addr);
    const stripped = lower.replace(/^(?:_|j_|imp_)+/, '');
    if (stripped && stripped !== lower && (overwrite || !map.has(stripped))) {
      map.set(stripped, addr);
    }
  };
  const renamedAddrs = new Set();
  for (const [addrKey, renameVal] of renameEntries) {
    if (!renameVal || !String(renameVal).trim()) continue;
    try { renamedAddrs.add(BigInt(addrKey)); } catch { /* ignore */ }
  }
  const names = Array.isArray(sym.names) ? sym.names : [];
  const addrs = (Array.isArray(sym.addrs) || ArrayBuffer.isView(sym.addrs)) ? sym.addrs : [];
  for (let i = 0; i < names.length && i < addrs.length; i++) {
    let isRenamed = false;
    if (renamedAddrs.size && addrs[i] != null) {
      try { isRenamed = renamedAddrs.has(BigInt(addrs[i])); } catch { isRenamed = false; }
    }
    addAliases(names[i], addrs[i], false, !isRenamed);
  }
  for (const [addrKey, renameVal] of renameEntries) {
    if (!renameVal || !String(renameVal).trim()) continue;
    try { addAliases(renameVal, BigInt(addrKey), true, true); } catch { /* ignore */ }
  }
  const entry = { gen, renameSize, map, exact };
  symbolLookupCache.set(sym, entry);
  return entry;
}

function getSymbolLookupMap(sym) {
  return getSymbolLookupEntry(sym).map;
}

function resolveUniqueExactSymbol(app, name, { requireFunction = false } = {}) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return { addr: null, ambiguous: false };
  const sym = app?.symbols;
  if (!sym) return { addr: null, ambiguous: false };
  const { exact } = getSymbolLookupEntry(sym);
  const candidates = wanted.startsWith('_') ? [wanted] : [wanted, '_' + wanted];
  for (const key of candidates) {
    const set = exact.get(key);
    if (!set || !set.size) continue;
    const matches = requireFunction ? [...set].filter((a) => isFunctionStart(app, a)) : [...set];
    if (!matches.length) continue;
    if (matches.length === 1) return { addr: matches[0], ambiguous: false };
    const fnMatches = requireFunction ? matches : matches.filter((a) => isFunctionStart(app, a));
    if (fnMatches.length === 1) return { addr: fnMatches[0], ambiguous: false };
    return { addr: null, ambiguous: true };
  }
  return { addr: null, ambiguous: false };
}

function symbolAddress(app, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  const sym = app?.symbols;
  if (sym) {
    const map = getSymbolLookupMap(sym);
    const hit = map.get(wanted);
    if (hit != null) return hit;
    const stripped = wanted.replace(/^(?:_|j_|imp_)+/, '');
    if (stripped && stripped !== wanted) {
      const strippedHit = map.get(stripped);
      if (strippedHit != null) return strippedHit;
    }
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
  // The full hint is cut off mid-word on a phone; use a shorter one there.
  const narrow = globalThis.matchMedia?.('(max-width: 599px)');
  const setPlaceholder = () => {
    input.placeholder = narrow?.matches
      ? text('検索・アドレス（? で AI）', 'Search, address, ? AI')
      : text('検索・アドレス・> コマンド・? AIに質問', 'Search, address, > command, ? ask AI');
  };
  setPlaceholder();
  narrow?.addEventListener?.('change', setPlaceholder);
  input.setAttribute('aria-label', text('検索と移動', 'Search and navigate'));
  input.autocomplete = 'off'; input.autocapitalize = 'off'; input.spellcheck = false;
  const hint = h('span', 'ui-command-hint');
  hint.setAttribute('aria-live', 'polite');
  const go = uiButton(text('実行', 'Go'), { cls: 'ui-command-go' });
  go.type = 'submit';
  const results = h('ul', 'ui-command-results');
  results.id = 'ui-command-results';
  results.setAttribute('role', 'listbox');
  results.setAttribute('aria-label', text('クイックジャンプ候補', 'Instant jump results'));
  results.hidden = true;
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', results.id);
  input.setAttribute('aria-expanded', 'false');
  form.append(input, hint, go, results);

  let dropdownItems = [];
  let activeIndex = -1;
  let dropdownTimer = 0;
  let dropdownSerial = 0;
  let dropdownController = null;

  const hideResults = () => {
    clearTimeout(dropdownTimer);
    dropdownController?.abort?.('dropdown-closed');
    dropdownController = null;
    dropdownItems = [];
    activeIndex = -1;
    results.hidden = true;
    results.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const setActiveIndex = (next) => {
    if (!dropdownItems.length) { activeIndex = -1; input.removeAttribute('aria-activedescendant'); return; }
    activeIndex = ((next % dropdownItems.length) + dropdownItems.length) % dropdownItems.length;
    const rows = results.children;
    for (let i = 0; i < rows.length; i++) {
      const selected = i === activeIndex;
      rows[i].setAttribute('aria-selected', String(selected));
      rows[i].classList.toggle('active', selected);
    }
    const activeRow = rows[activeIndex];
    if (activeRow?.id) input.setAttribute('aria-activedescendant', activeRow.id);
    activeRow?.scrollIntoView?.({ block: 'nearest' });
  };

  const openDropdownItem = (item, { toCode = false } = {}) => {
    if (!item) return;
    if (item.kind === 'command') {
      hideResults();
      input.blur();
      runCommand({ kind: 'command', command: item.command, value: item.command });
      return;
    }
    if (item.kind === 'investigate') {
      hideResults();
      input.blur();
      rememberQuery(item.query, app);
      if (item.goal) {
        if (typeof app.showCandidates === 'function') app.showCandidates(item.goal);
        else showCandidates(app, item.goal);
      } else {
        runInvestigation(app, item.query);
      }
      return;
    }
    if (item.addr == null) return;
    const addr = BigInt(item.addr);
    hideResults();
    input.blur();
    if (item.kind === 'recent') {
      router.navigate('/code/' + addr.toString());
      return;
    }
    if (toCode || item.kind === 'address') {
      if (app.goToAddress(addr, { announce: true })) router.navigate('/code/' + addr.toString());
      return;
    }
    if (item.kind === 'saved') {
      openAddressTarget(app, router, addr);
      return;
    }
    openAddressTarget(app, router, addr, { preferTab: 'pseudocode' });
  };

  const renderDropdown = (items, { autoSelectFirst = false } = {}) => {
    dropdownItems = items.slice(0, 10);
    activeIndex = -1;
    results.replaceChildren();
    if (!dropdownItems.length) {
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      return;
    }
    dropdownItems.forEach((item, idx) => {
      const li = h('li', 'ui-command-result');
      li.id = `ui-cmd-opt-${idx}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const left = h('span', 'ui-command-result-main');
      if (item.badge) left.append(h('span', 'ui-command-result-badge', item.badge));
      left.append(h('span', 'ui-command-result-title', item.title));
      if (item.note) left.append(h('span', 'ui-command-result-note', item.note));
      const rightText = (item.kind === 'command' || item.kind === 'investigate')
        ? String(item.subtitle || '')
        : (item.addr != null ? addressText(item.addr) : '');
      const right = h('span', 'ui-command-result-addr mono', rightText);
      li.append(left, right);
      li.addEventListener('mousedown', (event) => { event.preventDefault(); });
      li.addEventListener('click', (event) => {
        openDropdownItem(item, { toCode: event.shiftKey || item.kind === 'address' });
      });
      results.append(li);
    });
    const rect = input.getBoundingClientRect?.();
    if (rect && rect.bottom > 0) {
      results.style.setProperty('--ui-omnibox-top', `${Math.ceil(rect.bottom + 4)}px`);
    }
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (autoSelectFirst && dropdownItems.length > 0) setActiveIndex(0);
  };

  const recentNavEntries = () => {
    const navObj = app.navigation;
    const raw = typeof navObj?.entries === 'function' ? navObj.entries() : navObj?.entries;
    return Array.isArray(raw) ? raw : [];
  };

  const refreshDropdown = async () => {
    const serial = ++dropdownSerial;
    dropdownController?.abort?.('dropdown-superseded');
    dropdownController = null;
    if (document.activeElement !== input) return;
    const raw = input.value.trim();
    const intent = classifyOmnibox(raw);
    if (intent.kind === 'ai') { hideResults(); return; }
    if (intent.kind === 'command') {
      const cq = String(intent.value || '').trim().toLowerCase();
      const cmdItems = [];
      for (const cmd of COMMANDS) {
        if (!cq
          || cmd.id.toLowerCase().includes(cq)
          || cmd.ja.toLowerCase().includes(cq)
          || cmd.en.toLowerCase().includes(cq)
          || cmd.match.test(intent.value)) {
          cmdItems.push({
            kind: 'command',
            badge: '>',
            title: ja() ? cmd.ja : cmd.en,
            subtitle: '>' + cmd.id,
            command: cmd.id,
          });
        }
      }
      renderDropdown(cmdItems, { autoSelectFirst: true });
      return;
    }
    const out = [];
    const seen = new Set();
    const pushUnique = (entry) => {
      if (!entry || entry.addr == null || out.length >= 10) return;
      let key;
      try { key = BigInt(entry.addr).toString(); } catch { return; }
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ...entry, addr: BigInt(entry.addr) });
    };
    const clipNote = (val) => {
      const sVal = String(val || '').replace(/\s+/g, ' ').trim();
      return sVal.length > 44 ? sVal.slice(0, 43) + '…' : sVal;
    };

    if (!raw) {
      const saved = bookmarkListOf(app);
      for (const bm of saved.slice(0, 6)) {
        if (bm?.addr == null) continue;
        pushUnique({
          kind: 'saved',
          badge: '★',
          title: bm.name || bookmarkLabel(app, bm.addr),
          note: clipNote(bm.note),
          addr: bm.addr,
        });
      }
      const recents = recentNavEntries();
      for (let i = recents.length - 1; i >= 0 && out.length < 10; i--) {
        const entry = recents[i];
        const a = entry?.addr ?? entry?.address ?? entry;
        if (a == null) continue;
        try {
          const big = BigInt(a);
          pushUnique({
            kind: 'recent',
            badge: '↺',
            title: entry?.label || entry?.name || bookmarkLabel(app, big),
            addr: big,
          });
        } catch { /* ignore */ }
      }
      renderDropdown(out, { autoSelectFirst: false });
      return;
    }

    const parsed = parseAddressInput(app, raw, { allowBareSymbol: false });
    if (parsed != null) {
      pushUnique({ kind: 'address', badge: '→', title: bookmarkLabel(app, parsed), addr: parsed });
    }
    const ql = raw.toLowerCase();
    for (const bm of bookmarkListOf(app)) {
      if (out.length >= 10) break;
      if (bm?.addr == null) continue;
      const tags = Array.isArray(bm?.tags) ? bm.tags.join(' ') : String(bm?.tag || '');
      const hay = [bm?.name, bm?.note, tags, addressText(bm.addr)].filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(ql)) {
        pushUnique({
          kind: 'saved',
          badge: '★',
          title: bm.name || bookmarkLabel(app, bm.addr),
          note: clipNote(bm.note),
          addr: bm.addr,
        });
      }
    }
    if (app.store?.get?.('fileInfo') && out.length < 10) {
      const controller = new AbortController();
      dropdownController = controller;
      try {
        const fns = await matchingFunctionItems(app, raw, { limit: 1000, signal: controller.signal });
        if (serial !== dropdownSerial || controller.signal.aborted || document.activeElement !== input) return;
        const len = Number(fns?.length || 0);
        const rawFns = [];
        for (let i = 0; i < len; i++) {
          const item = Array.isArray(fns) ? fns[i] : fns.itemAt?.(i);
          if (item?.addr != null) {
            const name = item.name || functionName(app, item.addr);
            rawFns.push({ name, addr: item.addr, score: scoreSearchMatch(name, raw) });
          }
        }
        const rankedFns = rankSearchResults(rawFns, raw, (it) => it.name);
        const orderedFns = rankedFns.length ? rankedFns : rawFns;
        for (const item of orderedFns) {
          if (out.length >= 10) break;
          pushUnique({ kind: 'function', badge: '', title: item.name, addr: item.addr });
        }
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }
    if (serial !== dropdownSerial || document.activeElement !== input) return;
    if (raw && app.store?.get?.('fileInfo') && parsed == null) {
      const goalMatch = matchGoalForQuery(raw);
      if (goalMatch) {
        out.unshift({
          kind: 'investigate',
          badge: '◎',
          title: goalMatch.actionLabel,
          subtitle: text('目的', 'Goal'),
          query: raw,
          goal: goalMatch.goal,
        });
      } else {
        const compiled = compileGoal(raw);
        if (compiled?.goal) {
          out.push({
            kind: 'investigate',
            badge: '◎',
            title: text(`「${raw}」を自動解析で探す`, `Auto-investigate "${raw}"`),
            subtitle: text('自動解析', 'Auto'),
            query: raw,
          });
        }
      }
    }
    renderDropdown(out, { autoSelectFirst: Boolean(raw) });
  };

  const scheduleDropdown = () => {
    clearTimeout(dropdownTimer);
    if (!input.value.trim()) { void refreshDropdown(); return; }
    dropdownTimer = setTimeout(() => { void refreshDropdown(); }, 80);
  };

  const refreshHint = () => {
    const intent = classifyOmnibox(input.value);
    hint.textContent = intent.kind === 'empty' ? '' : intentLabel(intent.kind, ja());
    form.dataset.intent = intent.kind;
  };
  input.addEventListener('input', () => { dropdownItems = []; activeIndex = -1; refreshHint(); scheduleDropdown(); });
  input.addEventListener('focus', () => { scheduleDropdown(); });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      if (!results.hidden) { event.preventDefault(); hideResults(); }
      else { input.blur(); }
      return;
    }
    if (event.key === 'Tab') {
      if (!results.hidden) hideResults();
      return;
    }
    if (results.hidden || !dropdownItems.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(activeIndex < 0 ? 0 : activeIndex + 1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(activeIndex < 0 ? dropdownItems.length - 1 : activeIndex - 1); return; }
    if (event.key === 'Enter' && activeIndex >= 0 && dropdownItems[activeIndex]) {
      event.preventDefault();
      const chosen = dropdownItems[activeIndex];
      openDropdownItem(chosen, { toCode: event.shiftKey || chosen.kind === 'address' });
    }
  });
  const onDocPointerDown = (event) => {
    if (!form.contains(event.target)) hideResults();
  };
  document.addEventListener('pointerdown', onDocPointerDown);

  const runCommand = (intent) => {
    switch (intent.command) {
      case 'code': router.navigate('/code'); return true;
      case 'explorer': router.navigate('/explorer/functions'); return true;
      case 'results': router.navigate('/results'); return true;
      case 'settings': router.navigate('/settings'); return true;
      case 'help': router.navigate('/help'); return true;
      case 'learn': router.navigate('/learn'); return true;
      case 'advanced': router.navigate('/advanced'); return true;
      case 'search': requireFile(app, () => showSearchPanel(app)); return true;
      case 'jump': requireFile(app, () => showJump(app)); return true;
      case 'patch': requireFile(app, () => showPatches(app)); return true;
      case 'export': requireFile(app, () => exportProjectFromProduct(app)); return true;
      case 'import': requireFile(app, () => importProjectFromProduct(app)); return true;
      case 'diff': router.navigate('/diff'); return true;
      case 'pseudocode': requireFile(app, () => {
        const target = currentFunctionAddr(app);
        if (target != null) router.navigate('/function/' + BigInt(target).toString() + '/pseudocode');
        else toast(text('この位置の関数を特定できませんでした。', 'Could not identify a function at this address.'));
      }); return true;
      case 'investigate': router.navigate('/investigate'); return true;
      case 'ai': getAssistant()?.open(); return true;
      case 'agent': getAssistant()?.open({ mode: 'agent' }); return true;
      default: return false;
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    hideResults();
    const intent = classifyOmnibox(input.value);
    if (intent.kind === 'empty') return;
    input.blur();
    if (intent.kind === 'ai') {
      const explicitAi = /^[?？]/.test(String(intent.raw || '').trim());
      const assistant = getAssistant();
      if (!explicitAi && app.store?.get?.('fileInfo')) {
        const compiled = compileGoal(intent.value);
        if (compiled?.goal) {
          rememberQuery(intent.value, app);
          runInvestigation(app, intent.value);
          input.value = '';
          refreshHint();
          return;
        }
      }
      if (assistant) { assistant.ask(intent.value); input.value = ''; refreshHint(); return; }
      router.navigate('/investigate?q=' + encodeURIComponent(intent.value));
      return;
    }
    if (intent.kind === 'command') {
      if (runCommand(intent)) return;
      toast(text(`不明なコマンドです: >${intent.value}`, `Unknown command: >${intent.value}`));
      return;
    }
    if (intent.kind === 'address') {
      const addr = parseAddressInput(app, intent.value);
      // Navigate only when the address exists; a failed jump already explained why.
      if (addr != null) { if (app.goToAddress(addr, { announce: true })) router.navigate('/code/' + addr.toString()); return; }
    }
    if (intent.kind === 'string') {
      router.navigate('/explorer/strings?q=' + encodeURIComponent(intent.value));
      return;
    }
    if (intent.kind === 'symbol' || intent.kind === 'search') {
      const exact = resolveUniqueExactSymbol(app, intent.value, { requireFunction: intent.kind !== 'symbol' });
      if (exact.addr != null && (intent.kind === 'symbol' || isFunctionStart(app, exact.addr))) {
        openAddressTarget(app, router, exact.addr, { preferTab: 'pseudocode' });
        return;
      }
      if (!exact.ambiguous && intent.kind === 'symbol') {
        const addr = symbolAddress(app, intent.value);
        if (addr != null) { openAddressTarget(app, router, addr, { preferTab: 'pseudocode' }); return; }
      }
    }
    router.navigate('/explorer/functions?q=' + encodeURIComponent(intent.value));
  });
  host.append(form);
  actions.register('command.focus', () => { input.focus(); input.select(); });
  const refreshLanguage = () => {
    setPlaceholder();
    input.setAttribute('aria-label', text('検索と移動', 'Search and navigate'));
    results.setAttribute('aria-label', text('クイックジャンプ候補', 'Instant jump results'));
    go.textContent = text('実行', 'Go');
    refreshHint();
  };
  const destroy = () => {
    hideResults();
    document.removeEventListener('pointerdown', onDocPointerDown);
    narrow?.removeEventListener?.('change', setPlaceholder);
    form.remove();
  };
  return { input, refreshLanguage, destroy };
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
  const navCanBack = () => !!(app.navigation?.canBack ?? app.navigation?.snapshot?.()?.canBack);
  const navCanForward = () => !!(app.navigation?.canForward ?? app.navigation?.snapshot?.()?.canForward);
  const canGoBack = () => router.canBack() || (router.current?.route?.id === 'code' && navCanBack());
  const canGoForward = () => router.canForward() || (router.current?.route?.id === 'code' && navCanForward());
  const goBack = () => {
    if (router.canBack()) return router.back();
    if (router.current?.route?.id === 'code' && navCanBack()) {
      const ok = !!app.navigation?.back?.();
      syncNavButtons();
      return ok;
    }
    return false;
  };
  const goForward = () => {
    if (router.canForward()) return router.forward();
    if (router.current?.route?.id === 'code' && navCanForward()) {
      const ok = !!app.navigation?.forward?.();
      syncNavButtons();
      return ok;
    }
    return false;
  };
  const openHistoryMenu = (event, direction) => {
    const raw = router.historyEntries?.();
    const entries = Array.isArray(raw)
      ? raw
      : (direction < 0 ? raw?.back : raw?.forward);
    if (!Array.isArray(entries) || !entries.length) return;
    event.preventDefault();
    const curDepth = Number.isSafeInteger(router.depth) ? router.depth : 0;
    const normalized = entries.map((e) => {
      const delta = Number.isSafeInteger(e?.delta)
        ? e.delta
        : (Number.isSafeInteger(e?.depth) ? e.depth - curDepth : 0);
      return { delta, label: e?.label || e?.path || String(delta) };
    }).filter((e) => (direction < 0 ? e.delta < 0 : e.delta > 0));
    if (!normalized.length) return;
    normalized.sort((a, b) => (direction < 0 ? b.delta - a.delta : a.delta - b.delta));
    const r = event.currentTarget.getBoundingClientRect();
    menu(normalized.slice(0, 15).map((e) => ({
      label: e.label,
      action: () => { router.capture?.(); history.go(e.delta); },
    })), r.left + r.width / 2, r.bottom + 4);
  };

  const backBtn = uiButton(text('← 戻る', '← Back'), {
    cls: 'ui-chrome-back',
    ariaLabel: text('前の画面へ戻る', 'Go back'),
    onClick: () => goBack(),
  });
  backBtn.title = text('前の画面へ戻る (Alt+← / Esc)', 'Go back (Alt+Left / Esc)');
  backBtn.hidden = true;
  backBtn.addEventListener('contextmenu', (e) => openHistoryMenu(e, -1));
  const forwardBtn = uiButton('→', {
    cls: 'ui-chrome-forward',
    ariaLabel: text('次の画面へ進む', 'Go forward'),
    onClick: () => goForward(),
  });
  forwardBtn.title = text('次の画面へ進む (Alt+→)', 'Go forward (Alt+Right)');
  forwardBtn.hidden = true;
  forwardBtn.addEventListener('contextmenu', (e) => openHistoryMenu(e, 1));
  chrome.append(backBtn, forwardBtn, nav);

  const syncNavButtons = () => {
    backBtn.hidden = !canGoBack();
    forwardBtn.hidden = !canGoForward();
    const backDest = router.backLabel?.() || '';
    const fwdDest = router.forwardLabel?.() || '';
    backBtn.title = backDest
      ? text(`戻る: ${backDest} (Alt+← / Esc)`, `Back: ${backDest} (Alt+Left / Esc)`)
      : text('前の画面へ戻る (Alt+← / Esc)', 'Go back (Alt+Left / Esc)');
    forwardBtn.title = fwdDest
      ? text(`進む: ${fwdDest} (Alt+→)`, `Forward: ${fwdDest} (Alt+Right)`)
      : text('次の画面へ進む (Alt+→)', 'Go forward (Alt+Right)');
  };

  const deltaStrip = h('div', 'ui-delta-strip');
  deltaStrip.setAttribute('role', 'status');
  deltaStrip.hidden = true;
  const deltaText = h('span', 'ui-delta-strip-text');
  const deltaActions = h('div', 'ui-delta-strip-actions');
  const deltaExportBtn = uiButton(text('差分を書き出し (.json)', 'Export delta (.json)'), { cls: 'ui-secondary-action ui-delta-btn', onClick: () => requireFile(app, () => exportDeltaFromProduct(app)) });
  const deltaImportBtn = uiButton(text('差分を読み込み (.json)', 'Import delta (.json)'), { cls: 'ui-secondary-action ui-delta-btn', onClick: () => requireFile(app, () => importDeltaFromProduct(app, router)) });
  const deltaResetBtn = uiButton(text('リセット', 'Reset'), { cls: 'ui-secondary-action ui-delta-btn', onClick: async () => { const ok = await resetDeltaFromProduct(app); if (ok) { deltaDismissed = true; deltaStrip.hidden = true; } } });
  const deltaDismissBtn = uiButton('×', { cls: 'ui-icon-action ui-delta-dismiss', ariaLabel: text('閉じる', 'Dismiss'), onClick: () => { deltaDismissed = true; deltaStrip.hidden = true; } });
  deltaActions.append(deltaExportBtn, deltaImportBtn, deltaResetBtn, deltaDismissBtn);
  deltaStrip.append(deltaText, deltaActions);
  chrome.after(deltaStrip);
  const landingHost = h('div', 'ui-quickstart-host');
  landingHost.hidden = true;
  deltaStrip.after(landingHost);
  let landingDismissed = false;
  let deltaDismissed = false;
  let lastDeltaToken = null;
  let appliedDeltaRouteToken = null;
  let userNavigatedSinceFileOpen = false;
  const syncLandingCard = () => {
    const onBareCode = router?.current?.route?.id === 'code' && !router?.current?.params?.address;
    const hasFile = !!app.store?.get?.('fileInfo');
    if (!onBareCode || !hasFile || userNavigatedSinceFileOpen || landingDismissed) {
      landingHost.hidden = true;
      landingHost.replaceChildren();
      return;
    }
    landingHost.replaceChildren(buildInitialLandingCard(app, router, {
      onDismiss: () => {
        landingDismissed = true;
        landingHost.hidden = true;
        landingHost.replaceChildren();
      },
    }));
    landingHost.hidden = false;
  };
  const resolveRestoredRoutePath = (rawPath) => {
    const path = String(rawPath || '').trim();
    if (!path || !path.startsWith('/')) return null;
    const fnMatch = /^\/function\/([^/?#]+)(?:\/([^/?#]+))?/.exec(path);
    if (fnMatch) {
      let big;
      try { big = BigInt(fnMatch[1]); } catch { return null; }
      const verified = app.validatedFunctionRange?.(big);
      if (!isFunctionStart(app, big) || (verified && !verified.ok)) {
        return '/code/' + big.toString();
      }
    }
    return path;
  };
  const syncDeltaStrip = () => {
    const info = app.lastDeltaRestore ?? app.store?.get?.('deltaRestored') ?? null;
    if (!info) { deltaStrip.hidden = true; return; }
    if (info !== lastDeltaToken) { lastDeltaToken = info; deltaDismissed = false; }
    if (info.restoredRoutePath && info !== appliedDeltaRouteToken && !userNavigatedSinceFileOpen && router?.started) {
      appliedDeltaRouteToken = info;
      const targetPath = resolveRestoredRoutePath(info.restoredRoutePath);
      if (targetPath && router.current?.fullPath !== targetPath) {
        router.navigate(targetPath, { replace: true });
      }
    }
    syncNavButtons();
    if (deltaDismissed) { deltaStrip.hidden = true; return; }
    const count = deltaCountOf(info);
    if (count <= 0) { deltaStrip.hidden = true; return; }
    deltaText.textContent = text(`前回の続きを復元 (${count}件の差分)`, `Restored previous session (${count} changes)`);
    deltaStrip.hidden = false;
  };

  let lastRouteId = null;
  let autoHexForData = false;
  let routingCodeAddress = false;
  const router = new ProductRouter(ROUTES, {
    /*
     * Code first, including before a file exists: the landing state is the
     * workbench with its compact open/sample card, not a question screen that
     * has nothing to answer questions about yet.
     */
    defaultPath: '/code',
    /*
     * Moving to another screen closes what floated over the old one. A sheet
     * opened on Code (an instruction's detail, say) used to stay on top of
     * Explorer or Investigate after Back or a screen change and swallowed
     * every tap there. Same-screen changes (/code → /code/:address, one
     * function tab to another) keep their sheets; sheets opened after the
     * change (the sample guide) are not affected.
     */
    onState: ({ current }) => {
      const id = current?.route?.id || null;
      if (lastRouteId != null && id !== lastRouteId) { closeMenu(); closeAllSheets(); }
      lastRouteId = id;
      syncNavButtons();
    },
    onRoute: (route, routeContext = {}) => {
      if (!routeContext.replace && !routeContext.historyNavigation && route.fullPath !== '/code') {
        userNavigatedSinceFileOpen = true;
      }
      appRoot.classList.toggle('ui-code-route', route.route.id === 'code');
      appRoot.classList.toggle('ui-screen-route', route.route.id !== 'code');
      const activeNavId = route.route.id === 'finding' ? 'results' : route.route.id;
      for (const b of nav.querySelectorAll('[data-route-id]')) b.setAttribute('aria-current', b.dataset.routeId === activeNavId ? 'page' : 'false');
      if (route.route.id === 'code') {
        updateScreenTitle(null);
        const raw = route.params.address;
        if (raw && !app.store?.get?.('fileInfo')) {
          landingHost.hidden = true;
          landingHost.replaceChildren();
          routeHost.hidden = false;
          const s = screen(text('コード', 'Code'), { id: 'code', subtitle: addressText(raw) });
          s.body.append(renderBinaryUnboundCard(app));
          routeHost.replaceChildren(s.root);
          syncRouteNavigation(app, router, route, routeContext);
          return { root: s.root };
        }
        routeHost.hidden = true;
        if (raw) {
          userNavigatedSinceFileOpen = true;
          routingCodeAddress = true;
          try {
            const target = BigInt(raw);
            const region = (app.store.get('regions') || []).find((r) => r.size > 0n && target >= r.vmAddr && target < r.vmAddr + r.size);
            /* Data (a string, a constant) is not code: show its bytes in Hex
               instead of disassembling it into meaningless instructions. */
            if (region && !region.exec) {
              if (app.store.get('currentRegion')?.id !== region.id) app.selectRegion(region, { silent: true });
              if (app.store.get('displayMode') !== 'hex') { app.setMode?.('hex'); autoHexForData = true; }
              app.goToAddress(target, { announce: true, history: false });
            } else {
              // Leaving data we switched to Hex for: back to assembly for code.
              if (autoHexForData && region?.exec) { app.setMode?.('asm'); autoHexForData = false; }
              if (app.goToAddress(target, { announce: false, history: false })) {
                // Select the requested line so the address bar and the next
                // action refer to it, not to whatever is at the top.
                const row = app.viewer?.rowOfAddress?.(target);
                if (row != null) { app.viewer.select(row, false); app.store.set({ selectedRow: row }); }
              }
            }
          } catch { /* invalid deep link */ } finally { routingCodeAddress = false; }
        }
        syncRouteNavigation(app, router, route, routeContext);
        syncLandingCard();
        return codeViewState(app);
      }
      landingHost.hidden = true;
      landingHost.replaceChildren();
      routeHost.hidden = false;
      routeHost.replaceChildren();
      let view;
      if (route.route.id === 'investigate') view = renderInvestigate(app, router, route, routeContext);
      else if (route.route.id === 'explorer') view = renderExplorer(app, router, route, routeContext);
      else if (route.route.id === 'function') view = renderFunctionWorkspace(app, router, route, routeContext);
      else if (route.route.id === 'results' || route.route.id === 'finding') view = renderResults(app, router, route);
      else if (route.route.id === 'diff') view = renderDiff(app, router, routeContext);
      else if (route.route.id === 'advanced') view = renderAdvanced(app);
      else view = renderSecondaryRoute(app, router, route, routeContext);
      routeHost.append(view.root);
      updateScreenTitle(view.root);
      syncRouteNavigation(app, router, route, routeContext);
      requestAnimationFrame(() => routeHost.focus({ preventScroll: true }));
      const originalGet = view.getState;
      return {
        ...view,
        getState: () => ({ ...(originalGet ? originalGet() : {}), routeScroll: routeHost.scrollTop }),
        restoreState: (state) => { view.restoreState?.(state); routeHost.scrollTop = Number(state?.routeScroll) || 0; },
      };
    },
  });
  const unsubDeltaStore = app.store?.subscribe?.((_state, patch) => {
    if (!patch || 'deltaRestored' in patch || 'fileInfo' in patch) syncDeltaStrip();
    if (!patch || 'fileInfo' in patch || 'symbolsReady' in patch || 'symbolsGen' in patch) syncLandingCard();
  }) || null;
  syncDeltaStrip();

  let assistant = null;
  const originalSelectSlice = typeof app.selectSlice === 'function' ? app.selectSlice.bind(app) : null;
  if (originalSelectSlice) {
    app.selectSlice = async (...args) => {
      const beforeEpoch = app.backend?.gen;
      const result = await originalSelectSlice(...args);
      if (app.backend?.gen !== beforeEpoch) {
        userNavigatedSinceFileOpen = false;
        landingDismissed = false;
        appliedDeltaRouteToken = null;
        router.navigate('/code', { replace: true });
        assistant?.refresh();
        assistant?.collapse();
      }
      return result;
    };
  }
  /*
   * A user-requested jump (goToAddress with announce, which goToFunction and
   * the sheets' "go there" rows use) moves the code view. When it came from a
   * sheet opened on another screen, the move happened behind that screen and
   * looked like nothing happened. Bring Code forward after such a jump.
   */
  const originalGoToAddress = typeof app.goToAddress === 'function' ? app.goToAddress : null;
  if (originalGoToAddress) {
    app.goToAddress = function goToAddressAndShowCode(addr, options = {}) {
      // Route user-requested jumps through ProductRouter even when already on /code
      // so browser Back/Forward and App.navigation stay unified.
      if (options?.history !== false && !routingCodeAddress && router.current && addressIsMapped(app, addr)) {
        try {
          const targetBig = BigInt(addr);
          if (router.navigate('/code/' + targetBig.toString(), { forcePush: true })) {
            if (options?.announce) this.flash?.(targetBig);
            return true;
          }
        } catch { /* fall through */ }
      }
      return originalGoToAddress.call(this, addr, options);
    };
  }
  const commandCenter = installCommandCenter(app, router, actions, chrome, () => assistant);
  const more = uiButton('•••', { cls: 'ui-more-button', ariaLabel: text('その他', 'More'), onClick: (event) => {
    const r = event.currentTarget.getBoundingClientRect();
    menu([
      { label: text('パッチ（命令の書き換え）', 'Patch instructions'), action: () => requireFile(app, () => showPatches(app)) },
      { label: text('レポートを書き出す (HTML)', 'Export report (HTML)'), action: () => requireFile(app, () => exportReportFromProduct(app, 'html')) },
      { label: text('レポートを書き出す (Markdown)', 'Export report (Markdown)'), action: () => requireFile(app, () => exportReportFromProduct(app, 'md')) },
      { label: text('プロジェクトを書き出す (.hexproj)', 'Export project (.hexproj)'), action: () => requireFile(app, () => exportProjectFromProduct(app)) },
      { label: text('プロジェクトを読み込む', 'Import project'), action: () => requireFile(app, () => importProjectFromProduct(app)) },
      '-',
      { label: text('設定', 'Settings'), action: () => router.navigate('/settings') },
      { label: text('学ぶ', 'Learn'), action: () => router.navigate('/learn') },
      { label: text('ヘルプ', 'Help'), action: () => router.navigate('/help') },
      '-',
      { label: text('高度な機能', 'Advanced / Lab'), action: () => router.navigate('/advanced') },
    ], r.left + r.width / 2, r.bottom + 4);
  } });
  chrome.append(more);

  for (const item of PRIMARY_NAV) {
    const navLabel = !ja() && item.labelEn ? item.labelEn : item.label;
    const b = uiButton(item.icon + '\n' + navLabel, { cls: 'ui-nav-item', onClick: () => router.navigate(item.route) });
    b.dataset.routeId = item.routeId;
    nav.append(b);
  }
  actions.register('navigate.investigate', () => router.navigate('/investigate'));
  actions.register('navigate.code', () => router.navigate('/code/' + (currentAddress(app)?.toString() || '')));
  actions.register('navigate.explorer', () => router.navigate('/explorer/functions'));
  actions.register('navigate.results', () => router.navigate('/results'));
  actions.register('function.label', (addr) => functionName(app, BigInt(addr)));
  actions.register('function.open', (addr, tab) => openAddressTarget(app, router, addr, { preferTab: tab }));

  const cleanupViewport = installViewportBridge();
  const addressBar = installAddressBar(app, router, appRoot.querySelector('.addrbar'));
  const prevJumpTarget = app.viewer ? app.viewer.onJumpTarget : null;
  if (app.viewer) {
    app.viewer.onJumpTarget = (targetAddr) => {
      if (targetAddr == null) return;
      const addr = BigInt(targetAddr);
      if (!router.navigate('/code/' + addr.toString())) {
        app.goToAddress(addr, { announce: true });
      }
    };
  }
  const shortcut = (event) => {
    const target = event.target;
    const tag = target?.tagName || '';
    const typing = !!(target && (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || target.isContentEditable));
    const key = String(event.key || '').toLowerCase();
    if ((event.metaKey || event.ctrlKey) && (key === 'k' || key === 'g')) { event.preventDefault(); actions.run('command.focus'); return; }
    if ((event.metaKey || event.ctrlKey) && key === 'f') {
      const curRoute = router.current;
      if (curRoute?.route?.id === 'function' && curRoute?.params?.tab === 'pseudocode') {
        const screenRoot = routeHost.querySelector('[data-screen="function"]');
        if (typeof screenRoot?._openPseudocodeFind === 'function') {
          event.preventDefault();
          screenRoot._openPseudocodeFind();
          return;
        }
      }
    }
    if (typing) return;
    const hasOverlay = !!Boolean(document.getElementById('overlays')?.querySelector('.sheet, .menu, .dialog') || document.querySelector('.menu, .dialog'));
    if (!hasOverlay && (event.metaKey || event.ctrlKey) && !event.altKey) {
      if (key === 'z') {
        if (event.shiftKey) {
          if (typeof app.redoEdit === 'function') { event.preventDefault(); app.redoEdit(); return; }
        } else if (typeof app.undoEdit === 'function') {
          event.preventDefault(); app.undoEdit(); return;
        }
      } else if (event.ctrlKey && !event.metaKey && key === 'y' && typeof app.redoEdit === 'function') {
        event.preventDefault(); app.redoEdit(); return;
      }
    }
    if (!hasOverlay && ((event.altKey && event.key === 'ArrowLeft') || (event.metaKey && event.key === '['))) { event.preventDefault(); goBack(); return; }
    if (!hasOverlay && ((event.altKey && event.key === 'ArrowRight') || (event.metaKey && event.key === ']'))) { event.preventDefault(); goForward(); return; }
    if (event.key === 'Escape' && !hasOverlay && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const aiOpen = !!(assistant?.isOpen?.() || uiRoot()?.classList.contains('ai-open'));
      const hasRangeMode = !!app.viewer?.rangeMode;
      const hasTokHit = !!document.querySelector('.tok-hit');
      const openFindBar = document.querySelector('.ui-pseudocode-find:not([hidden])');
      if (openFindBar) {
        openFindBar.querySelector('.ui-find-close')?.click();
        event.preventDefault();
        return;
      }
      if (!aiOpen && !hasRangeMode && !hasTokHit && canGoBack()) {
        event.preventDefault();
        goBack();
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && key === 'z' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && app?.v6) {
      if (event.shiftKey ? app.v6.typeTx?.canRedo?.() : app.v6.typeTx?.canUndo?.()) {
        event.preventDefault();
        if (event.shiftKey) app.v6.redoTypeEdit();
        else app.v6.undoTypeEdit();
        return;
      }
    }
    if (hasOverlay || event.metaKey || event.ctrlKey || event.altKey) return;
    const interactiveControl = !!(target && (
      /^(BUTTON|A|SUMMARY)$/.test(tag)
      || (target.closest?.('button, a, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="listbox"]')
        && !target.closest?.('.ui-pseudocode-line'))
      || target.closest?.('.tok-fn-link, .tok-addr-link')
    ));
    if (event.key === '?') {
      if (key === 'y' && !event.shiftKey && target?.closest?.('.tok-fn-link, .tok-addr-link, [data-entity-kind]') && app?.v6) {
      event.preventDefault();
      const tokEl = target.closest('.tok-fn-link, .tok-addr-link, [data-entity-kind]');
      const tokName = tokEl.getAttribute('data-tok') || tokEl.textContent?.trim() || '';
      const tokAddr = symbolAddress(app, tokName) ?? currentFunctionAddr(app) ?? currentAddress(app);
      app.v6.openTypeEditPopover({ va: tokAddr, name: tokName, kind: tokEl.getAttribute('data-entity-kind') || 'function' });
      return;
    }
    if (interactiveControl) return;
      event.preventDefault();
      router.navigate('/help');
      return;
    }
    if (key === '/' || (key === 'g' && !event.shiftKey)) {
      if (interactiveControl) return;
      event.preventDefault();
      actions.run('command.focus');
      return;
    }
    if (interactiveControl) return;
    const curRoute = router.current;
    const routeId = curRoute?.route?.id;
    if (routeId !== 'code' && routeId !== 'function') return;
    const activeFnAddr = () => {
      if (routeId === 'function' && curRoute?.params?.address) {
        try { return BigInt(curRoute.params.address); } catch { /* fall through */ }
      }
      return currentFunctionAddr(app) ?? currentAddress(app);
    };
    const activeLineAddr = () => {
      if (routeId === 'code') {
        const row = app.viewer?.selectedRow ?? app.store?.get?.('selectedRow');
        if (row != null && row >= 0 && app.viewer?.rowAddress) {
          const rowAddr = app.viewer.rowAddress(row);
          if (rowAddr != null) return rowAddr;
        }
        return currentAddress(app) ?? currentFunctionAddr(app);
      }
      return activeFnAddr();
    };
    if (key === 'y' && app?.v6) {
      event.preventDefault();
      requireFile(app, () => {
        const a = activeFnAddr();
        if (event.shiftKey) app.v6.openManualRecoveryPopover({ va: a });
        else app.v6.openTypeEditPopover({ va: a });
      });
      return;
    }
    if (key === 's' && event.shiftKey && app?.v6) {
      event.preventDefault();
      requireFile(app, () => {
        app.v6.openSlicePanel({ va: activeLineAddr() });
      });
      return;
    }
    if (key === 'e' && event.shiftKey && app?.v6) {
      event.preventDefault();
      requireFile(app, () => {
        app.v6.openExportInteropModal();
      });
      return;
    }
    if (key === 'n' && !event.shiftKey) {
      event.preventDefault();
      requireFile(app, () => {
        let calleeAddr = null;
        const focusedCallee = document.activeElement?.closest?.('.tok-fn-link')
          || document.querySelector('.ui-pseudocode .tok-hit[data-tok]');
        if (focusedCallee) {
          const tok = focusedCallee.getAttribute('data-tok') || focusedCallee.textContent?.trim();
          if (tok) calleeAddr = symbolAddress(app, tok);
        }
        const a = calleeAddr ?? activeFnAddr();
        if (a != null) showRename(app, a);
        else toast(text('対象の関数またはアドレスが見つかりません。', 'No target function or address selected.'));
      });
      return;
    }
    if (event.key === ';') {
      event.preventDefault();
      requireFile(app, () => {
        const a = activeLineAddr();
        if (a != null) showComment(app, a);
        else toast(text('対象の行または関数が見つかりません。', 'No target line or function selected.'));
      });
      return;
    }
    if (key === 'x' && !event.shiftKey) {
      event.preventDefault();
      requireFile(app, () => {
        if (routeId === 'code') {
          const lineAddr = activeLineAddr();
          if (lineAddr != null) {
            const regions = app.store?.get?.('regions') || [];
            const region = regions.find((r) => r && r.size > 0n && lineAddr >= r.vmAddr && lineAddr < r.vmAddr + r.size);
            const fnAtLine = region?.exec ? currentFunctionAddr(app) : null;
            if ((region && !region.exec) || fnAtLine == null) {
              showXrefs(app, lineAddr);
              return;
            }
          }
        }
        const a = activeFnAddr();
        if (a != null) router.navigate('/function/' + BigInt(a).toString() + '/calls');
        else toast(text('対象の関数が見つかりません。', 'No target function selected.'));
      });
      return;
    }
    if (event.key === ' ' && !event.shiftKey) {
      event.preventDefault();
      requireFile(app, () => {
        const a = activeFnAddr();
        if (a == null) {
          toast(text('対象の関数が見つかりません。', 'No target function selected.'));
          return;
        }
        if (routeId === 'function' && curRoute?.params?.tab === 'pseudocode') {
          const screenRoot = routeHost.querySelector('[data-screen="function"]');
          const jumpAddr = typeof screenRoot?._selectedCodeAddress === 'function'
            ? (screenRoot._selectedCodeAddress() ?? a)
            : a;
          router.navigate('/code/' + BigInt(jumpAddr).toString());
        } else {
          const lineAddr = activeLineAddr();
          const fnBig = BigInt(a);
          const query = lineAddr != null && BigInt(lineAddr) !== fnBig ? ('?addr=' + BigInt(lineAddr).toString()) : '';
          if (lineAddr != null) setSyncAddress(app, fnBig, lineAddr);
          router.navigate('/function/' + fnBig.toString() + '/pseudocode' + query);
        }
      });
      return;
    }
    if (key === 'b' && !event.shiftKey) {
      event.preventDefault();
      requireFile(app, () => {
        const targetAddr = routeId === 'code' ? activeLineAddr() : activeFnAddr();
        if (targetAddr == null) {
          toast(text('対象のアドレスが見つかりません。', 'No target address selected.'));
          return;
        }
        const name = bookmarkLabel(app, targetAddr);
        app.bookmarks?.toggle?.(targetAddr, { name });
        const saved = !!app.bookmarks?.has?.(targetAddr);
        toast(saved
          ? text(`★「${name}」をブックマークしました。`, `★ Bookmarked "${name}".`)
          : text(`☆「${name}」のブックマークを解除しました。`, `☆ Removed bookmark "${name}".`));
      });
    }
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
    userNavigatedSinceFileOpen = false;
    landingDismissed = false;
    appliedDeltaRouteToken = null;
    router.navigate('/code');
    syncLandingCard();
    assistant?.refresh();
    /* On a phone or a narrow split the panel covers the code it is about to
       be asked about; step aside and leave the launcher. */
    assistant?.collapse();
  };
  document.addEventListener('hex:file-opened', onFileOpened);

  const onLanguageChanged = () => {
    nav.setAttribute('aria-label', text('主要ナビゲーション', 'Primary navigation'));
    backBtn.textContent = text('← 戻る', '← Back');
    backBtn.setAttribute('aria-label', text('前の画面へ戻る', 'Go back'));
    forwardBtn.setAttribute('aria-label', text('次の画面へ進む', 'Go forward'));
    syncNavButtons();
    deltaExportBtn.textContent = text('差分を書き出し (.json)', 'Export delta (.json)');
    deltaImportBtn.textContent = text('差分を読み込み (.json)', 'Import delta (.json)');
    deltaResetBtn.textContent = text('リセット', 'Reset');
    deltaDismissBtn.setAttribute('aria-label', text('閉じる', 'Dismiss'));
    syncDeltaStrip();
    more.setAttribute('aria-label', text('その他', 'More'));
    for (const item of PRIMARY_NAV) {
      const btn = nav.querySelector(`[data-route-id="${item.routeId}"]`);
      if (btn) btn.textContent = item.icon + '\n' + (!ja() && item.labelEn ? item.labelEn : item.label);
    }
    commandCenter.refreshLanguage();
    addressBar.refreshLanguage();
    if (router.current?.route?.id === 'code') { updateScreenTitle(null); syncLandingCard(); }
    else if (router.current?.fullPath) router._render(router.current.fullPath, { replace: true, restoredState: null });
  };
  document.addEventListener('hex:language-changed', onLanguageChanged);

  const onPageHide = () => { router.capture(); app.saveWorkspace?.(); };
  window.addEventListener('pagehide', onPageHide, { passive: true });

  assistant = installAssistant(app, { router, actions });
  actions.register('ai.open', () => assistant?.open());
  actions.register('ai.ask', (question, options) => assistant?.ask(question, options));

  const destroy = () => {
    router.stop(); cleanupViewport(); addressBar.destroy(); commandCenter.destroy();
    document.removeEventListener('keydown', shortcut, true);
    app?.v6?.closeActivePopover?.();
    document.removeEventListener('hex:file-opened', onFileOpened);
    document.removeEventListener('hex:language-changed', onLanguageChanged);
    window.removeEventListener('pagehide', onPageHide);
    assistant?.destroy();
    if (typeof unsubDeltaStore === 'function') unsubDeltaStore();
    if (app.viewer) app.viewer.onJumpTarget = prevJumpTarget;
    if (originalSelectSlice) app.selectSlice = originalSelectSlice;
    if (originalGoToAddress) app.goToAddress = originalGoToAddress;
    landingHost.remove(); deltaStrip.remove(); chrome.remove(); nav.remove(); routeHost.remove();
    uiRoot()?.classList.remove('product-ui-ready');
  };
  window.__hexUi = { router, actions, destroy, routes: ROUTES, assistant };
  return window.__hexUi;
}

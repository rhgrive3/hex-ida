/*
 * Design philosophy: 「証拠の地図帳」。日本語を主軸に、現在地・根拠・次の行動を接続する。
 *
 * アプリの骨組み。
 * store・worker・ビューアと、画面の枠（タイトルバー、ツールバー、状態表示）、
 * それに panels.js のシート群をつなぐ。
 */
import { Store, loadPrefs, savePrefs } from './state.js';
import { scanBinaryRegionsCrypto } from './analysis/crypto-entropy.js';
import { Backend } from './backend.js';
import { CodeViewer } from './viewer.js';
import { addrHex, addrText, sizeText } from './format.js';
import { alertDialog, toast, closeTopSheet, closeAllSheets, closeMenu, menu } from './ui.js';
import { rangeCopyMenu, copyRange } from './rangecopy.js';
import { t, setLang, detectLang, lang, isJa, pick } from './i18n.js';
import { SymbolIndex, EMPTY_INDEX } from './symbols.js';
import { clearBriefCache } from './arm64.js';
import { clearAnalysisCache, analyzeFunctionCached, supportsArm64SemanticAnalysis } from './analyze.js';
import { buildOverlay } from './narrate.js';
import { buildObjcRuntimeModel, buildObjcRuntimeIndex } from './objc.js';
import { buildSwiftMetadataModel, buildSwiftRuntimeIndex, resolveSwiftDispatch } from './swift.js';
import { rankApplicationFunctions } from './recognition/classifier.js';
import { KnowledgeDB } from './knowledge/index.js';
import { FieldIndex, EMPTY_FIELDS } from './fields.js';
import { makeSampleFile } from './sample.js';
import { ProgramIndex, mergeProgramScans, PROGRAM_MERGE_LIMITS } from './program.js';
import { foldShapes } from './shapes.js';
import { normalizeSchemaRecoveryLimit, recoverSchemas } from './schema.js';
import { annotateSchemaResult, dependencyCompleteness, schemaDependencyGeneration, schemaResultSatisfies } from './analysis/schema-recovery-contract.js';
import { NoteStore, noteKeyFromBinaryId, findLegacyV3NoteKey, legacyV2NoteKeyFor, legacyNoteKeyForSlice, EMPTY_NOTES } from './names.js';
import { PatchSet } from './patch.js';
import { uiRoot } from './ui-root.js';
import { PluginHost } from './plugins.js';
import { showTools, prettyName } from './tools.js';
import { NavigationHistory } from './navigation.js';
import { STRING_SCAN_BUDGET, StringCollectionBudget } from './string-budget.js';
import { productDescriptor } from './platform/product-descriptor.js';
import { ProductWorkspace } from './workspace.js';
import { createLazyAppAnalysisQueryAPI } from './analysis/query/lazy-app-adapter.js';
import { appProducerAbortError, waitForAppProducer } from './analysis/producer-wait.js';
import { clearSchemaRecoveryTasks } from './analysis/schema-recovery-task.js';
import { AnalysisResumeStore, captureAppAnalysisState, applyAppAnalysisState } from './cache/analysis-resume.js';
import {
  DELTA_SESSION_VERSION,
  BookmarkStore,
  DeltaSessionStore,
  VALID_EXPLORER_FILTERS,
  VALID_EXPLORER_SORTS,
  VALID_FUNCTION_TABS,
  makeDeltaKey,
  countDeltaItems,
  serializeDeltaJson,
  parseDeltaJson,
} from './cache/delta-session.js';
import { attachV6Workbench, formatStagedAutoAnalysisStatus } from './ui/v6-workbench-bridge.js';
import { installFunctionAnalysisPresentation } from './ui/function-analysis-presentation.js';
import { isStrippedFunctionName, normalizeVaHex } from './analysis/common/v6-auto-contracts.js';


let _panelsModulePromise = null;
function panelsModule() {
  return _panelsModulePromise ||= import('./panels.js').catch((err) => {
    _panelsModulePromise = null;
    throw err;
  });
}
function lazyPanel(name) {
  return (...args) => panelsModule().then((module) => module[name](...args));
}
const showFileInfo = lazyPanel('showFileInfo');
const showSections = lazyPanel('showSections');
const showJump = lazyPanel('showJump');
const showSearch = lazyPanel('showSearch');
const showDetail = lazyPanel('showDetail');
const showSettings = lazyPanel('showSettings');
const instructionMenu = lazyPanel('instructionMenu');
const showFunctions = lazyPanel('showFunctions');
const showStrings = lazyPanel('showStrings');
const showStructure = lazyPanel('showStructure');
const showHelp = lazyPanel('showHelp');
const showLearn = lazyPanel('showLearn');
const showGlossary = lazyPanel('showGlossary');
const showWelcome = lazyPanel('showWelcome');
const showSampleGuide = lazyPanel('showSampleGuide');
const showFunctionSummary = lazyPanel('showFunctionSummary');
const showFeatures = lazyPanel('showFeatures');
const showInvestigate = lazyPanel('showInvestigate');
const showOverview = lazyPanel('showOverview');
const showFunctionReport = lazyPanel('showFunctionReport');
const showAccuracyNotes = lazyPanel('showAccuracyNotes');

const $ = (id) => document.getElementById(id);
const FUNCTION_DISCOVERY_GLOBAL_CAP = 400_000;

// Recognition coverage budgets are analysis authority (#5447): only a
// primitive finite number may set them. Structured/junk values fall back to
// the supplied default instead of being coerced through Number().
function coverageBudgetNumber(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

/**
 * Build the recognition state from the SymbolIndex function-start contract.
 *
 * Kept outside App so the state-producing behavior can be exercised without
 * constructing the browser UI.  The browser path and the regression harness
 * therefore share the exact same population, naming, window, completeness,
 * and knowledge-count logic.
 */
export async function buildRecognitionState({
  sym,
  maxFunctions = 350_000,
  knowledgeLimit = 512,
  fields = EMPTY_FIELDS,
  knowledge = null,
  binaryHash = null,
  isCurrent = () => true,
} = {}) {
  if (!sym || sym === EMPTY_INDEX) return null;
  // Recognition coverage is analysis authority: only a primitive finite number
  // may set the budgets, everything else falls back to the defaults (#5447).
  const max = Math.min(500_000, Math.max(1_000, coverageBudgetNumber(maxFunctions, 350_000)));
  const limit = Math.min(2_048, Math.max(0, coverageBudgetNumber(knowledgeLimit, 512)));
  const total = sym.functionCount || 0;
  const count = Math.min(total, max);
  const functions = new Array(count);
  for (let i = 0; i < count; i++) {
    if (!isCurrent()) return null;
    const address = sym.funcs[i], name = sym.nameAt?.(address) || null;
    const windowEnd = sym.functionWindowBound?.(address) || null;
    const owner = fields?.ownerOf?.(address) || null;
    const swiftName = name && /^(.*)::method_(\d+)$/.exec(name);
    functions[i] = {
      address, name, size: windowEnd != null && windowEnd > address ? Number(windowEnd - address) : 0,
      objc: owner?.className ? { class: owner.className } : {},
      swift: swiftName ? { typeDescriptor: swiftName[1] } : {},
      strings: [], calls: [], imports: [], semantic: { writes: [], thresholds: [] }, fieldAccessShape: [],
    };
    if ((i & 8191) === 8191) await Promise.resolve();
  }
  const ranked = rankApplicationFunctions(functions, () => ({ notKnownVendor: true }));
  const knowledgeCount = Math.min(limit, ranked.length);
  let knowledgeMatches = 0, knowledgeAmbiguous = 0;
  for (let i = 0; i < knowledgeCount; i++) {
    if (!isCurrent()) return null;
    try {
      const propagated = await knowledge?.propagate?.(ranked[i].function, { threshold: 0.84, ambiguityWindow: 0.035 });
      if (propagated?.propagated) { ranked[i].knowledge = propagated; knowledgeMatches++; }
      else if (propagated?.ambiguous || propagated?.truncated) knowledgeAmbiguous++;
    } catch { /* local knowledge must never block binary analysis */ }
    if ((i & 63) === 63) await Promise.resolve();
  }
  const records = ranked.map((x) => {
    const known = x.knowledge?.candidate || null;
    return {
      address: x.function.address,
      name: known?.names?.[0] || x.function.name || null,
      originalName: x.function.name || null,
      score: x.score, classification: x.classification.classification,
      confidence: x.classification.confidence, evidence: x.classification.evidence,
      fingerprint: x.function, knowledge: known, knowledgeConfidence: x.knowledge?.confidence || 0,
      knowledgeSourceId: x.knowledge?.sourceId || null,
    };
  });
  return {
    gen: sym.gen, records, total, scannedCount: count,
    complete: count === total && sym.functionStartsComplete === true,
    truncationReason: count === total ? (sym.functionStartsComplete === true ? null : 'function-discovery-incomplete') : 'function-budget',
    binaryHash, knowledge, knowledgeScanned: knowledgeCount, knowledgeMatches, knowledgeAmbiguous,
    knowledgeComplete: knowledgeCount === ranked.length,
  };
}

// Keep the App cache/epoch wrapper executable in integration tests without
// constructing the browser UI. App.ensureRecognition delegates to this seam,
// so tests exercise the same production state and completeness path.
export async function ensureRecognitionState(app, options = {}) {
  const sym = app?.symbols;
  if (!sym || sym === EMPTY_INDEX) return null;
  // The recognition state bakes in knowledge propagation results, so a
  // knowledge mutation must invalidate cached and in-flight recognition (#5723).
  const knowledgeRev = Number(app.knowledge?.revision ?? 0);
  const knowledgeIsCurrent = () => Number(app.knowledge?.revision ?? 0) === knowledgeRev;
  if (app.recognition && app.recognition.gen === sym.gen && app.recognitionKnowledgeRev === knowledgeRev) return app.recognition;
  const busy = app.recognitionBusy;
  if (busy && busy.controller && app.recognitionBusyKnowledgeRev === knowledgeRev && !busy.controller.signal.aborted) {
    return waitForAppProducer(busy, options.signal ?? null);
  }
  const epoch = app.backend.gen;
  const max = Math.min(500000, Math.max(1000, coverageBudgetNumber(options.maxFunctions, 350000)));
  const knowledgeLimit = Math.min(2048, Math.max(0, coverageBudgetNumber(options.knowledgeLimit, 512)));
  const producerController = new AbortController();
  const producerState = { controller: producerController, waiters: 0, settled: false, promise: null };
  const pending = (async () => {
    try { await app.ensureSwift(); } catch { /* Swift metadata is optional */ }
    if (producerController.signal.aborted || epoch !== app.backend.gen || sym !== app.symbols || !knowledgeIsCurrent()) return null;
    // Symbol metadata can change while the async state build yields. Pin the
    // generation after optional metadata producers finish and reject any
    // snapshot that crosses a symbol-index or knowledge mutation.
    const symbolGen = sym.gen;
    const isCurrent = () => !producerController.signal.aborted && epoch === app.backend.gen && sym === app.symbols && sym.gen === symbolGen && knowledgeIsCurrent();
    const state = await buildRecognitionState({
      sym, maxFunctions:max, knowledgeLimit, fields:app.fields, knowledge:app.knowledge,
      binaryHash:app.backend.contentHash || null,
      isCurrent,
    });
    if (state == null || !isCurrent()) return null;
    app.recognition = state;
    app.recognitionKnowledgeRev = knowledgeRev;
    return state;
  })();
  producerState.promise = pending.finally(() => {
    if (app.recognitionBusy === producerState) {
      app.recognitionBusy = null;
      app.recognitionBusyKnowledgeRev = null;
    }
    producerState.settled = true;
  });
  app.recognitionBusy = producerState;
  app.recognitionBusyKnowledgeRev = knowledgeRev;
  return waitForAppProducer(producerState, options.signal ?? null);
}


export class App {
  get analysisEpoch() { return this.backend ? this.backend.analysisEpoch : -1; }

  constructor() {
    this.store = new Store();
    this.prefs = loadPrefs();
    this.detailRefresh = null;
    this.capstoneVersion = '5';
    this.preferredMode = 'asm';
    this.symbols = EMPTY_INDEX;
    this.sampleOpen = false;
    // 直近に解析した関数の Semantic Model。ビューアはここから作った表を引くだけ。
    this.semantic = null;
    this.featureIndex = null;   // 機能から探すための文字列の索引（ファイル単位）
    this.stringIndex = null;    // 収集済みの文字列（ファイル単位でキャッシュ）
    this.program = null;        // ProgramIndex — 呼び出し関係とデータ参照
    this.programScan = null;    // worker から受け取った生の走査結果
    this.programKey = null;     // 索引がどのセクションのものか
    this.programBusy = null;    // 走査中の Promise（二重に走らせない）
    this.programBusyEpoch = -1;
    this.shapes = null;         // 値のふるまい（shapes.js）。名前のないアプリ向けの土台。
    this.shapesBusy = null;
    this.shapesBusyEpoch = -1;
    this.schemas = null;        // データファイルの表（schema.js）
    this.schemasBusy = null;
    this.schemasBusyEpoch = -1;
    this.schemasBusyGeneration = -1;
    this.stringsBusy = null;
    this.stringsBusyEpoch = -1;
    this.cryptoScan = null;
    this.cryptoScanBusy = null;
    this.cryptoScanBusyEpoch = -1;
    this.lastGoal = null;       // 直近に調べた目的
    // Objective-C のクラスとフィールド。x0+0x20 を self.hp と言えるようにする索引。
    this.fields = EMPTY_FIELDS;
    this.objcModel = null;
    this.objcRuntime = null;
    this.objcBusy = null;
    this.objcBusyEpoch = -1;
    this.objcRuntime = null;
    this.swiftModel = null;
    this.swiftRuntime = null;
    this.swiftBusy = null;
    this.swiftBusyAbort = null;
    this.swiftBusyEpoch = -1;
    this.recognition = null;
    this.recognitionBusy = null;
    this.knowledge = new KnowledgeDB();
    this.symbolsReadyEpoch = -1;
    this.analysisBaseSymbolsReady = null;
    /* 自分で付けた名前・メモ・型（names.js）。ファイルごとに保存される。 */
    this.notes = EMPTY_NOTES;
    this.noteAttachController = null;
    this._deltaSaveTimer = null;
    this._applyingDelta = false;
    this.lastDeltaRestore = null;
    this.onDeltaRestored = null;
    this.restoredRoutePath = null;
    this.uiResume = { explorerFilter: 'all', explorerSort: 'address', lastFunctionTab: null };
    this._deltaReadyEpoch = -1;
    this._deltaReadySlice = -1;
    this._undoStack = [];
    this._redoStack = [];
    this._undoLimit = 20;
    this._applyingUndo = false;
    this.bookmarks = new BookmarkStore({
      onChange: () => {
        this.viewer?.invalidate?.();
        if (this._applyingDelta) return;
        this.scheduleDeltaSave();
        this.workspace?.autosave?.();
      },
    });
    this.deltaSession = new DeltaSessionStore();
    this.store.subscribe((_state, patch) => {
      if (patch && 'patches' in patch && !this._applyingDelta && this._isDeltaReady()) {
        this.scheduleDeltaSave();
      }
    });
    /* 命令の書き換え（patch.js）。保存を選ぶまでファイルには触らない。 */
    this.patches = this._createPatchSet();
    /* 追加した機能（plugins.js）。 */
    this.plugins = new PluginHost(this);

    /* 端末の言語に合わせる。ここを 'ja' 決め打ちにしていたころ、
       英語の端末でもツールバーが日本語のままだった。 */
    setLang(this.prefs.lang || detectLang());

    this.dom = {
      app: $('app'),
      name: $('tb-name'),
      sub: $('tb-sub'),
      open: $('btn-open'),
      /* Welcome-screen open button. The titlebar's own Open is re-bound by the
         canonical UI bootstrap, so this one keeps its own id. */
      open2: $('btn-open-welcome'),
      sample: $('btn-sample'),
      learn: $('btn-learn-2'),
      help: $('btn-help'),
      more: $('btn-more'),
      modeSwitch: $('mode-switch'),
      explain: $('btn-explain'),
      sections: $('btn-sections'),
      investigate: $('btn-investigate'),
      tools: $('btn-tools'),
      functions: $('btn-functions'),
      strings: $('btn-strings'),
      struct: $('btn-struct'),
      jump: $('btn-jump'),
      overflow: $('btn-overflow'),
      search: $('btn-search'),
      select: $('btn-select'),
      selbar: $('selbar'),
      selCount: $('sel-count'),
      selRange: $('sel-range'),
      selAll: $('btn-sel-all'),
      selCopy: $('btn-sel-copy'),
      selDone: $('btn-sel-done'),
      addrCur: $('addr-cur'),
      addrRegion: $('addr-region'),
      addrRange: $('addr-range'),
      colhead: $('colhead'),
      viewport: $('viewport'),
      rows: $('rows'),
      scrubber: $('scrubber'),
      thumb: $('scrub-thumb'),
      empty: $('empty'),
      loading: $('loading'),
      loadingText: $('loading-text'),
      stLeft: $('st-left'),
      stRight: $('st-right'),
      navHistory: $('nav-history'),
      navBack: $('nav-back'),
      navForward: $('nav-forward'),
      navCrumbs: $('nav-crumbs'),
      fileInput: $('file-input'),
    };

    this.navigation = new NavigationHistory({
      onChange: (state) => {
        this.renderNavigation(state);
        if (!this._applyingDelta) this.scheduleDeltaSave();
      },
      onNavigate: (entry) => this.restoreNavigation(entry),
    });

    this.backend = new Backend();
    this.backend.onChunk = (regionId, chunk) => {
      this.viewer.chunkArrived(regionId, chunk);
      if (this.detailRefresh) this.detailRefresh();
    };
    this.backend.onFatal = (message) => {
      this.setBusy(false);
      alertDialog(t('err.engineTitle'), friendly(message));
    };

    this.viewer = new CodeViewer({
      viewport: this.dom.viewport,
      rows: this.dom.rows,
      backend: this.backend,
      onTopChange: (row, addr) => this.onTopChange(row, addr),
      onSelect: (row) => this.onSelectRow(row),
      onLongPress: (row, x, y) => instructionMenu(this, row, x, y),
      onRangeChange: () => this.updateSelectionBar(),
      onJumpTarget: (addr) => this.goToAddress(addr, { announce: true, label: this.symbols?.nameAt?.(addr) || null }),
    });
    this.viewer.setBookmarks?.(this.bookmarks);
    this.viewer.setCommentProvider?.((addr) => this.notes?.comment?.(addr) || null);
    this.viewer.attachScrubber(this.dom.scrubber, this.dom.thumb);
    this.workspace = new ProductWorkspace(this);
    if (this.workspace && typeof this.workspace.autosave === 'function' && !this.workspace.autosave.__deltaWrapped) {
      const origAutosave = this.workspace.autosave.bind(this.workspace);
      const annSignature = (arr) => {
        if (!Array.isArray(arr)) return arr == null ? '' : String(arr);
        let sig = String(arr.length);
        for (let i = 0; i < arr.length; i++) {
          const item = arr[i];
          if (!item || typeof item !== 'object') {
            sig += '|' + String(item);
          } else {
            sig += '|' + String(item.id ?? i) + ':' + String(item.updatedAt ?? item.createdAt ?? '') + ':' + String(item.text ?? item.note ?? item.title ?? '');
          }
        }
        return sig;
      };
      const sameShallow = (a, b) => {
        if (a === b) return true;
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
      };
      let prevAnnRef = this.projectAnnotations;
      let prevAnnItems = Array.isArray(this.projectAnnotations) ? this.projectAnnotations.slice() : null;
      let prevAnnSig = annSignature(this.projectAnnotations);
      const wrappedAutosave = (...args) => {
        const result = origAutosave(...args);
        const curRef = this.projectAnnotations;
        const curSig = annSignature(curRef);
        const changed = curRef !== prevAnnRef
          || curSig !== prevAnnSig
          || !sameShallow(curRef, prevAnnItems);
        if (changed) {
          prevAnnRef = curRef;
          prevAnnItems = Array.isArray(curRef) ? curRef.slice() : null;
          prevAnnSig = curSig;
          if (!this._applyingDelta) this.scheduleDeltaSave();
        }
        return result;
      };
      wrappedAutosave.__deltaWrapped = true;
      this.workspace.autosave = wrappedAutosave;
    }
    this.analysisQueries = createLazyAppAnalysisQueryAPI(this);
    this.analysisResume = new AnalysisResumeStore();
    this.analysisResumeReady = Promise.resolve(false);
    this.activeProject = null;
    this.stagedGoalCandidates = [];
    this.v6 = attachV6Workbench(this);
    this.v6Workbench = this.v6;
    this._lastIngestedWasmAnalysis = null;
    this._unsubAutoAnalysisStatus = this.v6?.subscribeAutoAnalysis?.((state) => {
      this._renderAutoAnalysisStatus(state);
    }) || null;
    installFunctionAnalysisPresentation(this);
    this._reinstallPresentationWrapper = () => installFunctionAnalysisPresentation(this);

    this.applyTheme(this.prefs.theme || 'system');
    this.applyTextSize(this.prefs.textSize || 'm');
    this.store.set({ hexJoined: !!this.prefs.hexJoined });
    this.viewer.setHexJoined(!!this.prefs.hexJoined);
    if (this.prefs.explain == null) this.prefs.explain = true;   // 初心者向けなので既定でオン
    this.viewer.setNotes(this.prefs.explain, this.prefs.noteStyle || 'ja');

    this.bind();
    this.applyLabels();
    this.layout();
    this.updateChrome();

    const startupRestore = this.restoreLastAnalysisFile().catch(() => false);
    if (!this.prefs.guideSeen) setTimeout(() => {
      startupRestore.then((restored) => {
        if (!restored && !this.store.get('fileInfo')) showWelcome(this);
      }).catch(() => {});
    }, 300);
    if (typeof window !== 'undefined') {
      this._analysisResumePageHide = () => {
        this.workspace?.autosave();
        void this.flushDeltaSave();
        void this.persistAnalysisSession();
      };
      window.addEventListener('pagehide', this._analysisResumePageHide, { passive:true });
      document?.addEventListener?.('visibilitychange', () => {
        if (document.hidden) this._analysisResumePageHide();
      }, { passive:true });
    }
  }

  /* ── 文言 ─────────────────────────────────────────────────── */

  /** data-i18n が付いた要素の文言を、今の言語で入れ直す。 */
  applyLabels() {
    for (const node of document.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of document.querySelectorAll('[data-i18n-aria]')) {
      node.setAttribute('aria-label', t(node.dataset.i18nAria));
    }
    for (const node of document.querySelectorAll('[data-i18n-html]')) {
      node.replaceChildren();
      const lines = t(node.dataset.i18nHtml).split('\n');
      lines.forEach((line, i) => {
        if (i) node.append(document.createElement('br'));
        node.append(document.createTextNode(line));
      });
    }
    document.title = t('app.title');
    this.dom.explain.setAttribute('aria-pressed', String(!!this.prefs.explain));
    this.updateChrome();
    this._renderAutoAnalysisStatus();
  }

  /* ── 配線 ─────────────────────────────────────────────────── */

  bind() {
    const pick2 = () => this.dom.fileInput.click();
    this.dom.open.addEventListener('click', pick2);
    if (this.dom.open2) this.dom.open2.addEventListener('click', pick2);
    this.dom.sample.addEventListener('click', () => this.openSample());
    this.dom.learn.addEventListener('click', () => showLearn(this));
    this.dom.fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) this.openFile(f);
    });

    this.dom.modeSwitch.addEventListener('click', (e) => {
      const b = e.target.closest('.seg');
      if (b) this.setMode(b.dataset.mode);
    });

    this.dom.explain.addEventListener('click', () => this.setExplain(!this.prefs.explain));
    this.dom.sections.addEventListener('click', () => showSections(this));
    this.dom.investigate.addEventListener('click', () => showInvestigate(this));
    this.dom.tools.addEventListener('click', () => showTools(this));
    this.dom.functions.addEventListener('click', () => showFunctions(this));
    this.dom.strings.addEventListener('click', () => showStrings(this));
    this.dom.struct.addEventListener('click', () => showStructure(this));
    this.dom.jump.addEventListener('click', () => showJump(this));
    this.dom.search.addEventListener('click', () => showSearch(this));
    this.dom.help.addEventListener('click', () => showHelp(this));
    /*
     * 「その他」。ツールバーに収まりきらない 4 つを、浮かせたメニューで出す。
     * 中身は同じボタンをそのまま押すので、有効・無効の扱いは 1 か所のままになる。
     */
    this.dom.overflow.addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const item = (el2) => ({
        label: el2.textContent,
        disabled: el2.disabled,
        action: () => el2.click(),
      });
      menu([
        item(this.dom.strings), item(this.dom.sections),
        item(this.dom.struct), item(this.dom.select),
      ], r.left + r.width / 2, r.bottom + 4);
    });
    this.dom.select.addEventListener('click', () => {
      if (this.viewer.rangeMode) this.viewer.clearRange();
      else this.startSelection();
    });

    this.dom.selAll.addEventListener('click', () => this.viewer.selectAllRows());
    this.dom.selDone.addEventListener('click', () => this.viewer.clearRange());
    this.dom.selCopy.addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      rangeCopyMenu(this, r.left + r.width / 2, r.top);
    });
    this.dom.more.addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const needFile = (fn) => () => (this.store.get('fileInfo') ? fn() : toast(t('err.openFirst')));
      menu([
        { label: t('file.title') + '…', action: needFile(() => showFileInfo(this)) },
        { label: t('struct.title') + '…', action: needFile(() => showStructure(this)) },
        { label: t('sections.title') + '…', action: needFile(() => showSections(this)) },
        '-',
        { label: t('help.learn'), action: () => showLearn(this) },
        { label: t('glossary.title'), action: () => showGlossary(this) },
        { label: t('help.title'), action: () => showHelp(this) },
        '-',
        { label: t('settings.title') + '…', action: () => showSettings(this) },
        { label: t('btn.openFile'), action: () => this.dom.fileInput.click() },
      ], r.left + r.width / 2, r.bottom - 4);
    });
    this.dom.navBack.addEventListener('click', () => this.navigation.back());
    this.dom.navForward.addEventListener('click', () => this.navigation.forward());

    let resizeTimer = 0;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { this.layout(); this.viewer.measure(); }, 80);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    document.addEventListener('keydown', (e) => this.onKey(e));

    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.openFile(f);
    });
  }

  onKey(e) {
    if (e.defaultPrevented) return;
    const target = e.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    if (e.key === 'Escape') {
      if (closeMenu() || closeTopSheet()) { e.preventDefault(); return; }
      if (this.viewer.highlightedReg) { this.viewer.clearHighlightedReg(); e.preventDefault(); return; }
      if (this.viewer.rangeMode) { this.viewer.clearRange(); e.preventDefault(); }
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === 'f' || e.key === 'F')) {
      if (!this.store.get('currentRegion')) return;
      e.preventDefault(); showSearch(this); return;
    }
    if (meta && (e.key === 'g' || e.key === 'G')) {
      if (!this.store.get('currentRegion')) return;
      e.preventDefault(); showJump(this); return;
    }
    if (typing || target?.closest?.('button, a, [role="button"], [role="tab"]')) return;
    if (e.key === '?') { e.preventDefault(); showHelp(this); return; }
    if (!this.store.get('currentRegion')) return;
    // Viewer shortcuts must not consume native button activation or scroll
    // the hidden code view while a product screen owns keyboard focus.
    if (document.getElementById('app')?.classList.contains('ui-screen-route')) return;

    if (meta && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault(); this.viewer.selectAllRows(); return;
    }
    if (meta && (e.key === 'c' || e.key === 'C')) {
      if (!this.viewer.selectionRange()) return;
      e.preventDefault(); copyRange(this, 'all'); return;
    }

    const shift = e.shiftKey;
    const v = this.viewer;
    switch (e.key) {
      case 'g': case 'G': e.preventDefault(); showJump(this); break;
      case '/':
        if (uiRoot()?.classList.contains('product-ui-ready')) return;
        e.preventDefault(); showSearch(this); break;
      case 'e': case 'E': e.preventDefault(); this.setExplain(!this.prefs.explain); break;
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        if (shift) { v.extendByRows(delta); break; }
        if (!v.totalRows) break;
        const cur = v.selectedRow;
        const next = cur >= 0 ? v.clampRow(v._rowPlus(cur, delta)) : v.topRow();
        v.select(next, false);
        v.revealRow(next);
        const addr = v.rowAddress(next);
        if (addr != null) {
          if (this.dom.addrCur) this.dom.addrCur.textContent = addrHex(addr);
          this.store.set({ selectedRow: next, currentAddress: addr });
        } else {
          this.store.set({ selectedRow: next });
        }
        break;
      }
      case 'PageDown': case ' ': e.preventDefault(); shift ? v.extendByPages(1) : v.scrollByPages(1); break;
      case 'PageUp': e.preventDefault(); shift ? v.extendByPages(-1) : v.scrollByPages(-1); break;
      case 'Home': e.preventDefault(); shift ? v.extendToRow(0) : v.goToRow(0, 'top'); break;
      case 'End': e.preventDefault();
        shift ? v.extendToRow(v.totalRows - 1) : v.goToRow(v.totalRows - 1, 'top'); break;
      default: break;
    }
  }

  /* ── 画面の枠 ─────────────────────────────────────────────── */

  layout() {
    const wide = window.innerWidth >= 820;
    this.dom.app.classList.toggle('wide', wide);
  }

  setBusy(on, text) {
    this.dom.loading.hidden = !on;
    if (text) this.dom.loadingText.textContent = text;
  }

  updateChrome() {
    const info = this.store.get('fileInfo');
    const region = this.store.get('currentRegion');
    const has = !!info;
    const desc = has ? productDescriptor(info, this.currentSlice()) : null;
    this.dom.sections.disabled = !has;
    this.dom.struct.disabled = !has || (desc && desc.formatId && desc.formatId !== 'macho');
    this.dom.strings.disabled = !has;
    this.dom.investigate.disabled = !has;
    this.dom.tools.disabled = !has;
    this.dom.functions.disabled = !region;
    this.dom.jump.disabled = !region;
    this.dom.overflow.disabled = !has;
    this.dom.search.disabled = !region;
    this.dom.select.disabled = !region;
    this.dom.empty.hidden = has;
    this.dom.navHistory.hidden = !has;
    this.dom.scrubber.classList.toggle('on', !!region);
    this.updateSelectionBar();

    if (!info) {
      this.dom.name.textContent = t('app.noFile');
      this.dom.sub.textContent = t('app.noFileSub');
      this.dom.stLeft.textContent = '';
      this.dom.stRight.textContent = '';
      this.dom.addrCur.textContent = '—';
      this.dom.addrRegion.textContent = '';
      this.dom.addrRange.textContent = '';
      this._renderAutoAnalysisStatus(null);
      return;
    }

    this.dom.name.textContent = info.name;
    const arch = this.store.get('architecture');
    this.dom.sub.textContent = [info.format, arch, sizeText(info.size)].filter(Boolean).join(' · ');

    if (region) {
      this.dom.addrRegion.textContent = region.name;
      this.dom.addrRange.textContent =
        addrText(region.vmAddr) + '–' + addrText(region.vmAddr + region.size);
      this.dom.stLeft.textContent =
        (this.store.get('canDisassemble') ? (arch || 'code') : (arch || t('status.data'))) + ' · ' +
        sizeText(region.size) + ' · ' + t('status.rows', { n: this.viewer.totalRows.toLocaleString() });
    }
    this.updateModeUI();
  }

  updateModeUI() {
    const mode = this.store.get('displayMode');
    for (const b of this.dom.modeSwitch.querySelectorAll('.seg')) {
      b.setAttribute('aria-selected', String(b.dataset.mode === mode));
    }
    this.dom.colhead.classList.toggle('mode-asm-head', mode === 'asm');
    this.dom.colhead.classList.toggle('mode-hex-head', mode === 'hex');
    this.dom.explain.disabled = mode !== 'asm';
  }

  onTopChange(row, addr) {
    this.dom.addrCur.textContent = addrHex(addr);
    const total = this.viewer.totalRows;
    this.dom.stRight.textContent = total
      ? t('status.rowOf', { cur: (typeof row === 'bigint' ? row + 1n : row + 1).toLocaleString(), total: total.toLocaleString() })
      : '';
    this.store.set({ currentAddress: addr });
  }

  onSelectRow(row) {
    this.store.set({ selectedRow: row });
    showDetail(this, row);
  }

  /* ── 範囲選択 ─────────────────────────────────────────────── */

  startSelection(row) {
    if (!this.store.get('currentRegion')) return;
    closeTopSheet();
    if (row == null) {
      const sel = this.viewer.selectedRow;
      const top = this.viewer.topRow();
      const bottom = typeof top === 'bigint' ? top + BigInt(this.viewer.visibleRows()) : top + this.viewer.visibleRows();
      const visible = sel >= top && sel < bottom;
      row = visible ? sel : top;
    }
    this.viewer.beginRange(row);
    toast(t('sel.hint'));
  }

  updateSelectionBar() {
    const sel = this.viewer.rangeMode ? this.viewer.selectionRange() : null;
    this.dom.selbar.hidden = !sel;
    this.dom.select.setAttribute('aria-pressed', String(!!sel));
    this.store.set({
      selectionStart: sel ? sel.start : -1,
      selectionEnd: sel ? sel.end : -1,
    });
    if (!sel) return;
    this.dom.selCount.textContent = t('sel.rows', { n: sel.count.toLocaleString() });
    this.dom.selRange.textContent =
      addrText(this.viewer.rowAddress(sel.start)) + '–' + addrText(this.viewer.rowAddress(sel.end));
  }

  /* ── 設定 ─────────────────────────────────────────────────── */

  saveSettings() { savePrefs(this.prefs); }

  setTheme(theme) {
    this.applyTheme(theme);
    this.prefs.theme = theme;
    this.saveSettings();
  }

  applyTheme(theme) {
    this.store.set({ theme });
    if (theme === 'system') uiRoot()?.removeAttribute('data-theme');
    else uiRoot()?.setAttribute('data-theme', theme);
  }

  setTextSize(size) {
    this.applyTextSize(size);
    this.prefs.textSize = size;
    this.saveSettings();
  }

  applyTextSize(size) {
    const root = uiRoot();
    for (const s of ['s', 'm', 'l', 'xl']) root.classList.toggle('size-' + s, s === size);
    if (this.viewer) this.viewer.measure();
  }

  setHexJoined(on) {
    this.store.set({ hexJoined: on });
    this.viewer.setHexJoined(on);
    this.prefs.hexJoined = on;
    this.saveSettings();
  }

  setExplain(on) {
    this.prefs.explain = !!on;
    this.viewer.setNotes(!!on, this.prefs.noteStyle || 'ja');
    this.dom.explain.setAttribute('aria-pressed', String(!!on));
    this.saveSettings();
  }

  setNoteStyle(style) {
    this.prefs.noteStyle = style;
    this.viewer.setNotes(this.prefs.explain, style);
    this.saveSettings();
  }

  setLanguage(l) {
    this.prefs.lang = l;
    setLang(l);
    clearBriefCache();
    this.saveSettings();
    this.applyLabels();
    this.viewer.setSymbols(this.symbols);   // 解説を作り直させる
    // Semantic Model は言語に依存しないので、見出しだけ作り直せばよい
    if (this.semantic) {
      this.viewer.setBlockOverlay(this.semantic.regionId, buildOverlay(this.semantic.model));
    }
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('hex:language-changed', { detail: { lang: l } }));
    }
  }

  /* ── 意味の層 ─────────────────────────────────────────────── */

  /**
   * 表示中の解析結果を手放す。
   *
   * @param {boolean} dropCache 解析キャッシュごと捨てるか。
   *   別のファイル・スライスに移ったときだけ true。セクションを移っただけなら
   *   キャッシュ（鍵にセクション id を含む）はそのまま残して、戻ってきたとき速くする。
   */
  forgetSemantics(dropCache) {
    this.semantic = null;
    if (dropCache) {
      this.v6?.detach?.();
      this._lastIngestedWasmAnalysis = null;
      this.stagedGoalCandidates = [];
      this._renderAutoAnalysisStatus(null);
      clearSchemaRecoveryTasks(this);
      this.featureIndex = null;
      this.stringIndex = null;
      this.cryptoScan = null;
      this.cryptoScanBusy = null;
      this.cryptoScanBusyEpoch = -1;
      this.autoReport = null;
      this.pinnedCache = null;
      this.fields = EMPTY_FIELDS;
      this.objcModel = null;
      this.objcRuntime = null;
      this.swiftBusyAbort?.abort('swift-reset');
      this.swiftModel = null;
      this.swiftRuntime = null;
      this.swiftBusy = null;
      this.swiftBusyAbort = null;
      this.swiftBusyEpoch = -1;
      this.recognitionBusy?.controller?.abort('recognition-reset');
      this.recognition = null;
      this.recognitionBusy = null;
      this.recognitionKnowledgeRev = 0;
      this.recognitionBusyKnowledgeRev = -1;
      this.program = null;
      this.programScan = null;
      this.programKey = null;
      this.programBusy = null;
      this.programBusyEpoch = -1;
      this.shapes = null;
      this.shapesBusy = null;
      this.shapesBusyEpoch = -1;
      this.schemas = null;
      this.schemasBusy = null;
      this.schemasBusyEpoch = -1;
      this.schemasBusyGeneration = -1;
      this.stringsBusy = null;
      this.stringsBusyEpoch = -1;
      this.objcBusyState?.controller?.abort('objc-reset');
      this.objcBusyState = null;
      this.objcBusy = null;
      this.objcBusyEpoch = -1;
      this.symbolsReady = null;
      this.symbolsReadyEpoch = -1;
      this.analysisBaseSymbolsReady = null;
      this.lastGoal = null;
      clearAnalysisCache();
    }
    if (this.viewer) this.viewer.clearBlockOverlay();
  }

  /* ── プログラム全体の索引 ─────────────────────────────────
     「誰が誰を呼び、誰が何を見ているか」を 1 回だけ走査して作る。
     これがないと、このツールは名前と文字列を眺めるだけの道具に戻ってしまう。 */

  syncSymbolsStore(ready = null) {
    this.store?.set?.({
      symbolsGen: this.symbols?.gen ?? 0,
      ...(ready === null ? {} : { symbolsReady: !!ready }),
    });
  }

  /** 全体解析の対象になる、active slice内のfile-backed executable regions。 */
  programRegions() {
    const candidates=(this.store.get('regions')||[]).filter((r)=>r?.exec===true && r.size>0n && !r.zerofill);
    const sectioned=candidates.filter((r)=>!!r.section);
    const source=sectioned.length?sectioned:candidates;
    const seen=new Set(), out=[];
    for(const r of source){
      const key=`${String(r.fileOffset??'')}|${String(r.vmAddr??'')}|${String(r.size??'')}`;
      if(seen.has(key))continue; seen.add(key); out.push(r);
    }
    out.sort((a,b)=>a.vmAddr<b.vmAddr?-1:a.vmAddr>b.vmAddr?1:String(a.id||'').localeCompare(String(b.id||'')));
    return out;
  }

  /** UIの既定コードregion（全体解析自体は programRegions() 全件を使う）。 */
  codeRegion() {
    const regions=this.programRegions();
    return regions.find((r)=>r.section==='__text') || regions[0] || this.store.get('currentRegion') || null;
  }

  /**
   * 関数の切れ目をactive sliceの全exec regionで補完する。
   * exact seedの正確さと一覧の網羅性は分離し、全region走査済みの時だけcompleteにする。
   */
  async ensureFunctions(region, onProgress) {
    if (this.analysisResumeReady) { try { await this.analysisResumeReady; } catch { /* best effort */ } }
    // A non-function progress observer must never reach the backend callback:
    // truthy junk (true, {}, []) would be invoked by the backend at the first
    // progress tick and abort discovery with a raw TypeError. Normalize the
    // options-object spelling exactly like ensureProgram/ensureStrings (#5448).
    const progressFn = typeof onProgress === 'function'
      ? onProgress
      : (typeof onProgress === 'object' && typeof onProgress?.onProgress === 'function' ? onProgress.onProgress : null);
    const epoch=this.backend.gen;
    if(this.symbolsReady){try{await this.symbolsReady;}catch{/* names are optional */}}
    if(epoch!==this.backend.gen)return null;
    if(this.symbols===EMPTY_INDEX){this.symbols = new SymbolIndex({ regions: this.store.get('regions') || [] });this.viewer.setSymbols(this.symbols);this.syncSymbolsStore();}
    const sym=this.symbols;
    if(!sym || sym.functionStartsComplete===true || sym.functionDiscovery?.complete===true)return sym;
    const targets=this.programRegions();
    if(region && region.exec && !targets.some((r)=>r.id===region.id))targets.push(region);
    if(!targets.length)return sym;
    const regionSetKey=targets.map((r)=>r.id).join('|');

    let remaining= Math.max(0, FUNCTION_DISCOVERY_GLOBAL_CAP - Math.min(FUNCTION_DISCOVERY_GLOBAL_CAP, sym.functionCount||0));
    let remainingBytes=targets.reduce((n,r)=>n+BigInt(r.size),0n);
    const results=[], reasons=[];
    for(let i=0;i<targets.length;i++){
      if(epoch!==this.backend.gen)return null;
      const r=targets[i], size=BigInt(r.size), share=remaining>0&&remainingBytes>0n
        ? Math.max(1,Math.min(remaining,Number((BigInt(remaining)*size+remainingBytes-1n)/remainingBytes))) : 0;
      if(share<=0){reasons.push(`function-global-budget:${r.id}`);results.push({regionId:r.id,complete:false,skipped:true});remainingBytes-=size;continue;}
      try{
        const res=await this.backend.guessFunctions(r.id,share,progressFn&&((p)=>progressFn({phase:'functions',done:i+(p.all?Math.min(1,p.done/p.all):0),all:targets.length,region:r.id})));
        if(epoch!==this.backend.gen)return null;
        if(res?.starts?.length){sym.addFunctions(res.starts,{source:'heuristic',confidence:0.55,confirmed:false});sym.guessed=true;remaining=Math.max(0,remaining-res.starts.length);}
        const complete=res?.discoveryComplete===true || res?.completeness?.complete===true || res?.complete===true;
        results.push({regionId:r.id,complete,capped:!!res?.capped,discovered:res?.starts?.length||0});
        if(!complete)reasons.push(`${r.id}:${res?.completeness?.reason||res?.truncationReason||'function-discovery-incomplete'}`);
      }catch{results.push({regionId:r.id,complete:false,error:true});reasons.push(`${r.id}:function-discovery-failed`);}
      remainingBytes-=size;
    }
    const complete=results.length===targets.length && results.every((x)=>x.complete===true);
    sym.functionDiscovery={complete,attempted:true,regionSetKey,regions:results,reasons:[...new Set(reasons)],capped:results.some((x)=>x.capped)};
    sym.functionStartsComplete=complete;
    sym.functionStartsCapped=sym.functionDiscovery.capped || reasons.some((x)=>x.includes('budget'));
    this.viewer.setSymbols(sym);
    this.syncSymbolsStore();
    void this.persistAnalysisSession(['symbols']);
    return sym;
  }

  /** Build one global ProgramIndex from every executable region. */
  async ensureProgram(onProgress) {
    if (this.analysisResumeReady) { try { await this.analysisResumeReady; } catch { /* best effort */ } }
    const progressFn = typeof onProgress === 'function' ? onProgress : (typeof onProgress === 'object' && typeof onProgress?.onProgress === 'function' ? onProgress.onProgress : null);
    const regions=this.programRegions();
    if(!regions.length)return null;
    const key=regions.map((r)=>r.id).join('|');
    const primary=regions.find((r)=>r.section==='__text')||regions[0];
    if(this.program&&this.programKey===key&&this.program.gen===this.symbols.gen)return this.program;
    if(this.programScan&&this.programKey===key){this.program=new ProgramIndex(this.programScan,this.symbols,primary);return this.program;}
    const epoch=this.backend.gen;
    if(this.programBusy&&this.programBusyEpoch===epoch)return this.programBusy;
    this.programBusyEpoch=epoch;
    this.programBusy=(async()=>{
      await this.ensureFunctions(primary,progressFn);
      if(epoch!==this.backend.gen)return null;
      const scans=[], failures=[];
      let calls=PROGRAM_MERGE_LIMITS.calls, refs=PROGRAM_MERGE_LIMITS.refs, kinds=PROGRAM_MERGE_LIMITS.kindWords;
      let remainingBytes=regions.reduce((n,r)=>n+BigInt(r.size),0n);
      const share=(remaining,size,total)=>remaining>0&&total>0n?Math.max(1,Math.min(remaining,Number((BigInt(remaining)*size+total-1n)/total))):0;
      for(let i=0;i<regions.length;i++){
        const r=regions[i], size=BigInt(r.size);
        if(epoch!==this.backend.gen)return null;
        try{
          const scan=await this.backend.scanProgram(r.id,progressFn&&((p)=>progressFn({phase:'scan',done:i+(p.all?Math.min(1,p.done/p.all):0),all:regions.length,region:r.id})),{
            architecture:this.store.get('architecture') || this.currentSlice?.()?.capability?.architecture || 'unknown',
            callLimit:share(calls,size,remainingBytes),refLimit:share(refs,size,remainingBytes),kindLimit:share(kinds,size,remainingBytes),
          });
          if(scan&&!scan.cancelled){scans.push(scan);calls=Math.max(0,calls-(scan.callCount??scan.callFrom?.length??0));refs=Math.max(0,refs-(scan.refCount??scan.refFrom?.length??0));kinds=Math.max(0,kinds-(scan.kindsCovered??scan.kinds?.length??0));}
          else failures.push(`${r.id}:program-scan-cancelled`);
        }catch{failures.push(`${r.id}:program-scan-failed`);}
        remainingBytes-=size;
      }
      if(epoch!==this.backend.gen)return null;
      const merged=mergeProgramScans(scans,{regions,reasons:failures,limits:PROGRAM_MERGE_LIMITS});
      this.programScan=merged;this.programKey=key;this.program=new ProgramIndex(merged,this.symbols,primary);
      void this.persistAnalysisSession(['symbols', 'programScan', 'programKey']);
      return this.program;
    })().finally(()=>{if(this.programBusyEpoch===epoch){this.programBusy=null;this.programBusyEpoch=-1;}});
    return this.programBusy;
  }

  /**
   * 値の「ふるまい」をコード全体から集める。
   *
   * 名前も文字列も残っていないアプリ（ゲーム本体が C++ のもの）で、値を見分ける
   * ための土台。セクションを 1 回舐めるだけなので、18 MB でも 1 秒かからない。
   * ファイル単位でキャッシュする。
   */
  async ensureShapes(onProgress) {
    if (this.analysisResumeReady) { try { await this.analysisResumeReady; } catch { /* best effort */ } }
    const progressFn = typeof onProgress === 'function'
      ? onProgress
      : (onProgress && typeof onProgress === 'object' && typeof onProgress.onProgress === 'function' ? onProgress.onProgress : null);
    if (this.shapes) return this.shapes;
    const epoch = this.backend.gen;
    if (this.shapesBusy && this.shapesBusyEpoch === epoch) return this.shapesBusy;
    const region = this.codeRegion();
    if (!region) return null;
    this.shapesBusyEpoch = epoch;
    this.shapesBusy = (async () => {
      try {
        const scan = await this.backend.valueShapes(region.id,
          progressFn && ((p) => progressFn({ phase: 'shapes', done: p.done, all: p.all })));
        if (epoch === this.backend.gen && scan && !scan.cancelled) {
          this.shapes = foldShapes(scan);
          void this.persistAnalysisSession(['shapes']);
        }
      } catch {
        if (epoch === this.backend.gen) this.shapes = null;
      } finally {
        if (this.shapesBusyEpoch === epoch) {
          this.shapesBusy = null;
          this.shapesBusyEpoch = -1;
        }
      }
      return epoch === this.backend.gen ? this.shapes : null;
    })();
    return this.shapesBusy;
  }

  /**
   * データファイル（CSV / JSON）の表の形を、読み込み処理の命令から取り戻す。
   *
   * ゲームの数値はコードではなくデータファイルにある。バイナリに「攻撃力」の
   * 文字は無くても、「何列目がどこに入るか」は命令に書いてある。ここがその入口。
   * 文字列と呼び出し関係が要るので、先にそちらを用意してから走る。
   */
  async ensureSchemas(onProgress) {
    if (this.analysisResumeReady) { try { await this.analysisResumeReady; } catch { /* best effort */ } }
    const epoch = this.backend.gen;
    const maxSchemas = normalizeSchemaRecoveryLimit();
    const generation = schemaDependencyGeneration(this);
    if (schemaResultSatisfies(this.schemas, epoch, maxSchemas, generation)) return this.schemas;
    if (this.schemasBusy && this.schemasBusyEpoch === epoch && this.schemasBusyGeneration === generation) return this.schemasBusy;
    this.schemasBusyEpoch = epoch;
    this.schemasBusyGeneration = generation;
    this.schemasBusy = (async () => {
      try {
        const strings = await this.ensureStrings(onProgress);
        const program = await this.ensureProgram(onProgress);
        if (epoch !== this.backend.gen) return null;
        const boundGeneration = Number.isSafeInteger(program?.gen) ? program.gen : generation;
        const isCurrent = epoch === this.backend.gen && boundGeneration === schemaDependencyGeneration(this);
        if (!program) {
          if (isCurrent) this.schemas = annotateSchemaResult([], dependencyCompleteness(strings, program), { epoch, maxSchemas, dependencyGeneration: boundGeneration });
          return this.schemas;
        }
        const read = (addr, len) => this.backend.readAt(addr, len)
          .then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
        const arch = this.store.get('architecture') || this.currentSlice?.()?.capability?.architecture;
        const schemas = await recoverSchemas({ strings, program, read, onProgress, architecture: arch,
          limit:maxSchemas, isCancelled: () => epoch !== this.backend.gen });
        if (epoch === this.backend.gen && boundGeneration === schemaDependencyGeneration(this)) {
          this.schemas = annotateSchemaResult(schemas, dependencyCompleteness(strings, program), { epoch, maxSchemas, dependencyGeneration: boundGeneration });
          void this.persistAnalysisSession(['schemas']);
        }
      } catch {
        if (epoch === this.backend.gen && generation === schemaDependencyGeneration(this)) {
          this.schemas = annotateSchemaResult([], { complete:false, reasons:['schema-recovery-failed'] }, { epoch, maxSchemas, dependencyGeneration: generation });
        }
      } finally {
        if (this.schemasBusyEpoch === epoch && this.schemasBusyGeneration === generation) {
          this.schemasBusy = null;
          this.schemasBusyEpoch = -1;
          this.schemasBusyGeneration = -1;
        }
      }
      return epoch === this.backend.gen ? this.schemas : null;
    })();
    return this.schemasBusy;
  }

  /**
   * 文字列を集める。__cstring などが第一候補で、なければ今のセクション。
   * ファイル単位でキャッシュする（何度も走査しない）。
   */
  /**
   * 暗号定数（AES/SHA/ChaCha20等）と高エントロピー領域をファイル単位で走査・キャッシュする。
   */
  async ensureCryptoScan() {
    if (this.cryptoScan) return this.cryptoScan;
    const epoch = this.backend?.gen ?? 0;
    if (this.cryptoScanBusy && this.cryptoScanBusyEpoch === epoch) return this.cryptoScanBusy;
    this.cryptoScanBusyEpoch = epoch;
    this.cryptoScanBusy = (async () => {
      try {
        const res = await scanBinaryRegionsCrypto(this.backend?.file, this.store.get('regions') || []);
        if (epoch === (this.backend?.gen ?? 0)) this.cryptoScan = res;
        return epoch === (this.backend?.gen ?? 0) ? res : null;
      } catch {
        return { constants: [], highEntropy: [], scannedBytes: 0, complete: false };
      } finally {
        if (this.cryptoScanBusyEpoch === epoch) {
          this.cryptoScanBusy = null;
          this.cryptoScanBusyEpoch = -1;
        }
      }
    })();
    return this.cryptoScanBusy;
  }

  async ensureStrings(onProgress) {
    if (this.analysisResumeReady) { try { await this.analysisResumeReady; } catch { /* best effort */ } }
    // Positional `(onProgress)` is the canonical signature; an options object
    // with an `onProgress` field is tolerated exactly like ensureProgram so a
    // legacy caller can never register a non-function as the backend progress
    // callback (#5719).
    const progressFn = typeof onProgress === 'function'
      ? onProgress
      : (typeof onProgress === 'object' && typeof onProgress?.onProgress === 'function' ? onProgress.onProgress : null);
    if (this.stringIndex) return this.stringIndex;
    const epoch = this.backend.gen;
    if (this.stringsBusy && this.stringsBusyEpoch === epoch) return this.stringsBusy;
    this.stringsBusyEpoch = epoch;
    this.stringsBusy = (async () => {
    const regions = this.store.get('regions') || [];
    /*
     * 文字列の置き場は 6 か所とはかぎらない。上から 6 つだけ見ていたころは
     * __oslogstring のような後ろのほうの区画がまるごと抜けていた。
     * 走査は速いので、文字列が入りうる区画は全部見る（合計のバイト数だけ見張る）。
     */
    const priority = (r) => {
      const s = r.section || '';
      if (r.cstrings || /^__(cstring|objc_methname|objc_classname|swift5_reflstr|oslogstring)$/.test(s)) return 0;
      if (/string|objc_method|objc_class|ustring/i.test(s)) return 1;
      return 2; // general __const comes last
    };
    const targets = regions.filter((r) => r.size > 0n &&
      (r.cstrings || /string|cstring|objc_methname|objc_method|objc_classname|objc_class|oslogstring|const|ustring|swift5_reflstr/i.test(r.section || '')))
      .sort((a, b) => priority(a) - priority(b));
    const current = this.store.get('currentRegion');
    const collectionBudget = new StringCollectionBudget(STRING_SCAN_BUDGET);
    const use = [];
    const skipped = [];
    for (const r of targets) {
      const bytes = collectionBudget.requestBytes(Number(r.size));
      if (bytes <= 0) { skipped.push(r); continue; }
      use.push({ region: r, bytes });
      if (bytes < Number(r.size)) skipped.push(r);
    }
    if (!use.length && current) {
      const bytes = collectionBudget.requestBytes(Number(current.size));
      if (bytes > 0) use.push({ region: current, bytes });
    }
    const out = [];
    let scannedBytes = 0;
    let backendIncomplete = false;
    try {
      for (let itemIndex = 0; itemIndex < use.length; itemIndex++) {
        if (epoch !== this.backend.gen) return null;
        if (collectionBudget.exhausted) {
          for (const rest of use.slice(itemIndex)) if (!skipped.includes(rest.region)) skipped.push(rest.region);
          break;
        }
        const item = use[itemIndex];
        const r = item.region;
        const remaining = collectionBudget.requestLimit();
        if (remaining <= 0) {
          collectionBudget.truncationReason ||= 'result-budget';
          for (const rest of use.slice(itemIndex)) if (!skipped.includes(rest.region)) skipped.push(rest.region);
          break;
        }
        const res = await this.backend.strings({ regionId: r.id, min: 4, maxBytes: item.bytes, limit: remaining },
          progressFn && ((p) => progressFn({ phase: 'strings', done: p.done, all: p.all, region: r.id })));
        scannedBytes += res.scannedBytes || 0;
        if (!res.complete) { backendIncomplete = true; if (!skipped.includes(r)) skipped.push(r); }
        for (const s of res.results || []) {
          if (!collectionBudget.accept(s.text)) break;
          out.push({ addr: s.addr, text: s.text, byteLength: s.byteLength, region: r });
        }
        if (res.capped && !collectionBudget.truncationReason) collectionBudget.truncationReason = res.truncationReason || 'result-budget';
      }
    } finally {
      if (this.stringsBusyEpoch === epoch) {
        this.stringsBusy = null;
        this.stringsBusyEpoch = -1;
      }
    }
    const truncated = !!collectionBudget.truncationReason || skipped.length > 0 || backendIncomplete;
    out.complete = !truncated;
    out.truncated = truncated;
    out.truncationReason = collectionBudget.truncationReason || (skipped.length ? 'input-budget' : backendIncomplete ? 'backend-partial' : null);
    out.skippedRegions = skipped.map((r) => ({ id: r.id, name: r.name, section: r.section, size: r.size }));
    out.unscannedRegions = out.skippedRegions;
    out.scannedBytes = scannedBytes;
    if (epoch === this.backend.gen) {
      this.stringIndex = out;
      void this.persistAnalysisSession(['strings']);
    }
    return epoch === this.backend.gen ? out : null;
    })();
    return this.stringsBusy;
  }

  /** 関数レポートを開く（候補一覧・XREF・ビューアのどこからでも呼べる入口）。 */
  openFunctionReport(addr, goal) {
    showFunctionReport(this, addr, goal || this.lastGoal || null);
  }

  /*
   * 解析の各画面への入口。
   *
   * 「解析」シートの中から呼べるように、app 側に口を作っておく。
   * tools.js が panels.js を直に読むと、両方が互いを読み合う形になるため。
   */
  openOverview() { showOverview(this); }
  openInvestigate() { showInvestigate(this); }
  openFeatures() { showFeatures(this); }
  openAccuracyNotes() { showAccuracyNotes(this, this.autoReport ? this.autoReport.report : null); }

  /**
   * 関数 1 つぶんの意味解析を走らせて、ビューアに処理の区切りを出す。
   *
   * 呼ばれるのは「利用者が関数を開いたとき」だけ。スクロールや描画からは絶対に呼ばない。
   * 同じ関数は analyze.js 側のキャッシュに載るので、二度目はすぐ返る。
   */
  async analyzeFunctionAt(addr) {
    const sym=this.symbols, range=this.validatedFunctionRange(addr);
    const architecture=this.store.get('architecture')||this.store.get('capability')?.architecture||null;
    if(!supportsArm64SemanticAnalysis(architecture)||!range.ok||!this.store.get('canDisassemble')||!sym.functionCount)return null;
    const region=range.region, alignment=Math.max(1,Number(this.store.get('instructionAlignment')||this.store.get('capability')?.instructionAlignment||4));
    const width=BigInt(alignment);
    if((range.start-region.vmAddr)%width!==0n) return null;
    const startRow=Number((range.start-region.vmAddr)/width);
    const endRow=Math.min(Number((range.end-region.vmAddr+width-1n)/width)-1, Math.max(0,Number(region.size/width)-1));
    if(endRow<startRow)return null;
    try {
      const res=await analyzeFunctionCached(this.backend,region,startRow,endRow,sym);
      if(this.store.get('sliceIndex')<0 || this.executableRegionFor(range.start)!==region)return null;
      res.completeness={complete:range.complete!==false,reason:range.reason||null,provenance:range.provenance,regionId:region.id};
      if(this._presentationMatchesFunction(range.start)){
        this.semantic={regionId:region.id,model:res.model,result:res};
        if(this.store.get('currentRegion')===region)this.viewer.setBlockOverlay(region.id,buildOverlay(res.model));
      }
      return res;
    } catch { return null; }
  }

  _presentationMatchesFunction(start) {
    const sym=this.symbols;
    if(typeof sym?.functionAt!=='function')return true;
    const row=this.store.get('selectedRow');
    if(typeof row!=='number'||!Number.isSafeInteger(row)||row<0)return true;
    if(typeof this.viewer?.rowAddress!=='function')return true;
    let selected;
    try{selected=BigInt(this.viewer.rowAddress(row));}catch{return true;}
    let selectedFunction;
    let targetFunction;
    try{selectedFunction=sym.functionAt(selected);targetFunction=sym.functionAt(BigInt(start));}catch{return true;}
    if(selectedFunction?.start==null||targetFunction?.start==null)return true;
    try{return BigInt(selectedFunction.start)===BigInt(targetFunction.start);}catch{return true;}
  }

  /* ── 解析セッションの永続化 ───────────────────────────────── */

  _syncAutoReportWasmAnalysis(report = this.autoReport?.report) {
    const wa = report && typeof report === 'object' ? report.wasmAnalysis : null;
    if (wa && (wa !== this._lastIngestedWasmAnalysis || !this.v6Workbench?._wasmAnalysis)) {
      this._lastIngestedWasmAnalysis = wa;
      try { this.v6Workbench?.ingestWasmAnalysis?.(wa); } catch { /* non-fatal */ }
    }
  }

  demangleSymbolName(rawName, opts = null) {
    return this.v6Workbench?.demangleDisplayName?.(rawName, opts) ?? rawName;
  }

  getFunctionEnrichment(funcVa, opts = {}) {
    this._syncAutoReportWasmAnalysis();
    return this.v6Workbench?.getFunctionEnrichment?.(funcVa, opts) ?? null;
  }

  _scheduleV6PostAnalyzeHook(funcVa, decorated) {
    if (!decorated || !this.v6Workbench) return;
    try {
      this._syncAutoReportWasmAnalysis();
      if (funcVa != null && typeof this.v6Workbench.notifyAutoAnalysisUpdate === 'function') {
        this.v6Workbench.notifyAutoAnalysisUpdate();
      }
    } catch {
      // Best-effort non-fatal UI refresh.
    }
  }

  _ensureAutoAnalysisStatusDom() {
    if (typeof document === 'undefined' || !this.dom) return null;
    if (this.dom.stAuto && this.dom.stAutoText && this.dom.stAutoCancel) {
      return this.dom.stAuto;
    }
    const footer = this.dom.stLeft?.parentElement || document.querySelector?.('.statusbar') || null;
    if (!footer || typeof document.createElement !== 'function') return null;

    const wrap = document.createElement('span');
    wrap.id = 'st-auto';
    wrap.className = 'st-auto mono';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    wrap.hidden = true;
    if (wrap.style) {
      wrap.style.display = 'inline-flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '6px';
      wrap.style.marginLeft = 'auto';
      wrap.style.marginRight = '8px';
    }

    const textEl = document.createElement('span');
    textEl.id = 'st-auto-text';
    textEl.className = 'st-auto-text';

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'st-auto-cancel';
    cancelBtn.className = 'st-auto-cancel';
    cancelBtn.type = 'button';
    cancelBtn.hidden = true;
    cancelBtn.textContent = pick('停止', 'Stop');
    cancelBtn.setAttribute('aria-label', pick('バックグラウンド解析を停止', 'Stop background analysis'));
    if (cancelBtn.style) {
      cancelBtn.style.fontSize = '11px';
      cancelBtn.style.padding = '1px 6px';
      cancelBtn.style.borderRadius = '4px';
      cancelBtn.style.border = '1px solid currentColor';
      cancelBtn.style.background = 'transparent';
      cancelBtn.style.color = 'inherit';
      cancelBtn.style.cursor = 'pointer';
    }
    cancelBtn.addEventListener?.('click', () => {
      this.cancelBackgroundAutoAnalysis();
    });

    wrap.append(textEl, cancelBtn);
    if (this.dom.stRight && this.dom.stRight.parentElement === footer && typeof footer.insertBefore === 'function') {
      footer.insertBefore(wrap, this.dom.stRight);
    } else if (typeof footer.appendChild === 'function') {
      footer.appendChild(wrap);
    }

    this.dom.stAuto = wrap;
    this.dom.stAutoText = textEl;
    this.dom.stAutoCancel = cancelBtn;
    return wrap;
  }

  _renderAutoAnalysisStatus(state = this.getAutoAnalysisState()) {
    const model = formatStagedAutoAnalysisStatus(state);
    try { this.store?.set?.({ autoAnalysisStatus: model }); } catch { /* non-fatal */ }
    const wrap = this._ensureAutoAnalysisStatusDom();
    if (!wrap) return model;
    const hasFile = Boolean(this.store?.get?.('fileInfo'));
    if (!hasFile || !model.visible) {
      wrap.hidden = true;
      if (this.dom.stAutoText) this.dom.stAutoText.textContent = '';
      if (this.dom.stAutoCancel) this.dom.stAutoCancel.hidden = true;
      return model;
    }
    wrap.hidden = false;
    if (wrap.dataset) {
      wrap.dataset.state = model.running ? 'running' : (model.done ? 'done' : (model.cancelled ? 'cancelled' : 'idle'));
      wrap.dataset.stage = model.activeStage || '';
    }
    if (this.dom.stAutoText) this.dom.stAutoText.textContent = model.text;
    if (this.dom.stAutoCancel) {
      this.dom.stAutoCancel.hidden = !model.canCancel;
      this.dom.stAutoCancel.textContent = model.cancelLabel;
      this.dom.stAutoCancel.setAttribute('aria-label', pick('バックグラウンド解析を停止', 'Stop background analysis'));
    }
    return model;
  }

  cancelBackgroundAutoAnalysis() {
    return this.v6Workbench?.cancelStagedAutoAnalysis?.() ?? false;
  }

  _countRecoveredNamesSummary() {
    const sym = this.symbols;
    if (!sym || sym === EMPTY_INDEX) {
      return { named: 0, total: 0, objcCount: 0, swiftCount: 0, hexsigCount: 0, entries: [] };
    }
    const funcs = (Array.isArray(sym.funcs) || ArrayBuffer.isView(sym.funcs)) ? sym.funcs : (typeof sym.functionList === 'function' ? sym.functionList() : []);
    const total = Number.isFinite(sym.functionCount) ? sym.functionCount : funcs.length;
    let named = 0;
    let objcCount = 0;
    let swiftCount = 0;
    let hexsigCount = 0;
    const entries = [];
    for (let i = 0; i < funcs.length; i++) {
      const fn = funcs[i];
      const addr = typeof fn === 'bigint' ? fn : (fn?.start ?? fn?.va ?? fn?.addr ?? null);
      if (addr == null) continue;
      let vaBig;
      try { vaBig = typeof addr === 'bigint' ? addr : BigInt(addr); } catch { continue; }
      const name = typeof sym.nameAt === 'function' ? sym.nameAt(vaBig) : (fn?.name ?? null);
      if (!name || isStrippedFunctionName(name)) continue;
      named += 1;
      const prov = sym.nameProvenance?.get?.(vaBig.toString()) || null;
      const source = prov?.source || 'symbol';
      if (source === 'objc-runtime') objcCount += 1;
      else if (source === 'swift-metadata') swiftCount += 1;
      else if (source === 'hexsig') hexsigCount += 1;
      if (entries.length < 256 && (source === 'objc-runtime' || source === 'swift-metadata' || source === 'hexsig')) {
        entries.push({ va: `0x${vaBig.toString(16)}`, name, source });
      }
    }
    if (objcCount === 0 && Array.isArray(this.objcModel?.names)) {
      objcCount = this.objcModel.names.length;
    }
    if (hexsigCount === 0 && this.v6Workbench?._autoNamedFunctions?.size) {
      hexsigCount = this.v6Workbench._autoNamedFunctions.size;
    }
    return { named, total, objcCount, swiftCount, hexsigCount, entries };
  }

  _buildV6AutoProviders(epoch, sliceIndex) {
    const openedFileInfo = this.store?.get?.('fileInfo') ?? null;
    const isCurrent = () => (
      epoch === this.backend?.gen
      && this.store?.get?.('sliceIndex') === sliceIndex
      && (!openedFileInfo || this.store?.get?.('fileInfo') === openedFileInfo)
    );
    const cfg = this.v6Workbench?._autoAnalysisConfig || {};
    const cachedStagedAnalysis = this.lastDeltaRestore?.record?.resume?.stagedAutoAnalysis
      ?? this.v6Workbench?.exportStagedAutoAnalysisCache?.()
      ?? null;
    return {
      isCurrent,
      cachedStagedAnalysis,
      tilManifestUrl: cfg.tilManifestUrl ?? 'til-hub/manifest.json',
      tilBaseUrl: cfg.tilBaseUrl ?? 'til-hub',
      hexsigManifestUrl: cfg.hexsigManifestUrl ?? 'hexsig-hub/manifest.json',
      hexsigBaseUrl: cfg.hexsigBaseUrl ?? 'hexsig-hub',
      getBinaryMeta: () => {
        const slice = this.currentSlice?.();
        const info = slice?.info || this.store.get('fileInfo') || {};
        return {
          platform: info.platform || info.os || null,
          arch: this.store.get('architecture') || info.architecture || info.arch || null,
          format: info.format || null,
          dylibs: Array.isArray(info.dylibs) ? info.dylibs : [],
          frameworks: Array.isArray(info.frameworks) ? info.frameworks : [],
          hints: Array.isArray(info.hints) ? info.hints : [],
        };
      },
      getFunctions: () => {
        if (!isCurrent() || !this.symbols || this.symbols === EMPTY_INDEX) return [];
        const list = typeof this.symbols.functionList === 'function' ? this.symbols.functionList() : [];
        return Array.isArray(list) ? list : [];
      },
      readFunctionBytes: async (va, size) => {
        if (!isCurrent() || !this.backend || typeof this.backend.readAt !== 'function') return null;
        try {
          const vaBig = typeof va === 'bigint' ? va : BigInt(va);
          const region = this.executableRegionFor?.(vaBig);
          if (!region) return null;
          const regionStart = BigInt(region.vmAddr);
          const regionEnd = regionStart + BigInt(region.size ?? 0);
          if (vaBig < regionStart || vaBig >= regionEnd) return null;
          const remaining = regionEnd - vaBig;
          const requested = BigInt(Math.min(Math.max(1, Number(size || 256)), 4096));
          const readLen = Number(remaining < requested ? remaining : requested);
          if (!Number.isFinite(readLen) || readLen <= 0) return null;
          const res = await this.backend.readAt(vaBig, readLen, false, { priority: 'background' });
          if (res instanceof Uint8Array) return res;
          return res && res.found && res.bytes instanceof Uint8Array ? res.bytes : null;
        } catch {
          return null;
        }
      },
      getDeobfCandidates: () => {
        if (!isCurrent() || !this.symbols || this.symbols === EMPTY_INDEX) return [];
        const list = typeof this.symbols.functionList === 'function' ? this.symbols.functionList() : [];
        return Array.isArray(list) ? list : [];
      },
      loadDeobfCandidateInput: () => null,
      onAutoNamedBatch: (matches) => {
        if (!isCurrent() || !this.symbols || this.symbols === EMPTY_INDEX) return [];
        if (!Array.isArray(matches) || matches.length === 0) return [];
        const seenVas = new Set();
        const candidates = [];
        const toAdd = [];
        for (const m of matches) {
          const vaHex = normalizeVaHex(m?.vaHex);
          if (!vaHex || seenVas.has(vaHex) || typeof m?.newName !== 'string' || !m.newName) continue;
          seenVas.add(vaHex);
          let vaBig;
          try { vaBig = BigInt(vaHex); } catch { continue; }
          const decKey = vaBig.toString();
          // Guard 3: NoteStore user name protection
          const noteName = this.notes?.nameOf?.(vaBig)
            ?? this.notes?.names?.get?.(vaHex)
            ?? this.notes?.names?.get?.(decKey)
            ?? null;
          if (typeof noteName === 'string' && noteName.trim()) continue;
          // Guard 4: SymbolIndex user rename protection
          if (this.symbols.renamedAt?.(vaBig) || this.symbols.renames?.has?.(decKey)) continue;
          // Guard 5: Non-stripped existing symbol name protection
          const existingName = this.symbols.nameAt?.(vaBig) ?? null;
          if (existingName && !isStrippedFunctionName(existingName)) continue;

          candidates.push({ match: { ...m, vaHex }, vaBig });
          const rawScore = Number(m.score ?? 900);
          const confidence = Number.isFinite(rawScore)
            ? (rawScore > 100
              ? Math.min(1, Math.max(0, rawScore / 1000))
              : (rawScore > 1 ? Math.min(1, rawScore / 100) : Math.max(0, rawScore)))
            : 0.9;
          toAdd.push({
            addr: vaBig,
            name: m.newName,
            provenance: { source: 'hexsig', confidence, confirmed: false },
          });
        }
        if (toAdd.length > 0 && typeof this.symbols.addNames === 'function') {
          const added = this.symbols.addNames(toAdd, { source: 'hexsig', confidence: 0.9, confirmed: false });
          if (added > 0) {
            try { this.viewer?.setSymbols?.(this.symbols); } catch { /* non-fatal */ }
            try { this.viewer?.invalidate?.(); } catch { /* non-fatal */ }
          }
        }
        // Only return entries actually reflected in SymbolIndex so _autoNamedFunctions stays consistent.
        const accepted = [];
        for (const item of candidates) {
          if (typeof this.symbols.nameAt === 'function') {
            if (this.symbols.nameAt(item.vaBig) === item.match.newName) {
              accepted.push(item.match);
            }
          } else {
            accepted.push(item.match);
          }
        }
        return accepted;
      },
      recoverNames: async ({ signal, onProgress } = {}) => {
        if (!isCurrent() || signal?.aborted) return null;
        const reportProgress = () => {
          const summary = this._countRecoveredNamesSummary();
          onProgress?.({ completed: summary.named, total: summary.total });
          return summary;
        };
        reportProgress();
        const regions = this.store?.get?.('regions') || [];
        const hasCustomObjc = Object.prototype.hasOwnProperty.call(this, 'ensureObjcIndex')
          || Object.prototype.hasOwnProperty.call(this, 'ensureObjc');
        if ((regions.length > 0 || hasCustomObjc) && !signal?.aborted && isCurrent()) {
          try {
            if (typeof this.ensureObjcIndex === 'function') {
              await this.ensureObjcIndex({ priority: 'background', signal });
            } else if (typeof this.ensureObjc === 'function') {
              await this.ensureObjc(sliceIndex, { priority: 'background', signal });
            }
          } catch { /* fail-soft */ }
        }
        if (!isCurrent() || signal?.aborted) return null;
        reportProgress();

        const hasCustomSwift = Object.prototype.hasOwnProperty.call(this, 'ensureSwift');
        if ((regions.length > 0 || hasCustomSwift) && !signal?.aborted && isCurrent()) {
          try {
            await this.ensureSwift?.({ priority: 'background', signal });
          } catch { /* fail-soft */ }
        }
        if (!isCurrent() || signal?.aborted) return null;

        try { this.viewer?.setSymbols?.(this.symbols); } catch { /* non-fatal */ }
        try { this.syncSymbolsStore?.(true); } catch { /* non-fatal */ }
        try { this.updateChrome?.(); } catch { /* non-fatal */ }
        return reportProgress();
      },
      indexStrings: async ({ signal, onProgress } = {}) => {
        if (!isCurrent() || signal?.aborted) return null;
        const regions = this.store?.get?.('regions') || [];
        const hasCustomStrings = Object.prototype.hasOwnProperty.call(this, 'ensureStrings');
        let strings = this.stringIndex || null;
        if (!strings && (regions.length > 0 || hasCustomStrings) && typeof this.ensureStrings === 'function') {
          try {
            strings = await this.ensureStrings((p) => {
              if (signal?.aborted || !isCurrent()) return;
              onProgress?.({ completed: p?.done ?? 0, total: p?.all ?? 0 });
            });
          } catch {
            strings = null;
          }
        }
        if (!isCurrent() || signal?.aborted) return null;
        const count = Array.isArray(strings) ? strings.length : 0;
        try { this.store?.set?.({ stringsReady: true, stringsCount: count }); } catch { /* non-fatal */ }
        try { this.updateChrome?.(); } catch { /* non-fatal */ }
        return { count };
      },
      indexCallGraph: async ({ signal, onProgress } = {}) => {
        if (!isCurrent() || signal?.aborted) return null;
        const regions = this.store?.get?.('regions') || [];
        const hasCustomProgram = Object.prototype.hasOwnProperty.call(this, 'ensureProgram');
        let program = this.program || null;
        if (!program && (regions.length > 0 || hasCustomProgram) && typeof this.ensureProgram === 'function') {
          try {
            program = await this.ensureProgram((p) => {
              if (signal?.aborted || !isCurrent()) return;
              onProgress?.({ completed: p?.done ?? 0, total: p?.all ?? 0 });
            });
          } catch {
            program = null;
          }
        }
        if (!isCurrent() || signal?.aborted) return null;
        const functionCount = this.symbols?.functionCount ?? 0;
        const callCount = program?.callCount ?? this.programScan?.callCount ?? 0;
        const refCount = program?.refCount ?? this.programScan?.refCount ?? 0;
        try { this.store?.set?.({ programReady: Boolean(program) }); } catch { /* non-fatal */ }
        try { this.updateChrome?.(); } catch { /* non-fatal */ }
        return { functionCount, callCount, refCount };
      },
      rankGoalCandidates: async ({ signal } = {}) => {
        if (!isCurrent() || signal?.aborted) return null;
        let candidates = [];
        try {
          const guide = this.getBeginnerAutoGuide?.({ limit: 12 }) || null;
          const starters = Array.isArray(guide?.starterFunctions) ? guide.starterFunctions : [];
          candidates = starters.map((item) => ({
            vaHex: normalizeVaHex(item?.vaHex ?? item?.va ?? item?.addr ?? item?.start) || '',
            name: item?.displayName || item?.name || item?.vaHex || '',
            score: Number(item?.score ?? 0),
            reason: Array.isArray(item?.reasons) ? item.reasons.join(' / ') : String(item?.reason || ''),
            goal: item?.category || item?.goal || null,
          })).filter((c) => Boolean(c.vaHex));
        } catch {
          candidates = [];
        }
        if (!isCurrent() || signal?.aborted) return null;
        this.stagedGoalCandidates = candidates;
        try { this.store?.set?.({ goalCandidates: candidates }); } catch { /* non-fatal */ }
        try { this.updateChrome?.(); } catch { /* non-fatal */ }
        return { count: candidates.length, candidates };
      },
      onStageComplete: (stageId, result) => {
        if (!isCurrent()) return;
        try { this.updateChrome?.(); } catch { /* non-fatal */ }
        if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
          try {
            document.dispatchEvent(new CustomEvent('hex:auto-analysis-stage', {
              detail: { stage: stageId, result },
            }));
          } catch { /* non-fatal */ }
        }
        try { this.scheduleDeltaSave?.(); } catch { /* non-fatal */ }
        if (stageId === 'names' || stageId === 'goals') {
          try { void this.persistAnalysisSession?.(); } catch { /* non-fatal */ }
        }
      },
    };
  }

  _startV6AutoAnalysis(epoch, sliceIndex) {
    if (epoch !== this.backend.gen || this.store.get('sliceIndex') !== sliceIndex) return;
    try {
      this.v6?.onBinaryReady?.(
        this._currentDeltaFingerprint?.(),
        this._buildV6AutoProviders(epoch, sliceIndex),
      );
    } catch {
      /* non-fatal */
    }
  }

  getAutoAnalysisState() {
    return this.v6Workbench?.getAutoAnalysisState?.() ?? null;
  }

  subscribeAutoAnalysis(fn) {
    return this.v6Workbench?.subscribeAutoAnalysis?.(fn) ?? (() => {});
  }

  getBeginnerAutoGuide(opts = {}) {
    this._syncAutoReportWasmAnalysis();
    return this.v6Workbench?.getBeginnerAutoGuide?.(opts) ?? null;
  }

  getBeginnerFunctionGuide(funcVa, opts = {}) {
    this._syncAutoReportWasmAnalysis();
    return this.v6Workbench?.getBeginnerFunctionGuide?.(funcVa, opts) ?? null;
  }

  mountBeginnerWorkflowPanel(container, opts = {}) {
    this._syncAutoReportWasmAnalysis();
    return this.v6Workbench?.mountBeginnerWorkflowPanel?.(container, opts) ?? null;
  }

  async persistAnalysisSession(fields = null) {
    this._syncAutoReportWasmAnalysis();
    if (this.sampleOpen || !this.store.get('fileInfo')) return false;
    const sliceIndex = this.store.get('sliceIndex');
    if (!Number.isSafeInteger(sliceIndex) || sliceIndex < 0) return false;
    let binaryId = this.backend?.binaryId || null;
    if (!binaryId) {
      try { binaryId = await this.backend.ensureBinaryId(); }
      catch { return false; }
    }
    if (!binaryId || this.store.get('sliceIndex') !== sliceIndex) return false;
    try {
      return await this.analysisResume.save(binaryId, sliceIndex, captureAppAnalysisState(this, fields));
    } catch {
      return false;
    }
  }

  async restoreAnalysisSession(binaryId, sliceIndex, epoch = this.backend.gen) {
    if (!binaryId || !Number.isSafeInteger(sliceIndex) || sliceIndex < 0) return false;
    try {
      const snapshot = await this.analysisResume.load(binaryId, sliceIndex);
      if (!snapshot || epoch !== this.backend.gen || this.store.get('sliceIndex') !== sliceIndex) return false;
      const restored = applyAppAnalysisState(this, snapshot);
      if (restored) this._syncAutoReportWasmAnalysis();
      if (!restored) await this.analysisResume.delete(binaryId, sliceIndex).catch(() => false);
      return restored;
    } catch {
      await this.analysisResume.delete(binaryId, sliceIndex).catch(() => false);
      return false;
    }
  }

  async restoreLastAnalysisFile() {
    if (this.store.get('fileInfo')) return false;
    try {
      const saved = await this.analysisResume.loadLastFile();
      if (!saved?.file || this.store.get('fileInfo')) return false;
      await this.openFile(saved.file, { restored:true });
      return !!this.store.get('fileInfo');
    } catch {
      return false;
    }
  }

  /* ── 編集 Undo / Redo スタック ───────────────────────────── */

  recordUndo(entry) {
    if (this._applyingUndo || !entry || typeof entry !== 'object') return false;
    if (entry.type !== 'name' && entry.type !== 'comment' && entry.type !== 'patch') return false;
    this._undoStack.push(entry);
    if (this._undoStack.length > this._undoLimit) {
      this._undoStack.splice(0, this._undoStack.length - this._undoLimit);
    }
    this._redoStack.length = 0;
    return true;
  }

  _applyUndoEntry(entry, direction) {
    const isUndo = direction === 'undo';
    if (entry.type === 'name') {
      const addr = BigInt(entry.addr);
      const value = isUndo ? (entry.before ?? '') : (entry.after ?? '');
      if (this.notes && this.notes !== EMPTY_NOTES) this.notes.setName(addr, value);
      if (this.symbols && this.symbols !== EMPTY_INDEX) this.symbols.rename(addr, value);
      this.viewer?.setSymbols?.(this.symbols);
      this.syncSymbolsStore();
      this.updateChrome?.();
      toast(isUndo ? pick('名前の変更を元に戻しました', 'Undid rename') : pick('名前の変更をやり直しました', 'Redid rename'));
      return true;
    }
    if (entry.type === 'comment') {
      const addr = BigInt(entry.addr);
      const value = isUndo ? (entry.before ?? '') : (entry.after ?? '');
      if (this.notes && this.notes !== EMPTY_NOTES) this.notes.setComment(addr, value);
      this.viewer?.invalidate?.();
      this.updateChrome?.();
      toast(isUndo ? pick('コメントの変更を元に戻しました', 'Undid comment edit') : pick('コメントの変更をやり直しました', 'Redid comment edit'));
      return true;
    }
    if (entry.type === 'patch') {
      const offset = BigInt(entry.offset);
      const isRemoval = entry.action === 'remove' || entry.after == null;
      try {
        const metaOf = (p, fallback) => p?.meta || (p && (p.addr != null || p.text != null) ? { addr: p.addr, text: p.text } : fallback);
        if (isUndo) {
          if (isRemoval && entry.before) {
            const prev = entry.before;
            if (prev && typeof prev === 'object' && !ArrayBuffer.isView(prev) && !Array.isArray(prev) && prev.before && prev.after) {
              this.patches.add(offset, prev.before, prev.after, metaOf(prev, entry.meta));
            } else if (entry.origBytes) {
              this.patches.add(offset, entry.origBytes, prev, entry.meta);
            }
          } else if (entry.prevPatch && entry.prevPatch.before && entry.prevPatch.after) {
            this.patches.add(offset, entry.prevPatch.before, entry.prevPatch.after, metaOf(entry.prevPatch, entry.meta));
          } else {
            this.patches.remove(offset);
          }
        } else {
          if (isRemoval) {
            this.patches.remove(offset);
          } else {
            this.patches.add(offset, entry.before, entry.after, entry.meta);
          }
        }
      } catch {
        toast(pick('パッチの元に戻す/やり直しが競合しました', 'Patch undo/redo conflicted with another patch'));
        return false;
      }
      this.store.set({ patches: this.patches.size });
      this.viewer?.invalidate?.();
      this.updateChrome?.();
      toast(isUndo ? pick('パッチを元に戻しました', 'Undid patch') : pick('パッチをやり直しました', 'Redid patch'));
      return true;
    }
    return false;
  }

  clearUndoHistory() {
    this._undoStack.length = 0;
    this._redoStack.length = 0;
  }

  undoEdit() {
    if (!this._undoStack.length) return false;
    const entry = this._undoStack.pop();
    this._applyingUndo = true;
    try {
      const ok = this._applyUndoEntry(entry, 'undo');
      if (ok) {
        this._redoStack.push(entry);
        if (this._redoStack.length > this._undoLimit) {
          this._redoStack.splice(0, this._redoStack.length - this._undoLimit);
        }
      }
      return ok;
    } finally {
      this._applyingUndo = false;
    }
  }

  redoEdit() {
    if (!this._redoStack.length) return false;
    const entry = this._redoStack.pop();
    this._applyingUndo = true;
    try {
      const ok = this._applyUndoEntry(entry, 'redo');
      if (ok) {
        this._undoStack.push(entry);
        if (this._undoStack.length > this._undoLimit) {
          this._undoStack.splice(0, this._undoStack.length - this._undoLimit);
        }
      }
      return ok;
    } finally {
      this._applyingUndo = false;
    }
  }

  /* ── 軽量デルタセッション永続化 ───────────────────────────── */

  _currentDeltaFingerprint() {
    const info = this.store.get('fileInfo') || null;
    const file = this.store.get('file') || null;
    if (!info && !file) return null;
    const sliceIndex = this.store.get('sliceIndex') ?? -1;
    const slice = sliceIndex >= 0 ? info?.slices?.[sliceIndex] || null : null;
    const meta = slice?.info || {};
    const rawHash = this.backend?.contentHash || this.backend?.binaryId || null;
    const sha256 = typeof rawHash === 'string' && rawHash.trim() ? rawHash.trim().toLowerCase().replace(/^bin_sha256_/, '') : null;
    return {
      sha256,
      prefix: sha256 ? sha256.slice(0, 16) : null,
      name: info?.name || file?.name || null,
      size: info?.size ?? file?.size ?? null,
      format: info?.format || this.backend?.formatId || null,
      sliceIndex,
      uuid: meta.uuid || null,
      architecture: this.store.get('architecture') || meta.architecture || meta.cpu || null,
    };
  }

  _createPatchSet(patches = new PatchSet()) {
    const wrap = (method) => {
      const orig = patches[method].bind(patches);
      patches[method] = (...args) => {
        const result = orig(...args);
        if (!this._applyingDelta && this.patches === patches) {
          this.store.set({ patches: this.patches.size });
          this.scheduleDeltaSave();
        }
        return result;
      };
    };
    wrap('add');
    wrap('remove');
    wrap('clear');
    return patches;
  }

  setUiResume(patch) {
    if (!patch || typeof patch !== 'object') return false;
    let changed = false;
    if ('explorerFilter' in patch) {
      const val = patch.explorerFilter;
      if (typeof val === 'string' && VALID_EXPLORER_FILTERS.has(val) && this.uiResume.explorerFilter !== val) {
        this.uiResume.explorerFilter = val;
        changed = true;
      }
    }
    if ('explorerSort' in patch) {
      const val = patch.explorerSort;
      if (typeof val === 'string' && VALID_EXPLORER_SORTS.has(val) && this.uiResume.explorerSort !== val) {
        this.uiResume.explorerSort = val;
        changed = true;
      }
    }
    if ('lastFunctionTab' in patch) {
      const val = patch.lastFunctionTab;
      const normalized = val === null ? null : (typeof val === 'string' && VALID_FUNCTION_TABS.has(val) ? val : undefined);
      if (normalized !== undefined && this.uiResume.lastFunctionTab !== normalized) {
        this.uiResume.lastFunctionTab = normalized;
        changed = true;
      }
    }
    if (changed && !this._applyingDelta) {
      this.scheduleDeltaSave();
    }
    return changed;
  }

  _currentDeltaKey() {
    const fp = this._currentDeltaFingerprint();
    return fp ? makeDeltaKey(fp) : null;
  }

  _captureDeltaRecord() {
    const fingerprint = this._currentDeltaFingerprint();
    const notes = this.notes;
    const hasNotes = Boolean(notes && notes !== EMPTY_NOTES);
    const currentRegion = this.store.get('currentRegion') || null;
    const currentAddress = this.store.get('currentAddress') ?? null;
    const currentFn = currentAddress != null ? (this.symbols?.functionAt?.(currentAddress)?.start ?? null) : null;
    const patches = (this.patches?.list?.() || []).map((entry) => ({
      offset: entry.offset,
      before: Array.from(entry.before || [], (b) => Number(b) & 255),
      after: Array.from(entry.after || [], (b) => Number(b) & 255),
      addr: entry.addr ?? null,
      text: entry.text ?? null,
      label: entry.label ?? null,
      reason: entry.reason ?? null,
    }));
    const delta = {
      names: hasNotes ? Object.fromEntries(notes.names) : {},
      comments: hasNotes ? Object.fromEntries(notes.comments) : {},
      vars: hasNotes ? Object.fromEntries(notes.vars) : {},
      types: hasNotes ? Object.fromEntries(notes.types) : {},
      structs: hasNotes && Array.isArray(notes.structs) ? notes.structs.slice() : [],
      bookmarks: this.bookmarks?.list?.() || [],
      patches,
      projectAnnotations: Array.isArray(this.projectAnnotations) ? this.projectAnnotations.slice() : [],
    };
    const routePath = this.store.get('routePath')
      || (typeof window !== 'undefined' && window.location?.hash ? window.location.hash.replace(/^#/, '') : null)
      || null;
    const resume = {
      lastAddress: currentAddress,
      lastFunction: currentFn,
      lastRegionId: currentRegion?.id ?? null,
      displayMode: this.store.get('displayMode') || null,
      routePath,
      history: (this.navigation?.entries || []).slice(-100),
      historyIndex: Number.isSafeInteger(this.navigation?.index) ? this.navigation.index : -1,
      lastGoal: this.lastGoal?.text ? { text: String(this.lastGoal.text) } : null,
      explorerFilter: this.uiResume?.explorerFilter || 'all',
      explorerSort: this.uiResume?.explorerSort || 'address',
      lastFunctionTab: this.uiResume?.lastFunctionTab ?? null,
      stagedAutoAnalysis: this.v6?.exportStagedAutoAnalysisCache?.() ?? null,
    };
    const v6Delta = this.v6?.exportV2DeltaFields?.() || {};
    Object.assign(delta, v6Delta);
    return {
      format: 'hex-delta-session',
      version: DELTA_SESSION_VERSION,
      fingerprint,
      updatedAt: Date.now(),
      savedCount: countDeltaItems(delta),
      delta,
      resume,
    };
  }

  _applyDeltaRecord(record, { restoreNavigation = true, mergeExisting = false } = {}) {
    if (!record || typeof record !== 'object' || !record.delta) return false;
    this._applyingDelta = true;
    try {
      const { delta, resume = {} } = record;
      const notes = this.notes;
      const previousNoteNames = notes && notes !== EMPTY_NOTES ? [...notes.names.keys()] : [];
      if (notes && notes !== EMPTY_NOTES) {
        const preNames = mergeExisting ? new Map(notes.names) : null;
        const preComments = mergeExisting ? new Map(notes.comments) : null;
        const preVars = mergeExisting ? new Map(notes.vars) : null;
        const preTypes = mergeExisting ? new Map(notes.types) : null;
        notes.names.clear();
        notes.comments.clear();
        notes.vars.clear();
        notes.types.clear();
        for (const [k, v] of Object.entries(delta.names || {})) notes.names.set(k, v);
        for (const [k, v] of Object.entries(delta.comments || {})) notes.comments.set(k, v);
        for (const [k, v] of Object.entries(delta.vars || {})) notes.vars.set(k, v);
        for (const [k, v] of Object.entries(delta.types || {})) notes.types.set(k, v);
        if (mergeExisting) {
          for (const [k, v] of preNames) notes.names.set(k, v);
          for (const [k, v] of preComments) notes.comments.set(k, v);
          for (const [k, v] of preVars) notes.vars.set(k, v);
          for (const [k, v] of preTypes) notes.types.set(k, v);
        }
        notes.structs = Array.isArray(delta.structs) ? delta.structs.slice() : [];
        notes.dirty = true;
        if (notes.id) notes.save();
      }

      if (this.bookmarks) {
        this.bookmarks.restore(Array.isArray(delta.bookmarks) ? delta.bookmarks : []);
      }

      if (this.patches?.clear) {
        this.patches.clear();
        for (const entry of delta.patches || []) {
          if (entry?.offset == null) continue;
          try {
            this.patches.add(BigInt(entry.offset), entry.before || [], entry.after || [], {
              addr: entry.addr ?? null,
              text: entry.text ?? null,
              label: entry.label ?? null,
              reason: entry.reason ?? null,
            });
          } catch { /* ignore invalid/overlapping patch entries */ }
        }
        this.store.set({ patches: this.patches.list().length });
      }

      this.projectAnnotations = Array.isArray(delta.projectAnnotations)
        ? delta.projectAnnotations.slice()
        : [];
      this.v6?.importV2DeltaFields?.(delta);

      if (this.symbols && this.symbols !== EMPTY_INDEX) {
        for (const addrKey of previousNoteNames) {
          try { this.symbols.rename(BigInt(addrKey), ''); } catch { /* ignore */ }
        }
        if (notes && notes !== EMPTY_NOTES) {
          for (const entry of notes.nameEntries()) this.symbols.rename(entry.addr, entry.name);
        } else {
          for (const [k, v] of Object.entries(delta.names || {})) {
            try { this.symbols.rename(BigInt(k), v); } catch { /* ignore */ }
          }
        }
        this.viewer?.setSymbols?.(this.symbols);
        this.syncSymbolsStore();
      }

      if (resume.lastGoal?.text) {
        this.lastGoal = { text: resume.lastGoal.text };
      }
      if (resume.stagedAutoAnalysis) {
        this.v6?.restoreStagedAutoAnalysis?.(resume.stagedAutoAnalysis);
        this.stagedGoalCandidates = Array.isArray(resume.stagedAutoAnalysis.goalCandidatesSummary)
          ? resume.stagedAutoAnalysis.goalCandidatesSummary.slice()
          : [];
        try { this.store?.set?.({ goalCandidates: this.stagedGoalCandidates }); } catch { /* non-fatal */ }
        const cachedEntries = resume.stagedAutoAnalysis.recoveredNamesSummary?.entries;
        if (Array.isArray(cachedEntries) && cachedEntries.length > 0 && this.symbols && this.symbols !== EMPTY_INDEX && typeof this.symbols.addNames === 'function') {
          const toAdd = [];
          for (const entry of cachedEntries) {
            if (!entry?.va || !entry?.name) continue;
            let vaBig;
            try { vaBig = BigInt(entry.va); } catch { continue; }
            const decKey = vaBig.toString();
            const noteName = notes && notes !== EMPTY_NOTES ? (notes.nameOf?.(vaBig) ?? notes.names?.get?.(decKey) ?? null) : null;
            if (typeof noteName === 'string' && noteName.trim()) continue;
            if (this.symbols.renamedAt?.(vaBig) || this.symbols.renames?.has?.(decKey)) continue;
            const existingName = this.symbols.nameAt?.(vaBig) ?? null;
            if (existingName && !isStrippedFunctionName(existingName)) continue;
            toAdd.push({
              addr: vaBig,
              name: entry.name,
              provenance: { source: entry.source || 'auto', confidence: 0.95, confirmed: false },
            });
          }
          if (toAdd.length > 0) {
            const added = this.symbols.addNames(toAdd);
            if (added > 0) {
              this.viewer?.setSymbols?.(this.symbols);
              this.syncSymbolsStore();
            }
          }
        }
      }

      if (resume.displayMode === 'asm' || resume.displayMode === 'hex') {
        if (resume.displayMode === 'hex' || this.store.get('canDisassemble')) {
          this.setMode(resume.displayMode);
        }
      }

      this.restoredRoutePath = typeof resume.routePath === 'string' && resume.routePath.trim()
        ? resume.routePath.trim()
        : null;

      this.uiResume = {
        explorerFilter: typeof resume.explorerFilter === 'string' && VALID_EXPLORER_FILTERS.has(resume.explorerFilter)
          ? resume.explorerFilter
          : 'all',
        explorerSort: typeof resume.explorerSort === 'string' && VALID_EXPLORER_SORTS.has(resume.explorerSort)
          ? resume.explorerSort
          : 'address',
        lastFunctionTab: typeof resume.lastFunctionTab === 'string' && VALID_FUNCTION_TABS.has(resume.lastFunctionTab)
          ? resume.lastFunctionTab
          : null,
      };

      if (restoreNavigation && this.navigation && Array.isArray(resume.history) && resume.history.length) {
        const limit = this.navigation.limit > 0 ? this.navigation.limit : 40;
        this.navigation.entries = resume.history.slice(-limit);
        const dropped = resume.history.length - this.navigation.entries.length;
        const idx = Number(resume.historyIndex);
        this.navigation.index = Number.isSafeInteger(idx)
          ? Math.max(0, Math.min(this.navigation.entries.length - 1, idx - dropped))
          : this.navigation.entries.length - 1;
        this.navigation.onChange?.(this.navigation.snapshot());
      }

      if (restoreNavigation && resume.lastAddress != null) {
        const regions = this.store.get('regions') || [];
        const target = regions.find(
          (r) => !r.zerofill && r.size > 0n && resume.lastAddress >= r.vmAddr && resume.lastAddress < r.vmAddr + r.size,
        );
        if (target) this.goToAddress(resume.lastAddress, { history: false });
      } else if (restoreNavigation && resume.lastRegionId) {
        const regions = this.store.get('regions') || [];
        const target = regions.find((r) => r.id === resume.lastRegionId && !r.zerofill && r.size > 0n);
        if (target) this.selectRegion(target, { silent: true });
      }

      this.updateChrome?.();
      return true;
    } finally {
      this._applyingDelta = false;
    }
  }

  _isDeltaReady() {
    return this._deltaReadyEpoch === this.backend.gen && this._deltaReadySlice === this.store.get('sliceIndex');
  }

  _resetDeltaReadiness() {
    this._deltaReadyEpoch = -1;
    this._deltaReadySlice = -1;
    if (this._deltaSaveTimer != null) {
      clearTimeout(this._deltaSaveTimer);
      this._deltaSaveTimer = null;
    }
  }

  scheduleDeltaSave() {
    if (this.sampleOpen || !this.store.get('fileInfo') || !this._isDeltaReady()) return false;
    if (this._deltaSaveTimer != null) clearTimeout(this._deltaSaveTimer);
    this._deltaSaveTimer = setTimeout(() => {
      this._deltaSaveTimer = null;
      void this.flushDeltaSave();
    }, 400);
    return true;
  }

  async flushDeltaSave() {
    if (this._deltaSaveTimer != null) {
      clearTimeout(this._deltaSaveTimer);
      this._deltaSaveTimer = null;
    }
    if (this.sampleOpen || !this.store.get('fileInfo') || !this._isDeltaReady()) return false;
    const deltaKey = this._currentDeltaKey();
    if (!deltaKey) return false;
    try {
      return await this.deltaSession.save(deltaKey, this._captureDeltaRecord());
    } catch {
      return false;
    }
  }

  async restoreDeltaSession(epoch = this.backend.gen, sliceIndex = this.store.get('sliceIndex')) {
    if (this.sampleOpen || !this.store.get('fileInfo')) return null;
    if (epoch !== this.backend.gen || this.store.get('sliceIndex') !== sliceIndex) return null;
    if (this._isDeltaReady()) return this.lastDeltaRestore;
    const deltaKey = this._currentDeltaKey();
    if (!deltaKey) return null;
    let record = null;
    try {
      record = await this.deltaSession.load(deltaKey);
      if (!record || epoch !== this.backend.gen || this.store.get('sliceIndex') !== sliceIndex || this._isDeltaReady()) return null;
      this._applyDeltaRecord(record, { restoreNavigation: true, mergeExisting: true });
      const restoreInfo = {
        deltaKey,
        savedCount: record.savedCount,
        updatedAt: record.updatedAt,
        restoredRoutePath: this.restoredRoutePath,
        lastAddress: record.resume?.lastAddress ?? null,
        record,
      };
      this.lastDeltaRestore = restoreInfo;
      this.store.set({ deltaRestored: restoreInfo });
      if (typeof this.onDeltaRestored === 'function') {
        try { this.onDeltaRestored(restoreInfo); } catch { /* observer isolation */ }
      }
      return restoreInfo;
    } catch {
      return null;
    } finally {
      if (epoch === this.backend.gen && this.store.get('sliceIndex') === sliceIndex) {
        this._deltaReadyEpoch = epoch;
        this._deltaReadySlice = sliceIndex;
      }
    }
  }

  exportDeltaJson() {
    if (!this.store.get('fileInfo')) throw new Error('open-file-first');
    const record = this._captureDeltaRecord();
    const json = serializeDeltaJson(record);
    const clean = String(record.fingerprint?.name || 'analysis')
      .replace(/[^a-z0-9._-]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'analysis';
    return {
      filename: `${clean}.hexdelta.json`,
      json,
      savedCount: record.savedCount,
    };
  }

  async importDeltaJson(text, { allowMismatch = false } = {}) {
    if (!this.store.get('fileInfo')) throw new Error('open-file-first');
    const expectedSha256 = this._currentDeltaFingerprint()?.sha256 || null;
    const parsed = parseDeltaJson(text, expectedSha256);
    if (!parsed.ok) {
      return { ok: false, hashMismatch: false, error: parsed.error, savedCount: 0 };
    }
    if (parsed.hashMismatch && !allowMismatch) {
      return {
        ok: false,
        hashMismatch: true,
        error: 'binary-hash-mismatch',
        record: parsed.record,
        savedCount: parsed.record.savedCount,
      };
    }
    this._deltaReadyEpoch = this.backend.gen;
    this._deltaReadySlice = this.store.get('sliceIndex');
    this._applyDeltaRecord(parsed.record, { restoreNavigation: true });
    await this.flushDeltaSave();
    this.workspace?.autosave?.();
    this.viewer?.setSymbols?.(this.symbols);
    this.syncSymbolsStore();
    this.updateChrome?.();
    return {
      ok: true,
      hashMismatch: parsed.hashMismatch,
      error: null,
      record: parsed.record,
      savedCount: parsed.record.savedCount,
    };
  }

  async resetDeltaSession() {
    if (this._deltaSaveTimer != null) {
      clearTimeout(this._deltaSaveTimer);
      this._deltaSaveTimer = null;
    }
    this._deltaReadyEpoch = this.backend.gen;
    this._deltaReadySlice = this.store.get('sliceIndex');
    const deltaKey = this._currentDeltaKey();
    if (deltaKey) {
      try { await this.deltaSession.remove(deltaKey); } catch { /* best effort */ }
    }
    this._applyingDelta = true;
    try {
      const previousNoteNames = this.notes && this.notes !== EMPTY_NOTES ? [...this.notes.names.keys()] : [];
      if (this.notes && this.notes !== EMPTY_NOTES) this.notes.clear();
      this._undoStack.length = 0;
      this._redoStack.length = 0;
      this.bookmarks?.clear?.({ silent: false });
      if (this.patches?.clear) {
        this.patches.clear();
        this.store.set({ patches: 0 });
      }
      this.projectAnnotations = [];
      this.lastGoal = null;
      if (this.symbols && this.symbols !== EMPTY_INDEX) {
        for (const addrKey of previousNoteNames) {
          try { this.symbols.rename(BigInt(addrKey), ''); } catch { /* ignore */ }
        }
        this.viewer?.setSymbols?.(this.symbols);
        this.syncSymbolsStore();
      }
      const region = this.store.get('currentRegion');
      this.navigation?.reset?.(region ? this.navigationEntry(region.vmAddr, pick('解析の開始', 'Analysis start')) : null);
      this.lastDeltaRestore = null;
      this.restoredRoutePath = null;
      this.uiResume = { explorerFilter: 'all', explorerSort: 'address', lastFunctionTab: null };
      this.store.set({ deltaRestored: null });
      this.updateChrome?.();
    } finally {
      this._applyingDelta = false;
    }
    return true;
  }

  listRecentDeltaBinaries({ onlyWithDelta = true, limit = 10 } = {}) {
    return this.deltaSession.listRecent({ onlyWithDelta, limit });
  }

  /* ── ファイルを開く ───────────────────────────────────────── */

  async openFile(file, opts) {
    if (!file) return;
    void this.flushDeltaSave();
    void this.persistAnalysisSession();
    if (file.size === 0) { alertDialog(t('err.emptyTitle'), t('err.emptyText')); return; }
    const sampleOpen = !!(opts && opts.sample);
    const restoredOpen = !!(opts && opts.restored);
    this.workspace?.autosave();
    this.setBusy(true, t('status.reading', { name:file.name }));
    let info;
    try { info = await this.backend.open(file); }
    catch (err) {
      if (err && err.stale) return;
      this.setBusy(false);
      alertDialog(t('err.openTitle'), friendly(err.message));
      return;
    }
    const openEpoch=this.backend.gen;
    this.analysisResumeReady = Promise.resolve(false);
    this.workspace?.invalidate();
    this.activeProject=null;
    closeAllSheets();
    this.sampleOpen=sampleOpen;
    this.detailRefresh=null;
    this.forgetSemantics(true);
    this.symbols=EMPTY_INDEX;
    this.symbolsReady=null;
    this.viewer.setSymbols(EMPTY_INDEX);
    this.store.set({ symbolsGen: 0, symbolsReady: false });
    this.store.set({file,fileInfo:info,selectedRow:-1});
    let sliceIndex=-1;
    if (info.slices.length) {
      sliceIndex=info.slices.findIndex((entry)=>entry.info && entry.info.isArm64);
      if (sliceIndex < 0) sliceIndex=info.slices.findIndex((entry)=>entry.info);
    }
    this._resetDeltaReadiness();
    this.noteAttachController?.abort();
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this.notes=EMPTY_NOTES;
    this.projectAnnotations = [];
    this.bookmarks?.clear?.({ silent: true });
    this.lastDeltaRestore=null;
    this.restoredRoutePath=null;
    this.uiResume = { explorerFilter: 'all', explorerSort: 'address', lastFunctionTab: null };
    this.store.set({ deltaRestored: null });
    this.patches=this._createPatchSet();
    this.store.set({patches:0});
    this.setBusy(false);
    this.applySlice(sliceIndex,info);
    const projectReady = this.attachNotes(file,info,sliceIndex,openEpoch)
      .then(()=>this.workspace?.bind())
      .then((project)=>{if(project)this.activeProject=project; return project;})
      .catch(()=>null);
    const baseSymbolsReady = this.analysisBaseSymbolsReady || this.symbolsReady || Promise.resolve();
    if (!sampleOpen && !restoredOpen) void this.analysisResume.saveLastFile(file, { sliceIndex }).catch(() => {});
    this.analysisResumeReady = Promise.allSettled([projectReady, baseSymbolsReady]).then(async () => {
      if (openEpoch !== this.backend.gen || this.store.get('sliceIndex') !== sliceIndex) return false;
      let binaryId = this.backend.binaryId;
      if (!binaryId) {
        try {
          binaryId = await this.backend.ensureBinaryId({ priority: 'current' });
        } catch {
          if (openEpoch === this.backend.gen && this.store.get('sliceIndex') === sliceIndex) {
            this._startV6AutoAnalysis(openEpoch, sliceIndex);
          }
          return false;
        }
      }
      if (openEpoch !== this.backend.gen || this.store.get('sliceIndex') !== sliceIndex) return false;
      if (!sampleOpen) void this.analysisResume.updateLastFileMeta({ binaryId, sliceIndex }).catch(() => {});
      let restored = false;
      try { restored = await this.restoreAnalysisSession(binaryId, sliceIndex, openEpoch); } catch { /* non-fatal */ }
      if (!sampleOpen) {
        try { await this.restoreDeltaSession(openEpoch, sliceIndex); } catch { /* non-fatal */ }
      }
      this._startV6AutoAnalysis(openEpoch, sliceIndex);
      if (!restored && !sampleOpen) void this.persistAnalysisSession(['symbols']);
      if (restored && restoredOpen) toast(pick('前回の解析結果を復元しました', 'Restored the previous analysis results'));
      return restored;
    }).catch(() => false);
    if (info.warnings && info.warnings.length) toast(info.warnings[0]);
    const slice=this.currentSlice();
    if (slice && slice.info && slice.info.encrypted) alertDialog(t('err.encryptedTitle'),t('err.encryptedText'));
    document.dispatchEvent(new CustomEvent('hex:file-opened',{detail:{name:info.name,sample:this.sampleOpen}}));
    if (this.sampleOpen) setTimeout(() => { if (openEpoch === this.backend.gen && this.sampleOpen) showSampleGuide(this); }, 250);
  }

  async attachNotes(file, info, sliceIndex, epoch = this.backend.gen) {
    this.noteAttachController?.abort();
    const controller=new AbortController();
    this.noteAttachController=controller;
    try {
      const [binaryId, legacyV2] = await Promise.all([
        this.backend.ensureBinaryId({ signal:controller.signal, priority:'current' }),
        legacyV2NoteKeyFor(file,info,sliceIndex),
      ]);
      if (controller.signal.aborted || epoch !== this.backend.gen || this.store.get('file') !== file || this.store.get('sliceIndex') !== sliceIndex) return null;
      const id=noteKeyFromBinaryId(file,info,sliceIndex,binaryId);
      // Discover an existing v3 namespace cheaply; do not re-hash the active slice
      // on every cold open merely to learn whether migration data exists.
      const legacyV3=findLegacyV3NoteKey(file,info,sliceIndex);
      const notes=new NoteStore(id,[legacyV3,legacyV2,legacyNoteKeyForSlice(file,info,sliceIndex)]);
      notes.onChange = () => {
        this.viewer?.invalidate?.();
        if (this._applyingDelta) return;
        this.scheduleDeltaSave();
        this.workspace?.autosave?.();
      };
      this.notes=notes;
      if (this.symbols && this.symbols !== EMPTY_INDEX) {
        for (const entry of notes.nameEntries()) this.symbols.rename(entry.addr,entry.name);
        this.viewer.setSymbols(this.symbols);
        this.syncSymbolsStore();
        this.updateChrome();
      } else {
        this.viewer?.invalidate?.();
      }
      document.dispatchEvent(new CustomEvent('hex:notes-attached',{detail:{sliceIndex}}));
      return notes;
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || controller.signal.aborted) return null;
      return null;
    } finally {
      if (this.noteAttachController === controller) this.noteAttachController=null;
    }
  }

  /** 練習用のサンプルをその場で組み立てて開く。 */
  async openSample() {
    try {
      const file = makeSampleFile();
      await this.openFile(file, { sample: true });
    } catch (err) {
      alertDialog(t('err.openTitle'), friendly(err && err.message));
    }
  }

  applySlice(sliceIndex, infoArg) {
    const epoch = this.backend.gen;
    const info = infoArg || this.store.get('fileInfo');
    const slice = sliceIndex >= 0 ? info.slices[sliceIndex] : null;
    const regions = slice ? slice.regions : [];
    const capability = slice?.capability || info?.capability || { architecture:slice?.info?.architecture || (slice?.info?.isArm64?'arm64':'unknown'), canDisassemble:!!slice?.info?.isArm64, analysisLevel:!!slice?.info?.isArm64?'full':'data-only', limitations:[], instructionAlignment:slice?.info?.isArm64?4:1 };
    const arch = capability.architecture || slice?.info?.architecture || slice?.info?.cpu || null;
    const canDisassemble = capability.canDisassemble === true || capability.viewerCanDisassemble === true;
    this.store.set({ sliceIndex, regions, architecture: arch, canDisassemble, capability, analysisLevel:capability.analysisLevel||'data-only', limitations:capability.limitations||[], instructionAlignment:Math.max(1,Number(capability.instructionAlignment||capability.fixedInstructionSize||1)) });

    const mode = canDisassemble ? this.preferredMode : 'hex';
    this.store.set({ displayMode: mode });
    this.viewer.setMode(mode);
    this.updateModeUI();

    const region = this.pickDefaultRegion(regions, info);
    this.selectRegion(region, { silent: true });
    this.navigation.reset(region ? this.navigationEntry(region.vmAddr, pick('解析の開始', 'Analysis start')) : null);

    if (canDisassemble) {
      this.backend.probe().catch((err) => {
        if (epoch !== this.backend.gen || (err && err.stale)) return;
        this.store.set({ canDisassemble: false, displayMode: 'hex' });
        this.viewer.setMode('hex');
        this.updateChrome();
        alertDialog(t('err.engineTitle'), friendly(err.message));
      });
    } else if (slice && slice.info) {
      toast(t('err.notArm64', { arch }));
    }

    // 名前と関数の一覧はここで作る。失敗しても表示自体は続けられる。
    if (sliceIndex >= 0) {
      this.symbolsReadyEpoch = epoch;
      const baseSymbolsReady = this.backend.analyze(sliceIndex).then((res) => {
        if (epoch !== this.backend.gen || this.store.get('sliceIndex') !== sliceIndex) return false;
        // Backend symbol results are slice-global starts, but containment needs
        // the active slice's executable region boundaries. Bind them at the
        // replacement point so every consumer (ProgramIndex, panels, Script)
        // shares the same trust boundary.
        this.symbols = new SymbolIndex({ ...res, regions });
        // 前回このファイルに付けた名前を戻す（元の名前より優先される）
        for (const e of this.notes.nameEntries()) this.symbols.rename(e.addr, e.name);
        this.viewer.setSymbols(this.symbols);
        this.syncSymbolsStore(true);
        this.updateChrome();
        return true;
      });
      this.analysisBaseSymbolsReady = baseSymbolsReady.catch(() => {
        if (epoch === this.backend.gen && this.store.get('sliceIndex') === sliceIndex) {
          this.syncSymbolsStore(true);
        }
        return false;
      });
      this.symbolsReady = this.analysisBaseSymbolsReady.then((ready) => {
        if (!ready || epoch !== this.backend.gen || this.store.get('sliceIndex') !== sliceIndex) return null;
        // ObjC and whole-binary recognition are intentionally demand-driven.
        // Swift metadata may warm in the background, but recognition only starts
        // from an explicit consumer (Overview/Explorer/etc.).
        return Promise.allSettled([
          this.ensureSwift({ priority: 'background' }),
        ]);
      }).catch(() => { /* シンボルがなくても読める */ });
    } else {
      this.syncSymbolsStore(true);
    }
  }

  /**
   * Objective-C のクラス表を読む。このツールでいちばん効く一手。
   *
   * 配布用のアプリは自作の関数名が削ってあるが、Objective-C のクラスだけは
   *
   *   - クラス名とメソッド名（実装アドレスつき）
   *   - **メンバ変数の名前・型・位置**
   *
   * がバイナリに必ず残っている。前者で sub_100123456 が
   * -[LoginViewController loginButtonTapped:] に戻り、後者で
   * [x0, #0x20] が self.hp に戻る。「どれがどの処理か」に答えられるのはここ。
   *
   * 裏で走らせて、できたところで画面を差し替える。失敗しても表示は続く。
   */
  async ensureObjcIndex(options = {}) {
    return this.ensureObjc(this.store?.get?.('sliceIndex'), options);
  }

  async ensureObjc(sliceIndex, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const epoch = this.backend.gen;
    if (this.objcModel && this.objcRuntime) return this.fields;
    if (this.objcBusy && this.objcBusyEpoch === epoch && this.objcBusyState) return waitForAppProducer(this.objcBusyState, opts.signal ?? null);
    const regions = this.store.get('regions') || [];
    const list = regions.find((r) => r.section === '__objc_classlist' && r.size > 0n) || null;
    const protocolList = regions.find((r) => r.section === '__objc_protolist' && r.size > 0n) || null;
    const categoryList = regions.find((r) => r.section === '__objc_catlist' && r.size > 0n) || null;
    if (!list && !protocolList && !categoryList) {
      this.fields = EMPTY_FIELDS;
      this.objcModel = null;
      this.objcRuntime = null;
      return this.fields;
    }
    const slice = sliceIndex != null ? sliceIndex : this.store.get('sliceIndex');
    this.objcBusyEpoch = epoch;
    const producerController = new AbortController();
    const producerState = { controller:producerController, waiters:0, settled:false, promise:null };
    const producerOptions = { ...opts, signal:producerController.signal };
    producerState.promise = (async () => {
      const read = async (addr, len) => {
        if (producerController.signal.aborted) throw appProducerAbortError(producerController.signal, 'Objective-C metadata read aborted');
        const request = this.backend.readAt(addr, len, false, { priority:producerOptions.priority === 'background' ? 'background' : 'current' });
        const onAbort = () => request.cancel?.();
        producerController.signal.addEventListener('abort', onAbort, { once:true });
        try {
          const r = await request;
          if (producerController.signal.aborted) throw appProducerAbortError(producerController.signal, 'Objective-C metadata read aborted');
          return r && r.found ? r.bytes : null;
        } catch (error) {
          if (producerController.signal.aborted || error?.name === 'AbortError') throw error;
          return null;
        } finally {
          producerController.signal.removeEventListener('abort', onAbort);
        }
      };
      try {
        const info = this.store.get('fileInfo');
        const sl = info && info.slices ? info.slices[slice] : null;
        const imageBase = sl && sl.info ? sl.info.textVM : null;
        const executableRanges=regions.filter((r)=>r?.exec===true&&r.size>0n).map((r)=>({vmAddr:r.vmAddr,size:r.size}));
        const architecture=sl?.name||sl?.info?.arch||sl?.info?.architecture||null;
        const model = await buildObjcRuntimeModel(read, list, { protocolList, categoryList, executableRanges, architecture }, null, imageBase, null, producerOptions);
        if (this.analysisBaseSymbolsReady) { try { await this.analysisBaseSymbolsReady; } catch { /* best effort */ } }
        if (producerController.signal.aborted || epoch !== this.backend.gen || this.store.get('sliceIndex') !== slice) return this.fields;
        model.runtimeIndex = model.runtimeIndex || buildObjcRuntimeIndex(model);
        this.objcModel = model;
        this.objcRuntime = model.runtimeIndex || null;
        this.fields = new FieldIndex(model);
        if (model.names.length) {
          if (!this.symbols || this.symbols === EMPTY_INDEX) {
            this.symbols = new SymbolIndex({ regions: this.store.get('regions') || [] });
          }
          const added = this.symbols.addNames(model.names, { source: 'objc-runtime', confidence: 1, confirmed: true });
          this.symbols.addFunctions(model.names.map((n) => n.addr), { source: 'objc-runtime', confidence: 1, confirmed: true });
          this.viewer.setSymbols(this.symbols);
          this.syncSymbolsStore();
          this.updateChrome();
          void this.persistAnalysisSession(['symbols']);
          if (added) {
            toast(pick(
              model.count + ' 個のクラスから、' + added + ' 個の関数の名前と ' +
                this.fields.fieldCount + ' 個の値の名前を復元しました',
              'Recovered ' + added + ' function names and ' + this.fields.fieldCount +
                ' field names from ' + model.count + ' classes'));
          }
        }
      } catch (error) {
        if (producerController.signal.aborted || error?.name === 'AbortError') throw error;
        /* fail-soft on partial Apple metadata */
      }
      finally { if (this.objcBusyEpoch === epoch) { this.objcBusy=null; this.objcBusyEpoch=-1; this.objcBusyState=null; } }
      return epoch === this.backend.gen ? this.fields : EMPTY_FIELDS;
    })();
    producerState.promise = producerState.promise.finally(() => { producerState.settled = true; });
    this.objcBusyState = producerState;
    this.objcBusy = producerState.promise;
    return waitForAppProducer(producerState, opts.signal ?? null);
  }

  async ensureSwift(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    if (this.analysisResumeReady) { try { await this.analysisResumeReady; } catch { /* best effort */ } }
    const epoch = this.backend.gen;
    if (this.swiftModel && this.swiftRuntime) return this.swiftModel;
    if (this.swiftBusy && this.swiftBusyEpoch === epoch && this.swiftBusyState) return waitForAppProducer(this.swiftBusyState, opts.signal ?? null);
    const regions = this.store.get('regions') || [];
    if (!regions.some((r) => /^__swift5_/.test(r.section || ''))) return null;
    const slice = this.store.get('sliceIndex');
    this.swiftBusyAbort?.abort('swift-slice-superseded');
    const controller = new AbortController();
    const producerState = { controller, waiters:0, settled:false, promise:null };
    this.swiftBusyAbort = controller;
    this.swiftBusyEpoch = epoch;
    producerState.promise = (async () => {
      const read = async (addr, len) => {
        if (controller.signal.aborted) throw appProducerAbortError(controller.signal, 'Swift metadata read aborted');
        const request = this.backend.readAt(addr, len, false, { priority:opts.priority === 'background' ? 'background' : 'current' });
        const onAbort = () => request.cancel?.();
        controller.signal.addEventListener('abort', onAbort, { once:true });
        try {
          const r = await request;
          if (controller.signal.aborted) throw appProducerAbortError(controller.signal, 'Swift metadata read aborted');
          return r && r.found ? r.bytes : null;
        } catch (error) {
          if (controller.signal.aborted || error?.name === 'AbortError') throw error;
          return null;
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
        }
      };
      try {
        const model=await buildSwiftMetadataModel(read,regions,{
          budget:20000,
          signal:controller.signal,
          resolvePointer:(raw,context)=>this.backend.resolvePointer(raw,{...context,sliceIndex:slice}),
          // ARM64_32 is a 64-bit Mach-O class with 4-byte native pointers: the
          // architecture is the canonical ABI authority for Swift pointer reads (#8309).
          architecture:this.store.get('architecture'),
        });
        if (this.analysisBaseSymbolsReady) { try { await this.analysisBaseSymbolsReady; } catch { /* best effort */ } }
        if (controller.signal.aborted || epoch !== this.backend.gen || this.store.get('sliceIndex') !== slice) return null;
        this.swiftModel = model; this.swiftRuntime = buildSwiftRuntimeIndex(model);
        const exec = this.executableRegions(); const names = [];
        for (const type of model?.types || []) for (const method of type.methods || type.vtable || []) {
          if (method?.impl != null && exec.some((r) => method.impl >= r.vmAddr && method.impl < r.vmAddr + r.size)) names.push({ addr: method.impl, name: `${type.name || 'SwiftType'}::method_${method.index}`, source: 'swift-metadata' });
        }
        if (names.length) {
          if (!this.symbols || this.symbols === EMPTY_INDEX) {
            this.symbols = new SymbolIndex({ regions: this.store.get('regions') || [] });
          }
          this.symbols.addNames(names);
          this.symbols.addFunctions(names.map((x) => x.addr));
          this.viewer.setSymbols(this.symbols);
          this.syncSymbolsStore();
          void this.persistAnalysisSession(['symbols']);
        }
        return model;
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') throw error;
        return null;
      }
      finally {
        if (this.swiftBusyEpoch === epoch) { this.swiftBusy = null; this.swiftBusyEpoch = -1; this.swiftBusyState = null; }
        if (this.swiftBusyAbort === controller) { this.swiftBusyAbort = null; }
      }
    })();
    producerState.promise = producerState.promise.finally(() => { producerState.settled = true; });
    this.swiftBusyState = producerState;
    this.swiftBusy = producerState.promise;
    return waitForAppProducer(producerState, opts.signal ?? null);
  }

  resolveSwiftCall(call) { return this.swiftRuntime ? resolveSwiftDispatch(this.swiftRuntime, call || {}) : {resolved:null,candidates:[],confidence:0,reason:'swift-runtime-unavailable'}; }

  executableRegions() { return (this.store.get('regions') || []).filter((r)=>r?.exec===true && r.size>0n); }
  executableRegionFor(addr) { const a=BigInt(addr); return this.executableRegions().find((r)=>a>=r.vmAddr && a<r.vmAddr+r.size) || null; }
  validatedFunctionRange(addr) {
    const fn=this.symbols?.functionAt?.(BigInt(addr)); if(!fn) return {ok:false,reason:'function-symbol-missing'};
    const region=this.executableRegionFor(fn.start); if(!region) return {ok:false,reason:'function-start-not-executable',function:fn};
    if(fn.end==null){
      /* end の証明はしない。局所的な境界（証明済み end か同一領域内の次開始）
         で締めた解析窓として返し、complete:false で未証明を正直に伝える。 */
      const loaderWindow=this.symbols?.functionAnalysisWindow?.(fn.start)??null;
      const windowEnd=loaderWindow?.end??this.symbols?.functionWindowBound?.(fn.start)??null;
      const regionEnd=region.vmAddr+region.size;
      if(windowEnd==null||windowEnd<=fn.start||windowEnd>regionEnd)return {ok:false,reason:'function-end-unproven',function:fn,region};
      if(loaderWindow){
        return {ok:true,start:fn.start,end:windowEnd,region,function:fn,complete:false,reason:'function-end-unproven',provenance:'elf-loader-contract+section-analysis-window',analysisWindow:loaderWindow};
      }
      return {ok:true,start:fn.start,end:windowEnd,region,function:fn,complete:false,reason:'function-end-unproven',provenance:'executable-region+analysis-window'};
    }
    const regionEnd=region.vmAddr+region.size;
    let end=BigInt(fn.end);
    let complete=true,reason=null;
    if(end<=fn.start){return {ok:false,reason:'invalid-function-range',function:fn,region};}
    if(end>regionEnd){end=regionEnd;complete=false;reason='symbol-range-crosses-executable-region';}
    return {ok:true,start:fn.start,end,region,function:fn,complete,reason,provenance:'executable-region+proven-function-extent'};
  }

  async ensureRecognition(options={}) {
    return ensureRecognitionState(this, options);
  }

  /** その関数がどのクラスのメソッドか。分からなければ null。 */
  ownerOf(addr) {
    return this.fields ? this.fields.ownerOf(addr) : null;
  }

  pickDefaultRegion(regions, info) {
    const text = regions.find((r) => r.section === '__text' && r.size > 0n);
    if (text) return text;
    const exec = regions.find((r) => r.exec && r.size > 0n);
    if (exec) return exec;
    const any = regions.find((r) => r.size > 0n);
    return any || info.raw;
  }

  currentSlice() {
    const info = this.store.get('fileInfo');
    const i = this.store.get('sliceIndex');
    if (!info || i < 0 || !info.slices[i]) return null;
    return info.slices[i];
  }

  async selectSlice(index) {
    const info=this.store.get('fileInfo');
    if (!info || !info.slices[index] || info.slices[index].error) return;
    void this.flushDeltaSave();
    void this.persistAnalysisSession();
    this.workspace?.autosave();
    this.workspace?.invalidate();
    this.activeProject=null;
    this.noteAttachController?.abort();
    this.backend.advanceEpoch();
    this.analysisResumeReady = Promise.resolve(false);
    this.forgetSemantics(true);
    this._resetDeltaReadiness();
    this.symbols=EMPTY_INDEX;
    this.viewer.setSymbols(EMPTY_INDEX);
    this.store.set({ symbolsGen: 0, symbolsReady: false });
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this.notes=EMPTY_NOTES;
    this.projectAnnotations = [];
    this.bookmarks?.clear?.({ silent: true });
    this.lastDeltaRestore=null;
    this.restoredRoutePath=null;
    this.uiResume = { explorerFilter: 'all', explorerSort: 'address', lastFunctionTab: null };
    this.store.set({ deltaRestored: null });
    this.patches = new PatchSet();
    this._createPatchSet(this.patches);
    this.store.set({patches:0});
    const file=this.store.get('file');
    const epoch=this.backend.gen;
    this.applySlice(index,info);
    const projectReady = this.attachNotes(file,info,index,epoch)
      .then(()=>this.workspace?.bind())
      .then((project)=>{if(project)this.activeProject=project; return project;})
      .catch(()=>null);
    const baseSymbolsReady = this.analysisBaseSymbolsReady || this.symbolsReady || Promise.resolve();
    this.analysisResumeReady = Promise.allSettled([projectReady, baseSymbolsReady]).then(async () => {
      if (epoch !== this.backend.gen || this.store.get('sliceIndex') !== index) return false;
      let binaryId = this.backend.binaryId;
      if (!binaryId) {
        try {
          binaryId = await this.backend.ensureBinaryId();
        } catch {
          if (epoch === this.backend.gen && this.store.get('sliceIndex') === index) {
            this._startV6AutoAnalysis(epoch, index);
          }
          return false;
        }
      }
      if (epoch !== this.backend.gen || this.store.get('sliceIndex') !== index) return false;
      let restored = false;
      try { restored = await this.restoreAnalysisSession(binaryId, index, epoch); } catch { /* non-fatal */ }
      if (!this.sampleOpen) {
        try { await this.restoreDeltaSession(epoch, index); } catch { /* non-fatal */ }
      }
      this._startV6AutoAnalysis(epoch, index);
      if (!restored) void this.persistAnalysisSession(['symbols']);
      return restored;
    }).catch(() => false);
  }

  async exportProjectFile(){
    if(!this.store.get('fileInfo'))throw new Error('open-file-first');
    if(!this.workspace.identity)this.activeProject=await this.workspace.bind();
    return this.workspace.exportProject();
  }

  async importProjectFile(file){
    if(!this.store.get('fileInfo'))throw new Error('open-file-first');
    if(!this.workspace.identity)await this.workspace.bind();
    const project=await this.workspace.importProject(file);this.activeProject=project;this.updateChrome();
    if (!this._applyingDelta) this.scheduleDeltaSave();
    return project;
  }

  async loadDiffBaseline(file, options={}){return this.workspace.loadBaseline(file, options);}
  async runBinaryDiff(options){return this.workspace.diff(options);}
  getBinaryDiff(){return this.workspace.getBinaryDiff();}
  saveWorkspace(){return this.workspace.autosave();}


  selectRegion(region, { silent } = {}) {
    if (!region) return;
    if (region.zerofill || region.size === 0n) {
      alertDialog(t('err.nothingTitle'), t('err.nothingText', {
        name: region.name,
        zero: region.zerofill ? t('err.zerofill') : '',
      }));
      return;
    }
    this.backend.dropQueued();
    if (this.semantic && this.semantic.regionId !== region.id) this.forgetSemantics();
    region.disasm = this.store.get('canDisassemble');
    this.store.set({ currentRegion: region, selectedRow: -1 });
    this.viewer.setRegion(region);
    this.updateChrome();
    if (!silent) toast(region.name);
  }

  setMode(mode) {
    if (mode !== 'asm' && mode !== 'hex') return;
    if (mode === 'asm' && !this.store.get('canDisassemble')) {
      const arch = this.store.get('architecture') || pick('このファイル', 'This binary');
      alertDialog(t('err.disasmTitle'), t('err.arm64Only', { arch }));
      return;
    }
    this.preferredMode = mode;
    this.store.set({ displayMode: mode });
    this.viewer.setMode(mode);
    this.updateModeUI();
    if (!this._applyingDelta) this.scheduleDeltaSave();
  }

  /* ── 移動 ─────────────────────────────────────────────────── */

  navigationEntry(addr, label) {
    const region = this.store.get('currentRegion');
    if (!region || addr == null) return null;
    return {
      key: region.id + ':' + addr.toString() + ':' + this.store.get('displayMode'),
      regionId: region.id,
      addr,
      mode: this.store.get('displayMode'),
      label: label || null,
    };
  }

  restoreNavigation(entry) {
    if (!entry) return;
    const regions = this.store.get('regions') || [];
    const region = regions.find((r) => r.id === entry.regionId);
    if (!region) return;
    if (this.store.get('currentRegion') !== region) this.selectRegion(region, { silent: true });
    if (entry.mode) this.setMode(entry.mode);
    this.viewer.goToAddress(entry.addr);
    this.flash(entry.addr);
  }

  renderNavigation(state = this.navigation.snapshot()) {
    if (!this.dom.navBack) return;
    this.dom.navBack.disabled = !state.canBack;
    this.dom.navForward.disabled = !state.canForward;
    const entry = state.current;
    this.dom.navCrumbs.replaceChildren();
    if (!entry) return;
    const parts = [];
    if (this.lastGoal && this.lastGoal.text) parts.push(this.lastGoal.text);
    const owner = this.ownerOf(entry.addr);
    if (owner && owner.className) parts.push(owner.className);
    if (owner && owner.sel) parts.push(owner.sel);
    if (entry.label) parts.push(entry.label);
    parts.push(addrHex(entry.addr));
    const seen = new Set();
    for (const part of parts.filter(Boolean)) {
      if (seen.has(part)) continue;
      seen.add(part);
      if (this.dom.navCrumbs.childNodes.length) {
        const sep = document.createElement('span');
        sep.className = 'nav-sep';
        sep.textContent = '›';
        sep.setAttribute('aria-hidden', 'true');
        this.dom.navCrumbs.append(sep);
      }
      const node = document.createElement('span');
      node.textContent = part;
      this.dom.navCrumbs.append(node);
    }
  }

  goToAddress(addr, { announce, history = true, label } = {}) {
    const region = this.store.get('currentRegion');
    if (region && addr >= region.vmAddr && addr < region.vmAddr + region.size) {
      if (!this.viewer.goToAddress(addr)) return false;
      if (announce) this.flash(addr);
      if (history) this.navigation.visit(this.navigationEntry(addr, label));
      return true;
    }
    const regions = this.store.get('regions') || [];
    const target = regions.find((r) => !r.zerofill && r.size > 0n && addr >= r.vmAddr && addr < r.vmAddr + r.size);
    if (target) {
      this.selectRegion(target, { silent: true });
      if (!this.viewer.goToAddress(addr)) return false;
      toast(t('toast.jumped', { name: target.name }));
      if (announce) this.flash(addr);
      if (history) this.navigation.visit(this.navigationEntry(addr, label));
      return true;
    }
    const info = this.store.get('fileInfo');
    if (info && region && region.id === 'raw') {
      alertDialog(t('err.outsideTitle'), t('err.outsideText', {
        addr: addrHex(addr), size: addrHex(info.size),
      }));
      return false;
    }
    alertDialog(t('err.unmappedTitle'), t('err.unmappedText', {
      addr: addrHex(addr), range: describeRange(regions),
    }));
    return false;
  }

  /** 関数の先頭へ移動して、そこを選んだ状態にする。 */
  goToFunction(addr) {
    const name = this.symbols && this.symbols.nameAt(addr);
    if (!this.goToAddress(addr, {
      announce: true,
      label: name ? prettyName(name) : pick('関数', 'Function'),
    })) return;
    const region = this.store.get('currentRegion');
    if (!region) return;
    const row = this.viewer.rowOfAddress(addr);
    if (row == null) return;
    this.viewer.select(row, false);
    this.store.set({ selectedRow: row });
    // 関数を開いた「そのとき」だけ意味解析を走らせる（描画とは別の流れ）
    this.analyzeFunctionAt(addr);
  }

  /** 名前から探して移動する（サンプルの案内などで使う）。 */
  goToSymbol(name) {
    const idx = this.symbols;
    for (let i = 0; i < idx.names.length; i++) {
      if (idx.names[i] === name) { this.goToFunction(idx.addrs[i]); return true; }
    }
    toast(pick('見つかりませんでした。', 'Not found.'));
    return false;
  }

  /** ファイル内の位置で移動する（構造ビューから）。 */
  goToFileOffset(offset) {
    const info = this.store.get('fileInfo');
    if (!info) return;
    this.selectRegion(info.raw, { silent: true });
    this.setMode('hex');
    this.goToAddress(offset, { announce: true, label: pick('ファイル内の位置', 'File offset') });
  }

  /** 文字列の場所へ移動する。文字列はコードではないので 16 進で見せる。 */
  goToStringAddress(region, addr) {
    if (region && (!this.store.get('currentRegion') || this.store.get('currentRegion').id !== region.id)) {
      this.selectRegion(region, { silent: true });
    }
    if (!region || !region.exec) this.setMode('hex');
    this.goToAddress(addr, { announce: true, label: pick('文字列', 'String') });
  }

  flash(addr) {
    const region = this.store.get('currentRegion');
    if (!region) return;
    const row = this.viewer.rowOfAddress(addr);
    if (row != null) this.viewer.mark(row);
  }
}

function describeRange(regions) {
  const live = regions.filter((r) => r.size > 0n);
  if (!live.length) return pick('なし', 'nothing');
  let lo = live[0].vmAddr, hi = live[0].vmAddr + live[0].size;
  for (const r of live) {
    if (r.vmAddr < lo) lo = r.vmAddr;
    if (r.vmAddr + r.size > hi) hi = r.vmAddr + r.size;
  }
  return addrHex(lo) + ' – ' + addrHex(hi);
}

/** エンジンやブラウザのエラーを、人が次にどうすればいいか分かる文にする。 */
function friendly(message) {
  const m = String(message || '');
  if (/capstone\.wasm|WebAssembly|wasm/i.test(m)) return t('err.engineWasm');
  if (/NotReadableError|permission/i.test(m)) return t('err.notReadable');
  if (/out of memory|allocation/i.test(m)) return t('err.memory');
  if (/TypeError|ReferenceError|SyntaxError|Cannot read|\bundefined\b|\bnull\b/i.test(m)) {
    console.error('[hex] internal error', m);
    return t('err.unknown');
  }
  return m || t('err.unknown');
}

/* ── 起動 ───────────────────────────────────────────────────── */

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('error', (e) => {
    if (e && e.message && /ResizeObserver/.test(e.message)) return;
  });

  const app = new App();
  window.__app = app;   // Safari の Web インスペクタ用。UI からは使っていない。
}

import { installFunctionAnalysisPresentation } from './ui/function-analysis-presentation.js';
import { Sheet, el, button, list, groupRow, tapRow, toast, noteBox } from './ui.js';
import { addrHex } from './format.js';
import { isMangled, shortName, readableName } from './rtti.js';

let _toolsBasePromise = null;
function loadToolsBase() {
  if (!_toolsBasePromise) {
    _toolsBasePromise = import('./tools-base.js');
  }
  return _toolsBasePromise;
}

const FACT = 'fact';
const INFER = 'infer';
const HINT = 'hint';
const LEVEL_WORD = Object.freeze({ fact:'事実', infer:'推定', hint:'参考' });
const LEVEL_CLASS = Object.freeze({ fact:'tag-fact', infer:'tag-infer', hint:'tag-hint' });

function install(app) {
  installFunctionAnalysisPresentation(app);
}

function isCanonicalPresentation(result) {
  return result?.presentationProjection?.canonical === true
    && result?.presentationProjection?.analysisAuthority === 'AnalysisQueryAPI';
}


function relationAddress(value) {
  const candidate = value?.addr ?? value?.address ?? value?.functionAddress
    ?? value?.caller ?? value?.callee ?? value?.target ?? value;
  try { return candidate == null ? null : BigInt(candidate); } catch { return null; }
}

function labelFor(app, address) {
  return app?.symbols?.nameAt?.(address)
    ?? app?.symbols?.label?.(address)
    ?? `sub_${address.toString(16).toUpperCase()}`;
}

function stale(error) {
  return error?.name === 'AnalysisSnapshotStaleError'
    || error?.code === 'ANALYSIS_SNAPSHOT_STALE';
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(signal.reason == null ? 'Operation aborted' : String(signal.reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

async function freshSnapshotOperation(app, operation, options = {}) {
  const api = app?.analysisQueries;
  if (!api) throw new Error('AnalysisQueryAPI is unavailable');
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfAborted(options.signal);
    const snapshot = await api.snapshot(options);
    try {
      const value = await operation(api, snapshot);
      throwIfAborted(options.signal);
      return value;
    }
    catch (error) {
      last = error;
      if (!stale(error) || attempt > 0) throw error;
    }
  }
  throw last ?? new Error('analysis-query-retry-exhausted');
}

function reasonText(result) {
  return result?.status?.reason ? `（${result.status.reason}）` : '';
}

function confidenceMark(confidence) {
  const value = Number(confidence ?? 0);
  const count = value >= 0.85 ? 3 : value >= 0.6 ? 2 : value > 0 ? 1 : 0;
  return count ? `${'★'.repeat(count)}${'☆'.repeat(3 - count)}` : '';
}

export function currentFunctionAddr(app) {
  const sym = app.symbols;
  const row = app.viewer ? app.viewer.selectedRow : -1;
  const region = app.store.get('currentRegion');
  if (region && row >= 0) {
    const addr = app.viewer?.rowAddress ? app.viewer.rowAddress(row) : null;
    if (addr == null) return null;
    const fn = sym && sym.functionCount ? sym.functionAt(addr) : null;
    if (fn) return fn.start;
    return addr;
  }
  if (app.semantic && app.semantic.result) return app.semantic.result.startAddr;
  const list2 = sym && sym.functionCount ? sym.functionList(app.codeRegion(), 1) : [];
  return list2.length ? list2[0].addr : null;
}

export async function modelOf(app, addr) {
  const base = await loadToolsBase();
  return base.modelOf(app, addr);
}

export function parseDebuggerArgument(value) {
  const raw = String(value ?? '');
  if (!raw || raw !== raw.trim() || !/^-?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(raw)) {
    return { ok: false, value: null, error: '10進整数か0x付き16進整数を入力してください。' };
  }
  try { return { ok: true, value: BigInt(raw), error: null }; }
  catch { return { ok: false, value: null, error: '整数として読み取れません。' }; }
}

export function prettyName(name) {
  if (!name) return name;
  return isMangled(name) ? shortName(name) : name;
}

export function fullName(name) {
  if (!name) return name;
  return isMangled(name) ? readableName(name) : name;
}

function needFunction(app) {
  const address = currentFunctionAddr(app);
  if (address == null) {
    toast('先に関数を選んでください（「関数」から選ぶか、命令をタップします）。');
    return null;
  }
  return address;
}

const base = {
  get showTypes() { return (async (...args) => (await loadToolsBase()).showTypes(...args)); },
  get showStructRecover() { return (async (...args) => (await loadToolsBase()).showStructRecover(...args)); },
  get showDecompiler() { return (async (...args) => (await loadToolsBase()).showDecompiler(...args)); },
  get showCfg() { return (async (...args) => (await loadToolsBase()).showCfg(...args)); },
  get showDebugger() { return (async (...args) => (await loadToolsBase()).showDebugger(...args)); },
  get showRename() { return (async (...args) => (await loadToolsBase()).showRename(...args)); },
  get showLinkage() { return (async (...args) => (await loadToolsBase()).showLinkage(...args)); },
  get showGlobals() { return (async (...args) => (await loadToolsBase()).showGlobals(...args)); },
  get showCxxClasses() { return (async (...args) => (await loadToolsBase()).showCxxClasses(...args)); },
  get showIl2cpp() { return (async (...args) => (await loadToolsBase()).showIl2cpp(...args)); },
  get showPatches() { return (async (...args) => (await loadToolsBase()).showPatches(...args)); },
  get showNotes() { return (async (...args) => (await loadToolsBase()).showNotes(...args)); },
  get showStructs() { return (async (...args) => (await loadToolsBase()).showStructs(...args)); },
  get showScript() { return (async (...args) => (await loadToolsBase()).showScript(...args)); },
  get showPlugins() { return (async (...args) => (await loadToolsBase()).showPlugins(...args)); },
  currentFunctionAddr,
};

export function showTools(app) {
  install(app);
  const sheet = new Sheet('解析');
  const address = currentFunctionAddr(app);
  if (address != null) {
    const head = el('div', 'block');
    head.append(el('div', 'bigval mono', labelFor(app, BigInt(address))));
    head.append(el('div', 'hint', addrHex(address)));
    sheet.body.append(head);
  }

  const rowIn = (container) => (level, label, sub, action) => container.append(tapRow(label, {
    sub, tag:LEVEL_WORD[level], tagClass:LEVEL_CLASS[level], right:'›',
    onTap:() => { sheet.close(); action(); },
  }));
  const withFn = (action) => () => {
    const target = needFunction(app);
    if (target != null) action(target);
  };

  const first = list();
  first.append(groupRow('まず、ここから'));
  const firstRow = rowIn(first);
  firstRow(INFER, '自動解析（ぜんぶ自動で調べる）', '分かったことと未確定なことをまとめます。', () => app.openOverview());
  firstRow(INFER, '目的から探す（HP・所持金・攻撃力…）', '名前・参照・命令の複数方向から絞ります。', () => app.openInvestigate());
  firstRow(HINT, '使っている言葉から見る（機能一覧）', '文字列を機能ごとに整理した手がかりです。', () => app.openFeatures());
  sheet.body.append(first);

  const perFunction = list();
  perFunction.append(groupRow('いま見ている関数を調べる'));
  const functionRow = rowIn(perFunction);
  functionRow(INFER, '逆コンパイル（C 風に読む）', 'canonical解析結果を読みやすい形で表示します。', withFn((a) => showDecompiler(app, a)));
  functionRow(FACT, '制御フロー図（分かれ道を絵にする）', 'CFGの確定したedgeをそのまま図にします。', withFn((a) => showCfg(app, a)));
  functionRow(FACT, '呼び出し図（誰が誰を呼ぶか）', 'callers/calleesを同じQuery層から辿ります。', withFn((a) => showCallGraphPanel(app, a)));
  functionRow(INFER, '引数・戻り値・変数の型', '型projectionがある場合だけ表示します。', withFn((a) => showTypes(app, a)));
  functionRow(INFER, '構造体を組み立てる', '対応する解析projectionがある場合だけ復元します。', withFn((a) => showStructRecover(app, a)));
  functionRow(FACT, '実行してみる（1 命令ずつ・デバッガ）', 'ブラウザ内のエミュレータで確認します。', withFn((a) => base.showDebugger(app, a)));
  functionRow(FACT, '名前を付ける / メモを書く', '分かったことを保存します。', withFn((a) => base.showRename(app, a)));
  sheet.body.append(perFunction);

  const whole = list();
  whole.append(groupRow('ファイル全体を調べる'));
  const wholeRow = rowIn(whole);
  wholeRow(FACT, '外とのつながり（インポート / ライブラリ）', 'リンカ情報を確認します。', () => base.showLinkage(app));
  wholeRow(FACT, 'グローバル変数', '参照の多い共有データを確認します。', () => base.showGlobals(app));
  wholeRow(FACT, 'C++ のクラス（RTTI / vtable）', '残っている型情報を確認します。', () => base.showCxxClasses(app));
  wholeRow(FACT, 'Unity（IL2CPP）の名前を戻す', 'global-metadata.datから名前を復元します。', () => base.showIl2cpp(app));
  sheet.body.append(whole);

  const work = list();
  work.append(groupRow('書き換える・自動化する'));
  const workRow = rowIn(work);
  workRow(FACT, 'パッチ（命令の書き換え）', '結果は新しいファイルとして保存します。', () => base.showPatches(app));
  workRow(FACT, '自分で付けた名前とメモ', '保存した解析メモを確認します。', () => base.showNotes(app));
  workRow(FACT, '構造体（自分で作ったもの）', '保存済みの型を確認します。', () => base.showStructs(app));
  workRow(FACT, 'スクリプト（自動化）', '同じ作業を繰り返すときに使います。', () => base.showScript(app));
  workRow(FACT, 'プラグイン', '追加機能を管理します。', () => base.showPlugins(app));
  sheet.body.append(work);
}

export async function showDecompiler(app, ...args) {
  install(app);
  return base.showDecompiler(app, ...args);
}

export async function showCfg(app, ...args) {
  install(app);
  return base.showCfg(app, ...args);
}

export function functionAnalysisUiRoute(app) {
  const arch = app?.store?.get?.('architecture') || 'unknown';
  if (arch === 'arm64' || arch === 'aarch64') {
    return { route: 'legacy' };
  }
  if (arch === 'x86_64' || arch === 'riscv64') {
    if (typeof app?.backend?.analyzeSemanticFunction === 'function') {
      return { route: 'canonical' };
    }
    return { route: 'unsupported' };
  }
  return { route: 'unsupported' };
}

export async function showTypes(app, addr, ...args) {
  install(app);
  const route = functionAnalysisUiRoute(app);
  const result = route.route === 'canonical' ? { presentationProjection: { canonical: true, analysisAuthority: 'AnalysisQueryAPI' } } : null;
  if (!isCanonicalPresentation(result)) return base.showTypes(app, addr, ...args);

  const sheet = new Sheet('引数・戻り値・変数');
  const status = el('div', 'hint', '型情報を同じ解析スナップショットから確認しています…');
  sheet.body.append(status);
  try {
    const queried = await freshSnapshotOperation(app, (api, snapshot) =>
      api.types(snapshot, { functionId:addr }, { offset:0, limit:600 }));
    status.remove();
    if (queried?.completeness === 'unsupported' || queried?.value == null) {
      sheet.body.append(noteBox(
        `このアーキテクチャでは、検証できる型projectionがまだありません${reasonText(queried)}。` +
        ' ARM64向けの旧推論を流用して型を作ることはしません。'));
      return;
    }
    const value = queried.value;
    const argsList = list();
    const functionArgs = Array.isArray(value.args) ? value.args : [];
    if (!functionArgs.length) argsList.append(tapRow('検証できる引数型はありません', { disabled:true }));
    for (const arg of functionArgs) {
      const type = String(arg.type ?? arg.name ?? 'unknown');
      const index = Number.isSafeInteger(arg.index) ? arg.index + 1 : '?';
      const why = Array.isArray(arg.why) ? arg.why.map((x) => x?.why ?? x).filter(Boolean).join(' / ') : '';
      argsList.append(tapRow(`${type}  a${index}`, {
        sub:[arg.reg ? `レジスタ ${arg.reg}` : '', why].filter(Boolean).join(' · '),
        right:confidenceMark(arg.conf ?? arg.confidence), disabled:true,
      }));
    }
    sheet.body.append(el('div', 'sec-title', '受け取っているもの（引数）'), argsList);

    if (value.ret) {
      const ret = list();
      ret.append(tapRow(String(value.ret.type ?? 'unknown'), {
        sub:Array.isArray(value.ret.why) ? value.ret.why.map((x) => x?.why ?? x).filter(Boolean).join(' / ') : '',
        right:confidenceMark(value.ret.conf ?? value.ret.confidence), disabled:true,
      }));
      sheet.body.append(el('div', 'sec-title', '戻り値'), ret);
    }
    const locals = Array.isArray(value.locals) ? value.locals : [];
    if (locals.length) {
      const localList = list();
      for (const local of locals.slice(0, 60)) {
        localList.append(tapRow(String(local.type ?? 'unknown'), {
          sub:String(local.slot ?? local.name ?? ''),
          right:confidenceMark(local.conf ?? local.confidence), disabled:true,
        }));
      }
      sheet.body.append(el('div', 'sec-title', 'ローカル変数'), localList);
    }
    sheet.body.append(noteBox('ここに出すのはAnalysisQueryAPIが根拠付きで返した型だけです。'));
  } catch (error) {
    status.textContent = `型情報を取得できませんでした: ${error?.message || error}`;
  }
}

export async function showStructRecover(app, addr, ...args) {
  install(app);
  const route = functionAnalysisUiRoute(app);
  const result = route.route === 'canonical' ? { presentationProjection: { canonical: true, analysisAuthority: 'AnalysisQueryAPI' } } : null;
  if (!isCanonicalPresentation(result)) return base.showStructRecover(app, addr, ...args);
  const sheet = new Sheet('構造体を組み立てる');
  sheet.body.append(noteBox(
    'この関数はcanonical Semantic-v2経路で解析されていますが、構造体復元のtyped query projectionはまだ提供されていません。' +
    ' ARM64向けの旧モデルへ変換して構造体を推測することはしません。'));
}

export async function buildQueryCallGraph(app, center, depth, options = {}) {
  const signal = options.signal ?? null;
  return freshSnapshotOperation(app, async (api, snapshot) => {
    const limit = depth >= 3 ? 4 : 8;
    const nodes = new Map();
    const edges = new Map();
    const addNode = (address, kind) => {
      const id = address.toString();
      if (!nodes.has(id)) nodes.set(id, {
        id, title:null, lines:[labelFor(app, address)], kind, addr:address,
      });
      return id;
    };
    const addEdge = (from, to) => edges.set(`${from}>${to}`, { from, to, kind:'call' });
    addNode(center, 'entry');

    const walk = async (direction) => {
      let frontier = new Map([[center.toString(), center]]);
      const visited = new Set();
      for (let level = 0; level < depth && frontier.size; level++) {
        throwIfAborted(signal);
        const next = new Map();
        for (const current of frontier.values()) {
          throwIfAborted(signal);
          const key = current.toString();
          if (visited.has(key)) continue;
          visited.add(key);
          const result = direction === 'caller'
            ? await api.callers(snapshot, current, { offset:0, limit }, { signal })
            : await api.callees(snapshot, current, { offset:0, limit }, { signal });
          if (result?.completeness === 'unsupported') continue;
          for (const item of result?.value || []) {
            const address = relationAddress(item);
            if (address == null) continue;
            const addressKey = address.toString();
            addNode(address, direction);
            if (direction === 'caller') addEdge(addressKey, key);
            else addEdge(key, addressKey);
            if (!visited.has(addressKey)) next.set(addressKey, address);
          }
        }
        frontier = next;
      }
    };

    await walk('caller');
    await walk('callee');
    return { nodes:[...nodes.values()], edges:[...edges.values()] };
  }, { signal });
}

export async function showCallGraphPanel(app, addr) {
  let drawController = null;
  let closed = false;
  const sheet = new Sheet('呼び出し図', {
    size:'full',
    onClose:() => {
      closed = true;
      drawController?.abort('call-graph-sheet-closed');
    },
  });
  const status = el('div', 'hint', 'AnalysisQueryAPIから呼び出し関係を集めています…');
  const host = el('div', 'graph-host');
  sheet.body.append(status, host);
  let depth = 1;
  let drawSerial = 0;
  const chips = el('div', 'chips inline');
  for (const value of [1, 2, 3]) {
    chips.append(button(`${value} 段`, `chip${value === 1 ? ' on' : ''}`, (event) => {
      depth = value;
      for (const child of chips.children) child.classList.remove('on');
      event.currentTarget.classList.add('on');
      void draw();
    }));
  }
  const { renderGraph, graphLegend } = await import('./graphview.js');
  sheet.body.append(chips, graphLegend('call'));

  async function draw() {
    drawController?.abort('call-graph-depth-changed');
    const controller = new AbortController();
    drawController = controller;
    const serial = ++drawSerial;
    status.textContent = 'AnalysisQueryAPIから呼び出し関係を集めています…';
    try {
      const graph = await buildQueryCallGraph(app, BigInt(addr), depth, { signal:controller.signal });
      if (closed || controller.signal.aborted || serial !== drawSerial || !sheet.root.isConnected) return;
      status.textContent = `${graph.nodes.length} 個の関数 · 箱を押すとその関数を開きます`;
      for (const node of graph.nodes) {
        node.onTap = () => { sheet.close(); app.openFunctionReport(node.addr); };
      }
      host.replaceChildren(renderGraph(graph.nodes, graph.edges, {}));
    } catch (error) {
      if (closed || controller.signal.aborted || error?.name === 'AbortError' || serial !== drawSerial) return;
      status.textContent = `呼び出し関係を取得できませんでした: ${error?.message || error}`;
      host.replaceChildren();
    }
  }
  void draw();
}

export async function showDebugger(app, ...args) {
  install(app);
  const base = await loadToolsBase();
  return base.showDebugger(app, ...args);
}

export async function showRename(app, ...args) {
  const base = await loadToolsBase();
  return base.showRename(app, ...args);
}

export async function showComment(app, ...args) {
  const base = await loadToolsBase();
  return base.showComment(app, ...args);
}

export async function showNotes(app, ...args) {
  const base = await loadToolsBase();
  return base.showNotes(app, ...args);
}

export async function showPatches(app, ...args) {
  const base = await loadToolsBase();
  return base.showPatches(app, ...args);
}

export async function showPatchEditor(app, ...args) {
  const base = await loadToolsBase();
  return base.showPatchEditor(app, ...args);
}

export async function showStructs(app, ...args) {
  const base = await loadToolsBase();
  return base.showStructs(app, ...args);
}

export async function showCxxClasses(app, ...args) {
  const base = await loadToolsBase();
  return base.showCxxClasses(app, ...args);
}

export async function showLinkage(app, ...args) {
  const base = await loadToolsBase();
  return base.showLinkage(app, ...args);
}

export async function showGlobals(app, ...args) {
  const base = await loadToolsBase();
  return base.showGlobals(app, ...args);
}

export async function showScript(app, ...args) {
  const base = await loadToolsBase();
  return base.showScript(app, ...args);
}

export async function showPlugins(app, ...args) {
  const base = await loadToolsBase();
  return base.showPlugins(app, ...args);
}

export async function showIl2cpp(app, ...args) {
  const base = await loadToolsBase();
  return base.showIl2cpp(app, ...args);
}


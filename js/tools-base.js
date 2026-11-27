/*
 * 解析ツール一式の画面。
 *
 * IDA や Ghidra にある道具を、初心者にも分かる言葉で並べたところです。
 * どれも「何のための道具か」を最初に 1 行で説明してから中身を出します。
 *
 *   逆コンパイル    … アセンブリを C 風に読み直す
 *   制御フロー図    … 分かれ道と合流を絵にする
 *   呼び出し図      … 誰が誰を呼ぶかを絵にする
 *   型と変数        … 引数・戻り値・ローカル変数の見当をつける
 *   構造体          … オブジェクトの中身の並びを組み立てる
 *   C++ クラス      … vtable と RTTI からクラスを取り出す
 *   名前とメモ      … 自分で名前を付けて覚えておく
 *   外とのつながり  … インポート・エクスポート・ライブラリ
 *   グローバル変数  … どこからでも触れる置き場
 *   パッチ          … 命令を書き換えて試す
 *   実行してみる    … 1 命令ずつ動かす（エミュレータ）
 *   スクリプト      … 同じ作業をまとめて自動化する
 *   プラグイン      … 自分で機能を足す
 *   Unity           … global-metadata.dat から C# の名前を戻す
 */

import {
  Sheet, el, button, list, groupRow, kvRow, tapRow, para, heading, noteBox,
  codeBlock, block, disclosure, toast, alertDialog, copyText, menu, userError,
} from './ui.js';
import { addrHex } from './format.js';
import { decompile, decompiledText } from './decompile.js';
import { decompilerSourceRows, formatDecompilerSource, fullDecompilerSourceText, hasSingleDecompilerInstruction, primaryDecompilerAddress } from './decompiler/provenance.js';
import { showDecompilerProvenanceSheet } from './ui/decompiler-provenance-sheet.js';
import { cfgGraph, callGraph, renderGraph, graphLegend } from './graphview.js';
import { inferTypes, recoverStruct, TypeStore, structToC, BASIC_TYPES, typeJa } from './types.js';
import { readableName, shortName, isMangled, findCxxClasses, readVtable, rttiPointerContextForSlice } from './rtti.js';
import { importList, importsByFramework, exportList, findGlobals } from './linkage.js';
import { assemble, suggestPatches, parseHexBytes, hexOf, validatePatchRange, validateMultiInstructionPatchRange, instructionPatchArchitectureSupported } from './patch.js';
import { runScript, SAMPLES, makeEmulator } from './script.js';
import { EXAMPLE_PLUGIN, MAX_PLUGIN_SOURCE_BYTES } from './plugins.js';
import { parseMetadataAuto, looksLikeUnity, bindMethodAddresses, MAX_IL2CPP_METADATA_BYTES } from './il2cpp.js';
import { parseMetadataFileInWorker } from './il2cpp-runtime.js';
import { brief } from './arm64.js';
import { pick, lang } from './i18n.js';

function captureAppEpoch(app) {
  return { epoch: app?.backend?.gen, sliceIndex: app?.store?.get?.('sliceIndex') };
}
function isAppEpochCurrent(app, snap, sheet = null) {
  if (sheet && sheet.root && sheet.root.isConnected === false) return false;
  if (snap.epoch !== app?.backend?.gen) return false;
  if (snap.sliceIndex !== app?.store?.get?.('sliceIndex')) return false;
  return true;
}

/* ── 小道具 ─────────────────────────────────────────────── */

function input(placeholder, value) {
  const n = el('input');
  n.type = 'text';
  n.autocapitalize = 'off';
  n.autocomplete = 'off';
  n.spellcheck = false;
  if (placeholder) n.placeholder = placeholder;
  if (value != null) n.value = value;
  return n;
}

function field(node, label, onGo) {
  const f = el('div', 'field');
  f.append(node);
  if (label) f.append(button(label, 'chip', onGo));
  return f;
}

function textArea(value, rows) {
  const n = el('textarea', 'code-input');
  n.rows = rows || 8;
  n.spellcheck = false;
  n.autocapitalize = 'off';
  if (value) n.value = value;
  return n;
}

/** いま見ている関数の先頭アドレス。分からなければ null。 */
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

function fnName(app, addr) {
  if (addr == null) return '—';
  const n = app.symbols ? (app.symbols.nameAt(addr) || app.symbols.label(addr)) : null;
  return n ? shortName(n) : 'sub_' + addr.toString(16).toUpperCase();
}

function needFunction(app) {
  const addr = currentFunctionAddr(app);
  if (addr == null) {
    toast(pick('先に関数を選んでください（「関数」から選ぶか、命令をタップします）。', 'Select a function first (from Functions or by tapping an instruction).'));
    return null;
  }
  return addr;
}

/** 関数を解析して model を得る。 */
export async function modelOf(app, addr) {
  const snap = captureAppEpoch(app);
  const region = app.store.get('currentRegion');
  if (!region) return null;
  const owner = app.executableRegionFor?.(addr) ?? app.regionForAddress?.(addr) ?? null;
  if (owner?.exec && owner !== region) app.selectRegion(owner, { silent:true });
  const fn = app.symbols?.functionAt?.(addr);
  if (!fn && owner?.exec && app.backend?.guessFunctions) {
    const res = await app.backend.guessFunctions(owner.id);
    if (!isAppEpochCurrent(app, snap)) return null;
    if (res?.starts?.length && app.symbols?.addFunctions) {
      app.symbols.addFunctions(res.starts);
    }
  }
  const result = await app.analyzeFunctionAt(addr);
  if (!isAppEpochCurrent(app, snap)) return null;
  return result;
}

function rowMapper(app) {
  const region = app.store.get('currentRegion');
  return {
    rowOfAddress: (a) => (a == null || !region || !app.viewer?.rowOfAddress ? null : app.viewer.rowOfAddress(a)),
    addrOfRow: (row) => (region && app.viewer?.rowAddress ? app.viewer.rowAddress(row) : null),
  };
}


export function parseDebuggerArgument(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !/^-?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(raw)) {
    return { ok: false, value: null, error: pick('10進整数か0x付き16進整数を入力してください。', 'Enter a decimal integer or a 0x-prefixed hex integer.') };
  }
  try {
    if (/^-0[xX]/.test(raw)) return { ok: true, value: -BigInt(raw.slice(1)), error: null };
    return { ok: true, value: BigInt(raw), error: null };
  } catch { return { ok: false, value: null, error: pick('整数として読み取れません。', 'Could not parse as an integer.') }; }
}

export function explainEmulatorFault(code, message) {
  const c = String(code || '').toLowerCase();
  const msg = String(message || '');
  const low = msg.toLowerCase();
  if (c === 'program-return' || msg.includes('最初の呼び出し元まで戻ってきました')) {
    return pick('関数が正常に終了して戻ってきました。', 'The function returned normally.');
  }
  if (c === 'max-steps' || c === 'step-limit' || c === 'invalid-step-budget' || msg.includes('命令ぶん進んだので、いったん止めました')) {
    return pick(
      '実行命令数の上限に達したため停止しました（無限ループ、または処理が長すぎる可能性があります）。\nヒント: 下の「通った道」で同じ場所を繰り返していないか確認し、分岐命令にパッチを当てて試してみてください。',
      'Stopped after reaching the instruction step limit (possible infinite loop or long execution).\nHint: Check the trace below for repeating addresses, or patch a branch instruction to test.',
    );
  }
  if (c === 'unmapped-memory' || c === 'memory-read-failed'
      || low.includes('no backing memory') || low.includes('outside backed memory')
      || low.includes('outside synthetic mapping') || low.includes('backing memory is unavailable')
      || low.includes('write offset is outside page')) {
    const addrMatch = /0x([0-9a-f]+)/i.exec(msg);
    const faultAddr = addrMatch ? BigInt('0x' + addrMatch[1]) : null;
    if (faultAddr != null && faultAddr < 0x1000n) {
      return pick(
        `NULL（0）付近のアドレス（0x${faultAddr.toString(16)}）を読み書きしようとして停止しました。ポインタ（アドレス）を引数に取る関数かもしれません。\nヒント: 「ダミー領域を引数にセット」を押して x0 などに仮のメモリ番地を入れてからもう一度試してみてください。`,
        `Stopped on a memory access near NULL (0x${faultAddr.toString(16)}). This function may expect a pointer argument.\nHint: Use "Set dummy buffer as arg" to place a temporary address into x0 (or another register) and try again.`,
      );
    }
    return pick(
      `割り当てられていないメモリ領域${faultAddr != null ? `（0x${faultAddr.toString(16)}）` : ''}への読み書きが起きたため停止しました。\nヒント: 引数に不正なアドレスが入っていないか確認し、ポインタ引数には「ダミー領域を引数にセット」を試してください。`,
      `Stopped on an access to unmapped memory${faultAddr != null ? ` (0x${faultAddr.toString(16)})` : ''}.\nHint: Check whether an argument holds an invalid address, or try "Set dummy buffer as arg" for pointer arguments.`,
    );
  }
  if (c === 'unsupported-instruction' || c === 'pointer-authentication-unsupported'
      || c === 'unsupported-operand' || c === 'unsupported-shift'
      || c === 'unsupported-arrangement' || c === 'invalid-fmov-form'
      || msg.includes('まだ実行できません') || low.includes('not modelled') || low.includes('unsupported')) {
    return pick(
      `このエミュレータがまだ対応していない命令に到達したため停止しました（${msg || c}）。\nヒント: 該当命令をパッチで nop に置き換えるか、直前にブレークポイントを置いて途中までの値を確認してみてください。`,
      `Stopped on an instruction not yet supported by this emulator (${msg || c}).\nHint: Patch that instruction to nop, or set a breakpoint right before it to inspect intermediate values.`,
    );
  }
  if (c === 'instruction-fetch-failed' || c === 'unmapped-tail-branch' || c === 'unknown-executable'
      || msg.includes('の命令が読めませんでした') || msg.includes('間接分岐先')) {
    return pick(
      `実行できないアドレスへジャンプしたため停止しました（${msg || c}）。\nヒント: 分岐先や関数ポインタ（引数やメモリ上の値）が正しく設定されているか確認してください。`,
      `Stopped after jumping to a non-executable address (${msg || c}).\nHint: Verify the branch target or function pointer values in registers and memory.`,
    );
  }
  if (c === 'heap-exhausted' || c === 'allocation-overflow') {
    return pick(
      'エミュレータ内の仮想ヒープ容量を超えたため停止しました。\nヒント: 引数に渡しているサイズ値が大きすぎないか確認してください。',
      'Stopped because the emulator virtual heap was exhausted.\nHint: Check whether a size argument is unusually large.',
    );
  }
  return msg || pick('ブレークポイントで止まりました。', 'Stopped at a breakpoint.');
}

/* ══════════════════════════════════════════════════════════
   入口: 道具箱
   ══════════════════════════════════════════════════════════ */

/*
 * 解析の入口は、ここ 1 つ。
 *
 * 以前は「自動解析」「解析ツール」「機能」がツールバーに別々に並んでいて、
 * どれが何をする物なのか、どれが当てにならない物なのかが分からなくなっていた。
 * ここでは
 *   1. まず何をすればいいか   （自動解析 → 目的から探す）
 *   2. いま見ている関数を調べる
 *   3. ファイル全体を調べる
 *   4. 書き換える・自動化する
 * の順に置き、1 行ごとに「事実 / 推定 / 参考」の札を付ける。
 * 札の意味は「この結果はどこまで信用できるか」に 1 枚でまとめてある。
 */

/* この道具は、バイナリを読んだだけか、そこから推し量ったものか。 */
const FACT = 'fact';
const INFER = 'infer';
const HINT = 'hint';

const levelWord = (level) => (
  level === FACT ? pick('事実', 'Fact')
    : level === INFER ? pick('推定', 'Inferred')
      : pick('参考', 'Hint')
);
const LEVEL_CLASS = { fact: 'tag-fact', infer: 'tag-infer', hint: 'tag-hint' };

export function showTools(app) {
  const sheet = new Sheet(pick('解析', 'Analysis Tools'));
  const addr = currentFunctionAddr(app);

  if (addr != null) {
    const b = block(pick('いま見ている関数', 'Current function'));
    b.append(el('div', 'bigval mono', fnName(app, addr)));
    b.append(el('div', 'hint', addrHex(addr)));
    sheet.body.append(b);
  }

  /** 1 行。level は「その結果をどこまで信じていいか」。 */
  const rowIn = (ul) => (level, label, sub, fn) => ul.append(tapRow(label, {
    sub,
    tag: levelWord(level),
    tagClass: LEVEL_CLASS[level],
    right: '›',
    onTap: () => { sheet.close(); fn(); },
  }));

  /* ── 1. まず何をすればいいか ── */
  const first = list();
  first.append(groupRow(pick('まず、ここから', 'Start here')));
  const item0 = rowIn(first);
  item0(INFER, pick('自動解析（ぜんぶ自動で調べる）', 'Automatic analysis'),
    pick('開いてから終わるまで待つだけ。何が分かって、何が分からなかったかを最後にまとめて言います。',
      'Scan the whole binary automatically and summarise what was proved and what remained unknown.'),
    () => app.openOverview());
  item0(INFER, pick('目的から探す（HP・所持金・攻撃力…）', 'Investigate by goal (HP, currency, attack…)'),
    pick('探したいものを選ぶか、ふつうの言葉で書きます。名前・参照・命令の 3 方向から絞ります。',
      'Pick a goal or describe what you are looking for. Narrows candidates by names, xrefs, and instructions.'),
    () => app.openInvestigate());
  item0(HINT, pick('使っている言葉から見る（機能一覧）', 'Browse by feature words'),
    pick('文字列を機能ごとに分けたものです。ここに出るのは手がかりで、答えではありません。',
      'Strings grouped by feature. Treat these as starting clues rather than final proof.'),
    () => app.openFeatures());
  sheet.body.append(first);

  /* ── 2. いま見ている関数 ── */
  const perFunction = list();
  perFunction.append(groupRow(pick('いま見ている関数を調べる', 'Inspect current function')));
  const item = rowIn(perFunction);
  const withFn = (fn) => () => { const a = needFunction(app); if (a != null) fn(a); };

  item(INFER, pick('逆コンパイル（C 風に読む）', 'Decompile (pseudo-C)'),
    pick('アセンブリを if / while / 代入の形に直します。いちばん読みやすい形です。訳なので、元のソースそのものではありません。',
      'Rewrite assembly into readable if / while / assignment form. This is a translation, not original source.'),
    withFn((a) => showDecompiler(app, a)));
  item(FACT, pick('制御フロー図（分かれ道を絵にする）', 'Control-flow graph (CFG)'),
    pick('命令の並びをそのまま絵にしたものです。ループの位置がひと目で分かります。',
      'Visualise branches and basic blocks directly from the instruction stream.'),
    withFn((a) => showCfg(app, a)));
  item(FACT, pick('呼び出し図（誰が誰を呼ぶか）', 'Call graph'),
    pick('この関数を呼ぶ側・この関数が呼ぶ相手を、上下に広げて描きます。',
      'Show callers above and callees below this function.'),
    withFn((a) => showCallGraphPanel(app, a)));
  item(INFER, pick('引数・戻り値・変数の型', 'Types & variables'),
    pick('使われ方からの推定です。「4 バイトで比較されている」以上のことは言えません。',
      'Inferred from how registers and stack slots are used.'),
    withFn((a) => showTypes(app, a)));
  item(INFER, pick('構造体を組み立てる', 'Recover struct layout'),
    pick('[x0, #0x20] のような使い方から、オブジェクトの中身の並びを起こします。触られていない場所は空きのままです。',
      'Reconstruct object fields from offset accesses such as [x0, #0x20]. Unaccessed gaps stay unknown.'),
    withFn((a) => showStructRecover(app, a)));
  item(FACT, pick('実行してみる（1 命令ずつ・デバッガ）', 'Emulate / Debugger (step by step)'),
    pick('命令のとおりに動かして、レジスタとメモリの変化を見ます。実機は使いません。',
      'Step through instructions in the browser emulator to inspect registers and memory.'),
    withFn((a) => showDebugger(app, a)));
  item(FACT, pick('名前を付ける / メモを書く', 'Rename / Add note'),
    pick('分かったことにその場で名前を付けます。次に見たときに思い出せます。',
      'Label symbols and attach notes as you analyse.'),
    withFn((a) => showRename(app, a)));
  sheet.body.append(perFunction);

  /* ── 3. ファイル全体 ── */
  const whole = list();
  whole.append(groupRow(pick('ファイル全体を調べる', 'Inspect whole binary')));
  const item2 = rowIn(whole);
  item2(FACT, pick('外とのつながり（インポート / ライブラリ）', 'External linkage (imports / libraries)'),
    pick('リンカの表をそのまま読んだものです。借りている関数から、アプリの性格が見えます。',
      'Read linker tables directly to see imported APIs and linked libraries.'),
    () => showLinkage(app));
  item2(FACT, pick('グローバル変数', 'Global variables'),
    pick('どこからでも触れる置き場。所持金やログイン状態はここにあります。',
      'Shared static storage referenced across functions.'), () => showGlobals(app));
  item2(FACT, pick('C++ のクラス（RTTI / vtable）', 'C++ classes (RTTI / vtable)'),
    pick('バイナリに残っている型情報から、クラス名と仮想関数の並びを取り出します。',
      'Extract class names and virtual method tables from binary RTTI.'), () => showCxxClasses(app));
  item2(FACT, pick('Unity（IL2CPP）の名前を戻す', 'Restore Unity (IL2CPP) names'),
    pick('global-metadata.dat を読み込むと、C# のクラス名とメソッド名が戻ります。',
      'Load global-metadata.dat to recover C# class and method names.'), () => showIl2cpp(app));
  sheet.body.append(whole);

  /* ── 4. 書き換える・ためる・自動化する ── */
  const work = list();
  work.append(groupRow(pick('書き換える・自動化する', 'Patch & automate')));
  const item3 = rowIn(work);
  item3(FACT, pick('パッチ（命令の書き換え）', 'Patches (edit instructions)'),
    pick('命令を書き換えて、結果を新しいファイルとして保存します。',
      'Modify instructions and export a patched binary.'), () => showPatches(app));
  item3(FACT, pick('自分で付けた名前とメモ', 'Saved names & notes'),
    pick('書き溜めたものの一覧・書き出し・読み込み。',
      'View, export, and import your annotations.'), () => showNotes(app));
  item3(FACT, pick('構造体（自分で作ったもの）', 'Custom structs'),
    pick('作った型の一覧と、C のヘッダとしての書き出し。',
      'List your struct definitions and export C headers.'), () => showStructs(app));
  item3(FACT, pick('スクリプト（自動化）', 'Scripting (automation)'),
    pick('同じ作業を何百回も繰り返すときに。IDAPython にあたるものです。',
      'Automate repetitive analysis tasks with JavaScript.'), () => showScript(app));
  item3(FACT, pick('プラグイン', 'Plugins'), pick('自分で書いた機能を足します。', 'Load and run custom extensions.'), () => showPlugins(app));
  sheet.body.append(work);

  /* ── 5. 札の意味 ── */
  const about = list();
  about.append(groupRow(pick('札の意味', 'Confidence labels')));
  about.append(tapRow(pick('この結果はどこまで信用できるか', 'How much can I trust these results?'), {
    sub: pick('「事実」「推定」「参考」の違いと、機能ごとに測った精度。',
      'Differences between Fact, Inferred, and Hint, plus measured accuracy per tool.'),
    right: '›',
    onTap: () => { sheet.close(); app.openAccuracyNotes(); },
  }));
  sheet.body.append(about);
}

/* ══════════════════════════════════════════════════════════
   逆コンパイル

   アセンブリを C 風に読み直した結果を出す面。

   ここは「読む」ための面なので、画面の広さを全部使う。
   以前は狭いシートの中に、1 命令 1 行の訳と、行ごとに同じ注釈が
   並んでいて、200 行の関数が 600 行になっていた。
   ══════════════════════════════════════════════════════════ */

export async function showDecompiler(app, addr) {
  const snap = captureAppEpoch(app);
  const sheet = new Sheet(pick('逆コンパイル', 'Decompile'), { size: 'full' });
  const status = el('div', 'hint', pick('解析しています…', 'Analysing…'));
  sheet.body.append(status);

  const res = await modelOf(app, addr);
  if (!isAppEpochCurrent(app, snap, sheet)) return;
  if (!res || !res.model) {
    status.textContent = pick('この場所は関数として解析できませんでした。', 'Could not analyse this location as a function.');
    return;
  }
  const map = rowMapper(app);
  let showAsm = false;
  let showNotes = false;
  try { await app.ensureObjc?.(); } catch { /* ObjC metadata is optional */ }
  if (!isAppEpochCurrent(app, snap, sheet)) return;

  const out = decompile(res.model, {
    name: app.symbols.nameAt(addr),
    addr,
    rowOfAddress: map.rowOfAddress,
    addrOfRow: map.addrOfRow,
    symbolFor: (a) => {
      const n = app.symbols.nameAt(a);
      return n ? n : null;
    },
    fieldFor: (baseReg, offset) => fieldNameFor(app, addr, baseReg, offset),
    objcModel: app.objcModel || null,
    objcRuntimeIndex: app.objcRuntime || null,
    notes: app.notes,
  });

  status.remove();
  sheet.body.classList.add('nogrow');

  /* 見出し。関数の名前と形は、下までスクロールしても見えるように貼り付ける。 */
  const head = el('div', 'code-head');
  head.append(el('div', 'code-sig mono', out.signature));
  const meta = el('div', 'code-meta');
  meta.append(el('span', null, addrHex(addr)));
  meta.append(el('span', null, res.instructions + ' 命令 → ' +
    out.lines.filter((l) => l.kind === 'stmt' || l.kind === 'ctrl').length + ' 行'));
  if (out.ctx && out.ctx.carry) {
    meta.append(el('span', 'code-carry',
      'result ＝ ' + out.ctx.carry.reg + '（' + out.ctx.carry.steps + ' 段で組み立てている値）'));
  }
  head.append(meta);

  /* 表示の切り替え。押せる状態が見て分かるように、入れたものは色を付ける。 */
  const chips = el('div', 'chips code-chips');
  const asmChip = button('アセンブリを併記', 'chip', () => {
    showAsm = !showAsm;
    asmChip.classList.toggle('on', showAsm);
    render();
  });
  const noteChip = button('日本語の注釈', 'chip', () => {
    showNotes = !showNotes;
    noteChip.classList.toggle('on', showNotes);
    render();
  });
  chips.append(asmChip, noteChip);
  chips.append(button('コピー', 'chip', () => copyText(decompiledText(out), '逆コンパイル結果')));
  chips.append(button('命令との双方向対応', 'chip', () => showDecompilerProvenanceSheet(app, addr)));
  chips.append(button('図で見る', 'chip', () => { sheet.close(); showCfg(app, addr); }));
  head.append(chips);
  sheet.body.append(head);
  sheet.body.append(para(
    'これは命令から組み立てた読みやすい訳であり、元のソースコードではありません。',
    'sub'));

  for (const w of out.warnings) sheet.body.append(el('div', 'hint warn', '⚠ ' + w));

  const codeWrap = el('div', 'codeview code-full');
  sheet.body.append(codeWrap);

  const byRow = new Map();
  for (const i of res.model.instructions) byRow.set(i.row, i);

  const preparedLines = out.lines.map((l) => {
    if (l.kind === 'blank') return { l, blank: true };
    const sourceRows = decompilerSourceRows(l);
    const sourceInsns = [];
    for (let i = 0; i < sourceRows.length; i++) {
      const insn = byRow.get(sourceRows[i]);
      if (insn) sourceInsns.push(insn);
    }
    return { l, blank: false, sourceInsns, primary: primaryDecompilerAddress(l) };
  });

  const rowLineMap = new WeakMap();
  codeWrap.addEventListener('click', (event) => {
    const target = event.target?.closest?.('.cl.tappable');
    const info = target ? rowLineMap.get(target) : null;
    if (info) lineMenu(app, sheet, info.l, info.sourceInsns);
  });

  function render() {
    const frag = typeof document.createDocumentFragment === 'function'
      ? document.createDocumentFragment()
      : null;
    const container = frag || codeWrap;
    if (!frag) codeWrap.replaceChildren();
    for (let i = 0; i < preparedLines.length; i++) {
      const entry = preparedLines[i];
      const l = entry.l;
      if (entry.blank) { container.append(el('div', 'cl blank', ' ')); continue; }
      const { sourceInsns, primary } = entry;
      const row = el('div', 'cl ' + l.kind);
      const gutter = el('span', 'cl-addr mono', formatDecompilerSource(l, { maxGroups: 1 }));
      const text = el('span', 'cl-text mono');
      paintCode(text, '    '.repeat(Math.max(0, l.indent)) + l.text);
      row.append(gutter, text);
      if (primary != null) {
        row.classList.add('tappable');
        row.title = fullDecompilerSourceText(l);
        rowLineMap.set(row, entry);
      }
      container.append(row);
      if (showNotes && l.note) {
        const n = el('div', 'cl note');
        n.append(el('span', 'cl-addr'), el('span', 'cl-text', '// ' + l.note));
        container.append(n);
      }
      if (showAsm) {
        for (let j = 0; j < sourceInsns.length; j++) {
          const insn = sourceInsns[j];
          const a = el('div', 'cl asm');
          const asmAddr = insn.address != null ? insn.address.toString(16).toUpperCase().slice(-6).padStart(6, '0') : '';
          a.append(el('span', 'cl-addr mono', asmAddr), el('span', 'cl-text mono', '; ' + insn.mnemonic + ' ' + insn.operands));
          container.append(a);
        }
      }
    }
    if (frag) codeWrap.replaceChildren(frag);
  }
  render();
}

/*
 * 1 行に色を付ける。
 *
 * 全部が同じ黒で並んでいると、どこが呼び出しでどこが数か、
 * 目で追うところから始めることになる。C を読むときと同じ色分けにする。
 * innerHTML は使わない（名前に < > が入ることがあるため）。
 */
const CODE_TOKENS = new RegExp([
  '("(?:[^"\\\\]|\\\\.)*")',                                  // 文字列
  '\\b(if|else|while|for|do|return|goto|switch|case|break|continue)\\b',
  '\\b(int8|int16|int32|int64|uint8|uint16|uint32|uint64|void|double|float|char|bool|result)\\b',
  '(\\b0x[0-9A-Fa-f]+\\b|\\b\\d+\\b)',                            // 数
  '([A-Za-z_][\\w:.$]*)(?=\\s*\\()',                                // 呼び出し
  '(//.*$|/\\*.*?\\*/)',                                          // 注釈
].join('|'), 'g');

function paintCode(node, text) {
  node.replaceChildren();
  if (!text) return;
  CODE_TOKENS.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = CODE_TOKENS.exec(text)) !== null) {
    const at = m.index;
    if (at > last) node.append(document.createTextNode(text.slice(last, at)));
    const cls = m[1] ? 'c-str' : m[2] ? 'c-kw' : m[3] ? 'c-type'
      : m[4] ? 'c-num' : m[5] ? 'c-call' : 'c-cmt';
    node.append(el('span', cls, m[0]));
    last = at + m[0].length;
    if (m[0].length === 0) CODE_TOKENS.lastIndex++;
  }
  if (last < text.length) node.append(document.createTextNode(text.slice(last)));
}

/** その行に対してできること。 */
function lineMenu(app, sheet, line, sourceInsns = []) {
  const primary = primaryDecompilerAddress(line);
  if (primary == null) return;
  const items = [
    { label: '対応する先頭命令へ移動', action: () => { sheet.close(); app.goToAddress(primary, { announce: true }); } },
    { label: '対応する命令アドレスをコピー', action: () => copyText(fullDecompilerSourceText(line), '命令アドレス') },
  ];
  const callInsn = sourceInsns.find((x) => x?.isCall || x?.callTarget != null) || null;
  const callTarget = callInsn?.callTarget ?? null;
  const raw = callTarget != null && app.symbols ? app.symbols.nameAt(callTarget) : null;
  if (raw && isMangled(raw)) {
    items.push({ label: 'この名前の元の形を見る', action: () => showRealName(raw) });
  }
  if (hasSingleDecompilerInstruction(line) && sourceInsns.length === 1) {
    items.push({ label: 'この命令を書き換える（パッチ）', action: () => showPatchEditor(app, primary, sourceInsns[0]) });
    items.push({ label: 'メモを書く', action: () => showComment(app, primary) });
  } else if (sourceInsns.length) {
    items.push({ label: '先頭命令にメモを書く', action: () => showComment(app, primary) });
  }
  if (callTarget != null) {
    items.push({
      label: '呼んでいる相手を調べる',
      action: () => { sheet.close(); app.openFunctionReport(callTarget); },
    });
  }
  menu(items, window.innerWidth / 2, window.innerHeight / 2);
}

/**
 * 名前の「元の形」を見せる。
 *
 * 行に出しているのは短くした形なので、テンプレート引数や引数の型まで
 * 確かめたいときのために、3 つの段階をぜんぶ並べる。
 */
function showRealName(raw) {
  const sheet = new Sheet('この名前について');
  const ul = list();
  ul.append(groupRow('3 つの段階'));
  ul.append(kvRow('行に出している形', shortName(raw)));
  ul.append(kvRow('読める形に戻したもの', readableName(raw)));
  sheet.body.append(ul);
  sheet.body.append(el('div', 'sec-title', 'リンカが残した、そのままの名前'));
  sheet.body.append(codeBlock(raw));
  const chips = el('div', 'chips');
  chips.append(button('コピー', 'chip', () => copyText(raw, '名前')));
  sheet.body.append(chips);
  sheet.body.append(el('div', 'hint',
    'C++ は、同じ名前の関数を引数の型で見分けます。そのため引数の型まで名前に' +
    '埋め込まれていて（マングリング）、そのままでは記号の列に見えます。'));
}

/** [x0, #0x20] に名前が付けられるか（Objective-C のクラス表から）。 */
function fieldNameFor(app, funcAddr, baseReg, offset) {
  if (!app.fields || !app.fields.classCount) return null;
  const owner = app.ownerOf(funcAddr);
  if (!owner) return null;
  const f = app.fields.fieldAt(owner.className || owner.name || owner, offset);
  return f ? { name: f.name, type: f.type } : null;
}

/* ══════════════════════════════════════════════════════════
   図（CFG / コールグラフ）
   ══════════════════════════════════════════════════════════ */

export async function showCfg(app, addr) {
  const snap = captureAppEpoch(app);
  /* 図は画面いっぱいで見せる。小さい窓に押し込むと、結局そのたびに広げることになる。 */
  const sheet = new Sheet(pick('制御フロー図', 'Control Flow Graph'), { size: 'full' });
  const status = el('div', 'hint', pick('解析しています…', 'Analysing…'));
  sheet.body.append(status);
  const res = await modelOf(app, addr);
  if (!isAppEpochCurrent(app, snap, sheet)) return;
  if (!res || !res.model) { status.textContent = pick('この場所は関数として解析できませんでした。', 'Could not analyse this location as a function.'); return; }
  status.remove();
  sheet.setTitle(pick('制御フロー図', 'Control Flow Graph') + ' — ' + fnName(app, addr));

  const map = rowMapper(app);
  const { nodes, edges } = cfgGraph(res.model, {
    rowOfAddress: map.rowOfAddress,
    text: (insn) => insn.mnemonic + ' ' + insn.operands,
    onNode: (b, a) => { sheet.close(); app.goToAddress(a, { announce: true }); },
  });
  if (!nodes.length) { sheet.body.append(el('div', 'hint', '図にできる情報がありませんでした。')); return; }

  const head = el('div', 'graph-head');
  head.append(el('span', null,
    nodes.length + ' 個のかたまり · ' + edges.length + ' 本の道 · 箱を押すとその場所へ移動します'));
  head.append(button('この図の読み方', 'chip', () => showGraphHelp('cfg')));
  sheet.body.classList.add('nogrow');
  sheet.body.append(head, renderGraph(nodes, edges, {}), graphLegend('cfg'));
}

export async function showCallGraphPanel(app, addr) {
  const snap = captureAppEpoch(app);
  const sheet = new Sheet(pick('呼び出し図', 'Call Graph'), { size: 'full' });
  const status = el('div', 'hint', pick('呼び出し関係を集めています…', 'Collecting call relationships…'));
  sheet.body.append(status);
  await app.ensureProgram();
  if (!isAppEpochCurrent(app, snap, sheet)) return;
  if (!app.program) { status.textContent = pick('呼び出し関係を作れませんでした。', 'Could not build call relationships.'); return; }
  status.remove();
  sheet.setTitle(pick('呼び出し図', 'Call Graph') + ' — ' + fnName(app, addr));

  let depth = 1;
  const head = el('div', 'graph-head');
  const count = el('span', null, '');
  head.append(count);
  const chips = el('div', 'chips inline');
  for (const d of [1, 2, 3]) {
    chips.append(button(d + ' 段', 'chip' + (d === depth ? ' on' : ''), (e) => {
      depth = d;
      for (const c of chips.children) c.classList.remove('on');
      e.currentTarget.classList.add('on');
      draw();
    }));
  }
  head.append(chips, button('この図の読み方', 'chip', () => showGraphHelp('call')));

  const wrap = el('div', 'graph-host');
  sheet.body.classList.add('nogrow');
  sheet.body.append(head, wrap, graphLegend('call'));

  function draw() {
    const { nodes, edges } = callGraph(app.program, app.symbols, addr, {
      depth, limit: depth >= 3 ? 4 : 8,
      label: (a) => fnName(app, a),
      onNode: (a) => { sheet.close(); app.openFunctionReport(a); },
    });
    count.textContent = '上が呼ぶ側・下が呼ばれる側 · ' + nodes.length + ' 個の関数 · ' +
      '箱を押すとその関数を開きます';
    wrap.replaceChildren(renderGraph(nodes, edges, {}));
  }
  draw();
}

/** 図の読み方。凡例だけでは足りない人のために、言葉でも置いておく。 */
function showGraphHelp(kind) {
  const sheet = new Sheet('この図の読み方');
  const ul = list();
  if (kind === 'call') {
    ul.append(groupRow('呼び出し図'));
    ul.append(kvRow('まん中の太枠', 'いま見ている関数'));
    ul.append(kvRow('上の箱', 'この関数を呼んでいる側'));
    ul.append(kvRow('下の破線の箱', 'この関数が呼んでいる相手'));
    ul.append(kvRow('段', '何段まで辿るか。増やすほど広く、遅くなります'));
  } else {
    ul.append(groupRow('制御フロー図'));
    ul.append(kvRow('四角', 'ひとかたまりの命令（basic block）。上から下へ順に実行されます'));
    ul.append(kvRow('緑の線', '条件が成り立ったときに進む道'));
    ul.append(kvRow('赤の線', '成り立たなかったときに進む道'));
    ul.append(kvRow('破線で戻る', 'ループ。同じところを繰り返します'));
    ul.append(kvRow('太枠', '入口。ここから始まります'));
  }
  sheet.body.append(ul);
  const ops = list();
  ops.append(groupRow('動かし方'));
  ops.append(kvRow('押したまま動かす', '図をつかんで動かします'));
  ops.append(kvRow('2 本指でつまむ', '拡大・縮小します'));
  ops.append(kvRow('全体', '全部が入る大きさに戻します'));
  ops.append(kvRow('箱を押す', 'その場所・その関数へ移動します'));
  sheet.body.append(ops);
}

/* ══════════════════════════════════════════════════════════
   型・変数
   ══════════════════════════════════════════════════════════ */

export async function showTypes(app, addr) {
  const snap = captureAppEpoch(app);
  const sheet = new Sheet(pick('引数・戻り値・変数', 'Arguments, Return & Variables'));
  const status = el('div', 'hint', pick('解析しています…', 'Analysing…'));
  sheet.body.append(status);
  const res = await modelOf(app, addr);
  if (!isAppEpochCurrent(app, snap, sheet)) return;
  if (!res || !res.model) { status.textContent = pick('この場所は関数として解析できませんでした。', 'Could not analyse this location as a function.'); return; }
  status.remove();

  const types = inferTypes(res.model);
  sheet.body.append(el('div', 'hint',
    fnName(app, addr) + '\n' +
    '型は「そのバイトを何として扱っているか」です。バイナリには書かれていないので、\n' +
    '命令の使い方（何バイト読んだか・何に渡したか）から推測しています。'));

  const render = () => {
    body.replaceChildren();

    const args = list();
    args.append(groupRow('受け取っているもの（引数）'));
    if (!types.args.length) args.append(tapRow('引数はなさそうです', { disabled: true, sub: 'x0〜x7 を、自分で値を入れる前に読んでいません。' }));
    for (const a of types.args) {
      const custom = app.notes.typeOf(addr, 'a' + a.index);
      args.append(tapRow((custom || a.type) + '  a' + (a.index + 1), {
        sub: 'レジスタ ' + a.reg + '  ·  ' + typeJa(custom || a.type) +
          (a.why.length ? '\n根拠: ' + a.why.map((w) => w.why).join(' / ') : '') +
          (custom ? '\n（自分で決めた型）' : ''),
        right: confidenceMark(a.conf),
        onTap: () => pickType(app, addr, 'a' + a.index, custom || a.type, render),
      }));
    }
    body.append(args);

    const ret = list();
    ret.append(groupRow('返しているもの（戻り値）'));
    const rt = app.notes.typeOf(addr, 'ret') || types.ret.type;
    ret.append(tapRow(rt, {
      sub: typeJa(rt) + (types.ret.why.length ? '\n根拠: ' + types.ret.why.map((w) => w.why).join(' / ') : ''),
      right: confidenceMark(types.ret.conf),
      onTap: () => pickType(app, addr, 'ret', rt, render),
    }));
    body.append(ret);

    const locals = list();
    locals.append(groupRow('スタックに置いているもの（ローカル変数）'));
    if (!types.locals.length) locals.append(tapRow('スタックは使っていません', { disabled: true }));
    for (const l of types.locals.slice(0, 60)) {
      const custom = app.notes.typeOf(addr, l.slot);
      locals.append(tapRow((custom || l.type) + '  var_' + Math.abs(l.offset).toString(16).toUpperCase(), {
        sub: l.slot + '  ·  ' + typeJa(custom || l.type) +
          (l.why.length ? '\n' + l.why.map((w) => w.why).join(' / ') : ''),
        right: confidenceMark(l.conf),
        onTap: () => pickType(app, addr, l.slot, custom || l.type, render),
      }));
    }
    body.append(locals);

    body.append(noteBox('★ の数は「どれくらい確からしいか」です。タップすると自分で型を決められます。'));
  };

  const body = el('div');
  sheet.body.append(body);
  render();
}

function confidenceMark(conf) {
  const n = conf >= 0.85 ? 3 : conf >= 0.6 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function pickType(app, funcAddr, key, current, onDone) {
  const items = BASIC_TYPES.map((t) => ({
    label: t.name + ' — ' + t.ja,
    action: () => {
      if (!app.notes.setType(funcAddr, key, t.name)) { notePersistenceFailure(app, '型'); onDone(); return; }
      toast('型を ' + t.name + ' にしました'); onDone();
    },
  }));
  items.push('-');
  items.push({ label: '推測にもどす', action: () => {
    if (!app.notes.setType(funcAddr, key, '')) notePersistenceFailure(app, '型');
    onDone();
  } });
  void current;
  menu(items, window.innerWidth / 2, 120);
}

/* ══════════════════════════════════════════════════════════
   構造体
   ══════════════════════════════════════════════════════════ */

export async function showStructRecover(app, addr) {
  const snap = captureAppEpoch(app);
  const sheet = new Sheet(pick('構造体を組み立てる', 'Recover Struct'));
  const status = el('div', 'hint', pick('解析しています…', 'Analysing…'));
  sheet.body.append(status);
  const res = await modelOf(app, addr);
  if (!isAppEpochCurrent(app, snap, sheet)) return;
  if (!res || !res.model) { status.textContent = pick('解析できませんでした。', 'Could not analyse.'); return; }
  status.remove();

  sheet.body.append(el('div', 'hint',
    'ひとつのレジスタが [x19, #0x10] / [x19, #0x18] のように使われていたら、\n' +
    'x19 は「0x10 と 0x18 に何かが入っている箱」を指しています。\n' +
    'その並びをまとめたものが構造体（struct）です。'));

  const rec = recoverStruct(res.model, null);
  if (!rec) {
    sheet.body.append(noteBox('この関数では、まとまった箱の使い方が見つかりませんでした。'));
    return;
  }

  const head = block(rec.base + ' が指している箱');
  head.append(el('div', 'hint', '全体で ' + rec.size + ' バイト、' + rec.members.length + ' か所を使っています。'));
  sheet.body.append(head);

  const members = list();
  for (const m of rec.members) {
    members.append(tapRow('+0x' + m.offset.toString(16).toUpperCase() + '  ' + m.type + ' ' + m.name, {
      sub: m.size + ' バイト  ·  読み ' + m.reads + ' 回 / 書き ' + m.writes + ' 回',
      onTap: () => toast(typeJa(m.type)),
    }));
  }
  sheet.body.append(members);

  sheet.body.append(codeBlock(structToC(rec)));

  const actions = el('div', 'chips');
  actions.append(button('この形を保存する', 'chip', () => {
    const store = new TypeStore(app.notes);
    const name = 'struct_' + addr.toString(16).toUpperCase();
    try {
      store.adopt(rec, name);
      toast(name + ' として保存しました');
    } catch (error) {
      if (error?.name !== 'PersistenceError') throw error;
      notePersistenceFailure(app, '構造体');
    }
  }));
  actions.append(button('C としてコピー', 'chip', () => copyText(structToC(rec), '構造体')));
  sheet.body.append(actions);
}

export function showStructs(app) {
  const sheet = new Sheet('構造体');
  const store = new TypeStore(app.notes);
  sheet.body.append(el('div', 'hint',
    '自分で作った型の一覧です。関数の画面から「構造体を組み立てる」で作れます。'));

  const render = () => {
    body.replaceChildren();
    const l = list();
    if (!store.list().length) l.append(tapRow('まだ 1 つもありません', { disabled: true }));
    for (const s of store.list()) {
      l.append(tapRow(s.name, {
        sub: s.members.length + ' 項目  ·  ' + s.size + ' バイト',
        onTap: () => showStructDetail(app, store, s, render),
      }));
    }
    body.append(l);
  };
  const body = el('div');
  sheet.body.append(body);
  render();
}

function showStructDetail(app, store, s, onChange) {
  const sheet = new Sheet(s.name);
  const render = () => {
    sheet.body.replaceChildren();
    const cur = store.list().find((x) => x.name === s.name) || s;
    sheet.body.append(codeBlock(store.toC(cur.name)));
    const l = list();
    for (const m of cur.members) {
      l.append(tapRow('+0x' + m.offset.toString(16).toUpperCase() + '  ' + m.type + ' ' + m.name, {
        sub: (m.size || 8) + ' バイト',
        onTap: () => {
          const nameIn = input('項目の名前', m.name);
          const d = el('div');
          d.append(para('この項目に名前を付けます。'), field(nameIn, '決定', () => {
            try {
              store.setMember(cur.name, m.offset, { name: nameIn.value.trim() || m.name });
            } catch (error) {
              if (error?.name !== 'PersistenceError') throw error;
              onChange(); notePersistenceFailure(app, '構造体'); return;
            }
            sh.back();
            sheet.destroyForward();
            render();
            onChange();
            toast('名前を付けました');
          }));
          const sh = new Sheet('項目の名前');
          sh.body.append(d);
        },
      }));
    }
    sheet.body.append(l);
    const chips = el('div', 'chips');
    chips.append(button('C としてコピー', 'chip', () => copyText(store.toC(cur.name), '構造体')));
    chips.append(button('削除', 'chip danger', () => {
      try { store.remove(cur.name); }
      catch (error) {
        if (error?.name !== 'PersistenceError') throw error;
        onChange(); notePersistenceFailure(app, '構造体の削除'); return;
      }
      sheet.close();
      onChange();
      toast('削除しました');
    }));
    sheet.body.append(chips);
  };
  render();
}

/* ══════════════════════════════════════════════════════════
   C++ のクラス（RTTI / vtable）
   ══════════════════════════════════════════════════════════ */

export function showCxxClasses(app) {
  const sheet = new Sheet('C++ のクラス');
  sheet.body.append(el('div', 'hint',
    'C++ は、クラスごとに「仮想関数の一覧表（vtable）」と「型の名札（RTTI）」を\n' +
    'バイナリの中に残します。ここからクラス名と、その持ちものが分かります。'));

  const classes = findCxxClasses(app.symbols);
  if (!classes.length) {
    sheet.body.append(noteBox(
      'このファイルには C++ のクラス情報が見当たりませんでした。\n' +
      'Objective-C や Swift で書かれているか、情報が削られている可能性があります。\n' +
      'Objective-C のクラスは「構造」の画面で見られます。'));
    return;
  }

  const search = input('クラス名で絞り込む');
  sheet.body.append(field(search, '探す', () => render()));
  const status = el('div', 'hint', classes.length + ' 個のクラスが見つかりました。');
  const l = list();
  sheet.body.append(status, l);
  const classNamesLower = classes.map((c) => c.name.toLowerCase());

  function render() {
    const q = search.value.trim().toLowerCase();
    let hits = classes;
    if (q) {
      hits = [];
      for (let i = 0; i < classes.length; i++) {
        if (classNamesLower[i].includes(q)) hits.push(classes[i]);
      }
    }
    l.replaceChildren();
    for (const c of hits.slice(0, 300)) {
      l.append(tapRow(c.name, {
        sub: (c.vtable != null ? 'vtable ' + addrHex(c.vtable) : '仮想関数なし') +
          (c.typeinfo != null ? '  ·  RTTI あり' : ''),
        onTap: () => showVtable(app, c),
      }));
    }
    status.textContent = hits.length + ' 個' + (hits.length > 300 ? '（先頭 300 個を表示）' : '');
  }
  render();
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') render(); });
}

async function showVtable(app, cls) {
  const snap = captureAppEpoch(app);
  const sheet = new Sheet(cls.name);
  if (cls.vtable == null) {
    sheet.body.append(noteBox(pick('このクラスには仮想関数の表がありません。', 'This class has no virtual method table.')));
    return;
  }
  const status = el('div', 'hint', pick('読み込んでいます…', 'Loading…'));
  sheet.body.append(status);
  const read = (a, len) => app.backend.readAt(a, len).then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
  const pointerContext = rttiPointerContextForSlice(
    app.currentSlice?.(),
    app.pointerResolutionContextFor?.(cls.vtable) ?? {},
  );
  const vt = await readVtable(read, cls.vtable, app.symbols, 64, pointerContext);
  if (!isAppEpochCurrent(app, snap, sheet)) return;
  if (!vt || !vt.slots.length) { status.textContent = pick('仮想関数の表を読めませんでした。', 'Could not read the virtual method table.'); return; }
  status.remove();

  const sampleOffset = 0x10;
  const sampleSlot = sampleOffset / vt.pointerBytes;
  sheet.body.append(el('div', 'hint',
    `仮想関数の各スロットは ${vt.pointerBytes} バイトです。\n` +
    `間接呼出しが vptr から byte offset 0x${sampleOffset.toString(16)} を読んでいたら、\n` +
    `0x${sampleOffset.toString(16)} ÷ ${vt.pointerBytes} = ${sampleSlot} 番のスロットです。`));

  const l = list();
  for (const s of vt.slots) {
    if (s.addr == null) {
      const raw = s.raw == null ? '' : `raw 0x${BigInt(s.raw).toString(16).toUpperCase()}`;
      const reason = s.binding ? `binding ${String(s.binding)}` : String(s.reason || 'pointer-unresolved');
      l.append(tapRow(`#${s.index}  解決できないポインタ`, {
        sub:[raw, reason].filter(Boolean).join(' · '),
        disabled:true,
      }));
      continue;
    }
    l.append(tapRow('#' + s.index + '  ' + (s.readable || s.name || 'sub_' + s.addr.toString(16).toUpperCase()), {
      sub: addrHex(s.addr) + (s.name && s.readable !== s.name ? '\n' + s.name : ''),
      onTap: () => { sheet.close(); app.openFunctionReport(s.addr); },
    }));
  }
  sheet.body.append(l);
}

/* ══════════════════════════════════════════════════════════
   外とのつながり
   ══════════════════════════════════════════════════════════ */

export async function showLinkage(app) {
  const snap = captureAppEpoch(app);
  const controller = new AbortController();
  const sheet = new Sheet(pick('外とのつながり', 'External Linkage'), { onClose:() => controller.abort('linkage-sheet-closed') });
  sheet.body.append(el('div', 'hint',
    'アプリ単体では画面も出せません。iOS が用意したライブラリを借りて動いています。\n' +
    '何を借りているかを見るだけで、アプリが何をするものかが半分わかります。'));

  let imports = importList(app.symbols, null);
  let groups = importsByFramework(imports);
  let usageComplete = false;
  const slice = app.currentSlice();
  const dylibs = slice && slice.info ? slice.info.dylibs || [] : [];

  const tabs = el('div', 'chips');
  const body = el('div');
  const views = {
    imports: () => {
      body.replaceChildren();
      body.append(el('div', 'hint', usageComplete
        ? `借りている関数 ${imports.length} 個。呼ばれている回数の多い順です。`
        : `借りている関数 ${imports.length} 個。呼び出し回数は解析中です。`));
      for (const g of groups) {
        body.append(disclosure(g.name + '（' + g.items.length + '）', {
          build: (into) => {
            const l = list();
            for (const i of g.items.slice(0, 200)) {
              l.append(tapRow(i.readable || i.name, {
                sub: addrHex(i.addr) + (usageComplete && i.calls ? '  ·  ' + i.calls + ' 回呼ばれています' : '') +
                  (i.readable !== i.name ? '\n' + i.name : ''),
                onTap: () => { sheet.close(); app.goToAddress(i.addr, { announce: true }); },
              }));
            }
            into.append(l);
          },
        }));
      }
      body.append(noteBox('どの framework のものかは、名前からの推測です（バイナリには対応表が残っていません）。'));
    },
    exports: () => {
      body.replaceChildren();
      const ex = exportList(app.symbols);
      body.append(el('div', 'hint',
        '外へ公開している名前 ' + ex.length + ' 個。\n' +
        'アプリ本体では少なめですが、.framework を開いたときは「使える API の一覧」になります。'));
      const l = list();
      for (const e of ex.slice(0, 400)) {
        l.append(tapRow(e.readable, {
          sub: addrHex(e.addr) + (e.readable !== e.name ? '\n' + e.name : ''),
          onTap: () => { sheet.close(); app.openFunctionReport(e.addr); },
        }));
      }
      body.append(l);
    },
    dylibs: () => {
      body.replaceChildren();
      body.append(el('div', 'hint',
        '起動時に読み込むライブラリの一覧（LC_LOAD_DYLIB）。これは推測ではなく、\n' +
        'ファイルにそのまま書いてある事実です。'));
      const l = list();
      for (const d of dylibs) {
        const short = d.split('/').pop();
        l.append(tapRow(short, { sub:d, onTap:() => copyText(d, 'パス') }));
      }
      if (!dylibs.length) l.append(tapRow('ありません', { disabled:true }));
      body.append(l);
    },
  };

  let current = 'imports';
  for (const [key, label] of [['imports', '借りている関数'], ['exports', '公開している名前'], ['dylibs', 'ライブラリ']]) {
    tabs.append(button(label, 'chip' + (key === current ? ' on' : ''), (e) => {
      current = key;
      for (const c of tabs.children) c.classList.remove('on');
      e.currentTarget.classList.add('on');
      views[key]();
    }));
  }
  sheet.body.append(tabs, body);
  views.imports();

  // Import/dylib facts are available immediately. ProgramIndex only enriches
  // call counts; closing the sheet detaches this consumer from late publish.
  Promise.resolve().then(() => app.ensureProgram?.()).then((program) => {
    if (controller.signal.aborted || !isAppEpochCurrent(app, snap, sheet) || !program) return;
    imports = importList(app.symbols, program);
    groups = importsByFramework(imports);
    usageComplete = true;
    if (current === 'imports') views.imports();
  }).catch(() => { /* base linkage facts remain valid */ });
}

/* ══════════════════════════════════════════════════════════
   グローバル変数
   ══════════════════════════════════════════════════════════ */

export async function showGlobals(app) {
  const snap = captureAppEpoch(app);
  const sheet = new Sheet(pick('グローバル変数', 'Global Variables'));
  const status = el('div', 'hint', pick('参照関係を調べています…', 'Scanning references…'));
  sheet.body.append(status);
  await app.ensureProgram().catch(() => null);
  if (!isAppEpochCurrent(app, snap, sheet)) return;

  const globals = findGlobals(app.symbols, app.program, app.store.get('regions') || [], { limit: 400 });
  status.remove();
  sheet.body.append(el('div', 'hint',
    'どこからでも触れる置き場です。所持金・ログイン状態・設定などは、\n' +
    'たいていここに置かれています。よく参照されているものほど上に出ます。'));

  if (!globals.length) {
    sheet.body.append(noteBox('見つかりませんでした（データのセクションが無いか、参照が拾えていません）。'));
    return;
  }

  const l = list();
  for (const g of globals.slice(0, 300)) {
    l.append(tapRow(g.readable, {
      sub: addrHex(g.addr) + '  ·  ' + g.region + '  ·  ' + g.refs + ' か所から参照' +
        (g.named ? '' : '\n（名前は残っていません。参照の多さから見つけました）'),
      onTap: () => { sheet.close(); app.goToAddress(g.addr, { announce: true }); },
    }));
  }
  sheet.body.append(l);
}

/* ══════════════════════════════════════════════════════════
   名前とメモ
   ══════════════════════════════════════════════════════════ */

function notePersistenceFailure(app, action = pick('変更', 'Changes')) {
  const code = app.notes?.lastSaveError?.code || 'STORAGE_ERROR';
  alertDialog(
    pick('保存できませんでした', 'Could not save'),
    pick(
      `${action}はこの画面には残っていますが、端末へ保存できていません（${code}）。\n` +
      '「自分で付けた名前とメモ」を開くと保存の再試行と書き出しができます。ページを閉じる前にバックアップしてください。',
      `${action} remain active in this view, but could not be saved locally (${code}).\n` +
      'Open "Saved names & notes" to retry saving or export a backup before closing the page.',
    ),
  );
}

export function showRename(app, addr) {
  const sheet = new Sheet(pick('名前を付ける', 'Rename'));
  const cur = app.symbols.nameAt(addr);
  let initialName = app.notes.nameOf(addr) || '';
  let initialComment = app.notes.comment(addr) || '';
  sheet.body.append(el('div', 'hint',
    addrHex(addr) + '\n' +
    pick(
      '分かったことに、その場で名前を付けておきます。\n命令一覧・関数一覧・呼び出し元まで、いっぺんに新しい名前になります。',
      'Assign a custom name here. It updates disassembly, functions, and cross-references immediately.',
    )));
  if (cur) sheet.body.append(kvRow(pick('いまの名前', 'Current name'), readableName(cur)));

  const nameIn = input(pick('例: ダメージ計算', 'e.g. calc_damage'), initialName);
  sheet.body.append(field(nameIn, pick('決定', 'Save'), apply));
  nameIn.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') apply();
  });
  setTimeout(() => { nameIn.focus(); nameIn.select?.(); }, 50);

  const memo = textArea(initialComment, 4);
  sheet.body.append(heading(pick('メモ（覚えておきたいこと）', 'Comment')), memo);
  sheet.body.append(field(el('span'), pick('メモを保存', 'Save comment'), () => {
    const nextComment = memo.value.trim();
    if (!app.notes.setComment(addr, memo.value)) { notePersistenceFailure(app, pick('メモ', 'Comment')); return; }
    if (nextComment !== initialComment) {
      app.recordUndo?.({ type: 'comment', addr, before: initialComment, after: nextComment });
      initialComment = nextComment;
    }
    toast(nextComment ? pick('メモを保存しました', 'Comment saved') : pick('メモを削除しました', 'Comment deleted'));
  }));

  if (initialName) {
    sheet.body.append(button(pick('付けた名前を消す', 'Remove custom name'), 'tb-btn danger', () => {
      const saved = app.notes.setName(addr, '');
      app.symbols.rename(addr, '');
      app.viewer.setSymbols(app.symbols);
      app.updateChrome?.();
      if (initialName) {
        app.recordUndo?.({ type: 'name', addr, before: initialName, after: '' });
        initialName = '';
      }
      if (!saved) { notePersistenceFailure(app, pick('名前の削除', 'Name removal')); return; }
      sheet.close();
      toast(pick('元の名前に戻しました', 'Restored original name'));
    }));
  }

  function apply() {
    const v = nameIn.value.trim();
    const savedName = app.notes.setName(addr, v);
    app.symbols.rename(addr, v);
    app.viewer.setSymbols(app.symbols);
    const nextComment = memo.value.trim();
    let savedComment = true;
    if (nextComment !== initialComment) {
      savedComment = app.notes.setComment(addr, memo.value);
      app.recordUndo?.({ type: 'comment', addr, before: initialComment, after: nextComment });
      initialComment = nextComment;
    }
    app.updateChrome?.();
    if (v !== initialName) {
      app.recordUndo?.({ type: 'name', addr, before: initialName, after: v });
      initialName = v;
    }
    if (!savedName) { notePersistenceFailure(app, pick('名前', 'Name')); return; }
    if (!savedComment) { notePersistenceFailure(app, pick('メモ', 'Comment')); return; }
    sheet.close();
    toast(v ? pick('「' + v + '」にしました', `Renamed to "${v}"`) : pick('元の名前に戻しました', 'Restored original name'));
  }
}

export function showComment(app, addr) {
  const sheet = new Sheet(pick('メモ', 'Comment'));
  const before = app.notes.comment(addr) || '';
  sheet.body.append(el('div', 'hint', addrHex(addr) + '\n' + pick('この行についてのメモを残します。', 'Attach a note to this address.')));
  const memo = textArea(before, 5);
  const save = () => {
    const after = memo.value.trim();
    if (!app.notes.setComment(addr, memo.value)) { notePersistenceFailure(app, pick('メモ', 'Comment')); return; }
    if (after !== before) {
      app.recordUndo?.({ type: 'comment', addr, before, after });
    }
    sheet.close();
    toast(after ? pick('保存しました', 'Comment saved') : pick('メモを削除しました', 'Comment deleted'));
  };
  memo.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });
  sheet.body.append(memo);
  const actions = field(el('span'), pick('保存', 'Save'), save);
  if (before) {
    actions.append(button(pick('削除', 'Delete'), 'chip danger', () => {
      if (!app.notes.setComment(addr, '')) { notePersistenceFailure(app, pick('メモ', 'Comment')); return; }
      app.recordUndo?.({ type: 'comment', addr, before, after: '' });
      sheet.close();
      toast(pick('メモを削除しました', 'Comment deleted'));
    }));
  }
  sheet.body.append(actions);
  setTimeout(() => { memo.focus(); memo.select?.(); }, 50);
}

export function showNotes(app) {
  const sheet = new Sheet(pick('自分で付けた名前とメモ', 'Saved names & notes'));
  const render = () => {
    body.replaceChildren();
    if (app.notes.dirty) {
      const warning = noteBox(pick(
        'まだ端末へ保存できていない変更があります。ページを閉じる前に再試行するか、下の「書き出す」でバックアップしてください。',
        'Some changes have not been saved locally yet. Retry saving or export a backup before closing the page.',
      ), 'warn');
      const retry = el('div', 'chips');
      retry.append(button(pick('保存を再試行', 'Retry save'), 'chip', () => {
        if (app.notes.save()) { toast(pick('保存しました', 'Saved')); render(); }
        else notePersistenceFailure(app, pick('変更', 'Changes'));
      }));
      warning.append(retry);
      body.append(warning);
    }
    const names = app.notes.nameEntries();
    const comments = [];
    if (app.notes?.comments instanceof Map) {
      for (const [k, v] of app.notes.comments) {
        if (!v) continue;
        try { comments.push({ addr: BigInt(k), text: v }); } catch { /* skip */ }
      }
    }
    body.append(el('div', 'hint', pick(
      '名前 ' + names.length + ' 個、メモ ' + app.notes.commentCount() + ' 個。\n' +
      'この端末のブラウザに保存されています（どこにも送信されません）。',
      `${names.length} names, ${app.notes.commentCount()} comments.\n` +
      'Stored locally in this browser (never uploaded).',
    )));

    const l = list();
    l.append(groupRow(pick('名前', 'Names')));
    if (!names.length) l.append(tapRow(pick('まだありません', 'None yet'), { disabled: true }));
    for (const n of names.slice(0, 300)) {
      l.append(tapRow(n.name, {
        sub: addrHex(n.addr),
        onTap: () => { sheet.close(); app.goToAddress(n.addr, { announce: true }); },
      }));
    }
    body.append(l);

    const cl = list();
    cl.append(groupRow(pick('メモ', 'Comments')));
    if (!comments.length) cl.append(tapRow(pick('まだありません', 'None yet'), { disabled: true }));
    for (const c of comments.slice(0, 300)) {
      const row = tapRow(c.text, {
        sub: addrHex(c.addr),
        onTap: () => { sheet.close(); app.goToAddress(c.addr, { announce: true }); },
      });
      const del = button(pick('削除', 'Delete'), 'chip danger', (e) => {
        e.stopPropagation();
        const prev = app.notes.comment(c.addr) || '';
        if (!app.notes.setComment(c.addr, '')) { notePersistenceFailure(app, pick('メモ', 'Comment')); return; }
        app.recordUndo?.({ type: 'comment', addr: c.addr, before: prev, after: '' });
        render();
        toast(pick('メモを削除しました', 'Comment deleted'));
      });
      del.addEventListener('keydown', (e) => e.stopPropagation());
      row.append(del);
      cl.append(row);
    }
    body.append(cl);

    const chips = el('div', 'chips');
    chips.append(button(pick('書き出す（バックアップ）', 'Export (backup)'), 'chip', () => {
      copyText(app.notes.toJSON(), pick('メモ', 'Notes'));
    }));
    chips.append(button(pick('読み込む', 'Import'), 'chip', () => {
      const sh = new Sheet(pick('読み込む', 'Import notes'));
      sh.body.append(para(pick('書き出した内容を貼り付けてください。いまの内容と合わさります。', 'Paste exported JSON. Entries will be merged with your current notes.')));
      const ta = textArea('', 8);
      sh.body.append(ta, field(el('span'), pick('取り込む', 'Import'), () => {
        try {
          const n = app.notes.fromJSON(ta.value);
          for (const e of app.notes.nameEntries()) app.symbols.rename(e.addr, e.name);
          app.viewer.setSymbols(app.symbols);
          app.updateChrome?.();
          sh.close();
          render();
          if (!app.notes.lastMutationSaved) { notePersistenceFailure(app, pick('取り込み', 'Import')); return; }
          toast(pick(n + ' 件を取り込みました', `Imported ${n} items`));
        } catch (err) { alertDialog(pick('読み込めません', 'Import failed'), userError(err, pick('メモの形式を確認してください。', 'Check the JSON format.'))); }
      }));
    }));
    chips.append(button(pick('全部消す', 'Clear all'), 'chip danger', () => {
      alertDialog(
        pick('全部消しますか', 'Clear all notes?'),
        pick('このファイルに付けた名前とメモを消します。元に戻せません。', 'Delete all custom names and comments for this file? This cannot be undone.'),
        {
          confirmLabel: pick('消す', 'Clear'),
          onConfirm: () => {
            for (const e of app.notes.nameEntries()) app.symbols.rename(e.addr, '');
            const saved = app.notes.clear();
            app.clearUndoHistory?.();
            app.viewer.setSymbols(app.symbols);
            app.updateChrome?.();
            render();
            if (!saved) { notePersistenceFailure(app, pick('全消去', 'Clear all')); return; }
            toast(pick('消しました', 'Cleared'));
          },
        },
      );
    }));
    body.append(chips);
  };
  const body = el('div');
  sheet.body.append(body);
  render();
}

/* ══════════════════════════════════════════════════════════
   パッチ
   ══════════════════════════════════════════════════════════ */

function instructionPatchCapability(app) {
  const architecture = String(app?.store?.get?.('architecture') || '').toLowerCase();
  const supported = instructionPatchArchitectureSupported(architecture);
  return {
    architecture, supported,
    reason: supported ? null : pick(
      `このCPU（${architecture || '不明'}）の命令パッチはまだ未対応です。`,
      `Instruction patching is not yet supported for this CPU (${architecture || 'unknown'}).`,
    ),
  };
}

function patchRegionForAddress(app, addr) {
  const hasOwnerResolver = typeof app?.executableRegionFor === 'function' || typeof app?.regionForAddress === 'function';
  const owner = app?.executableRegionFor?.(addr) ?? app?.regionForAddress?.(addr) ?? null;
  if (owner) return owner.exec === false ? null : owner;
  return hasOwnerResolver ? null : app?.codeRegion?.() ?? null;
}

export function showPatches(app, targetAddr = null) {
  const sheet = new Sheet(pick('パッチ', 'Patches'));
  sheet.body.append(el('div', 'hint', pick(
    '命令を書き換えて「こうしたらどうなるか」を試す道具です。\n' +
    '元のファイルには書き込みません。保存を選んだときだけ、新しいファイルを作ります。',
    'Rewrite instructions to test what-if changes.\n' +
    'The original file is never modified; a new file is created only when you export.'
  )));
  sheet.body.append(noteBox(pick(
    'iOS の実行ファイルは署名されています。書き換えたものをそのまま実機で動かすことはできません。\n' +
    '（このツールは解析と実験のためのものです。）',
    'iOS executables are code-signed; modified binaries cannot run directly on stock devices.\n' +
    '(This tool is intended for analysis and experimentation.)'
  )));

  const render = () => {
    body.replaceChildren();
    const items = app.patches.list();
    const l = list();
    l.append(groupRow(pick('書き換えの一覧（' + items.length + '）', 'Staged patches (' + items.length + ')')));
    if (!items.length) l.append(tapRow(pick('まだありません', 'None yet'), { disabled: true, sub: pick('命令を長押しして「書き換える」から作れます。', 'Long-press an instruction and choose Patch to add one.') }));
    for (const it of items) {
      const row = tapRow((it.addr != null ? addrHex(it.addr) : '+' + it.offset) + '  ' + (it.text || ''), {
        sub: hexOf(it.before) + '  →  ' + hexOf(it.after),
        onTap: () => {
          const rect = row.getBoundingClientRect?.();
          const mx = rect ? Math.round(rect.left + rect.width / 2) : window.innerWidth / 2;
          const my = rect ? Math.round(rect.bottom + 4) : 200;
          menu([
            { label: pick('この場所へ移動', 'Jump to location'), action: () => { sheet.close(); if (it.addr != null) app.goToAddress(it.addr, { announce: true }); } },
            { label: pick('この書き換えを取り消す', 'Undo this patch'), action: () => { app.patches.remove(it.offset); app.recordUndo?.({ type: 'patch', action: 'remove', offset: it.offset, before: it, after: null, meta: { addr: it.addr, text: it.text } }); app.store?.set?.({ patches: app.patches.size }); render(); toast(pick('取り消しました', 'Undone')); } },
          ], mx, my);
        },
      });
      l.append(row);
    }
    body.append(l);

    const chips = el('div', 'chips');
    const capability = instructionPatchCapability(app);
    if (capability.supported === true) {
      if (targetAddr != null) {
        chips.append(button(pick(`この関数を書き換える (${addrHex(targetAddr)})`, `Patch this function (${addrHex(targetAddr)})`), 'chip strong', async () => {
          const insn = await instructionAt(app, targetAddr);
          showPatchEditor(app, targetAddr, insn, { onChange: render });
        }));
      }
      chips.append(button(pick('アドレスを指定して書き換える', 'Patch by address'), 'chip', () => {
        const sh = new Sheet(pick('場所を指定', 'Choose address'));
        const a = input('0x100004000', targetAddr != null ? addrHex(targetAddr) : undefined);
        const goAddr = async () => {
          let addr;
          const raw = a.value.trim();
          if (!raw) { toast(pick('アドレスの形が違います', 'Invalid address format')); return; }
          try { addr = BigInt(raw); } catch { toast(pick('アドレスの形が違います', 'Invalid address format')); return; }
          sh.close();
          const insn = await instructionAt(app, addr);
          showPatchEditor(app, addr, insn, { onChange: render });
        };
        a.addEventListener('keydown', (e) => {
          if (e.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') { e.preventDefault(); goAddr(); }
        });
        sh.body.append(para(pick('書き換えたい命令のアドレスを入れてください。', 'Enter the address of the instruction to patch.')), field(a, pick('進む', 'Next'), goAddr));
        setTimeout(() => { a.focus(); a.select?.(); }, 50);
      }));
    } else {
      body.append(noteBox(capability.reason));
    }
    if (items.length) {
      chips.append(button(pick('書き換えたファイルを保存', 'Export patched file'), 'chip strong', () => savePatched(app)));
      chips.append(button(pick('全部取り消す', 'Clear all'), 'chip danger', () => {
        alertDialog(
          pick('すべてのパッチを取り消しますか？', 'Clear all patches?'),
          pick(`${items.length} 件の書き換えをすべて取り消します。元に戻せません。`, `Remove all ${items.length} staged patches? This cannot be undone.`),
          {
            confirmLabel: pick('全部取り消す', 'Clear all'),
            onConfirm: () => {
              app.patches.clear();
              app.clearUndoHistory?.();
              app.store?.set?.({ patches: app.patches.size });
              render();
              toast(pick('すべてのパッチを取り消しました', 'All patches cleared'));
            },
          },
        );
      }));
    }
    body.append(chips);
  };
  const body = el('div');
  sheet.body.append(body);
  render();
}

async function instructionAt(app, addr) {
  if (!instructionPatchCapability(app).supported) return null;
  const region = patchRegionForAddress(app, addr);
  if (!region) return null;
  const file = app.store.get('file');
  if (validatePatchRange(region, addr, 4, file && file.size, true).error) return null;
  const row = app.viewer?.rowOfAddress ? app.viewer.rowOfAddress(addr) : null;
  if (row == null) {
    // Variable-length ISA: ask the architecture backend for an instruction at
    // this exact address rather than manufacturing a 4-byte row.
    const decoded = await app.backend.disassembleAt(addr, { length: 32 });
    const hit = decoded?.instructions?.find((i) => i.address === addr || BigInt(i.address ?? -1) === addr);
    return hit ? { mnemonic: hit.mnemonic || hit.mn || '', operands: hit.operands || hit.opStr || '', address: addr } : null;
  }
  const chunk = Math.floor(row / 1024);
  try {
    const e = await app.backend.fetchChunk(region.id, chunk, true);
    const k = row - chunk * 1024;
    return { mnemonic: e.mn ? e.mn[k] : '', operands: e.ops ? e.ops[k] : '', address: addr };
  } catch { return null; }
}

export async function showPatchEditor(app, addr, insnArg, options = {}) {
  const snap = captureAppEpoch(app);
  const onChange = typeof options?.onChange === 'function' ? options.onChange : null;
  const sheet = new Sheet(pick('命令を書き換える', 'Patch instruction'));
  const capability = instructionPatchCapability(app);
  if (capability.supported !== true) {
    sheet.body.append(noteBox(capability.reason));
    return;
  }
  const insn = insnArg || await instructionAt(app, addr);
  if (!isAppEpochCurrent(app, snap, sheet)) return;
  const region = patchRegionForAddress(app, addr);
  if (!region) { sheet.body.append(noteBox(pick('コードのセクションが見つかりません。', 'Code section not found.'))); return; }
  const file = app.store.get('file');
  const range = validatePatchRange(region, addr, 4, file && file.size, true);
  if (range.error) { sheet.body.append(noteBox(range.error)); return; }
  const fileOffset = range.fileOffset;

  sheet.body.append(el('div', 'hint', addrHex(addr) + pick('  ·  ファイルの中では +0x', '  ·  file +0x') + fileOffset.toString(16)));
  if (insn) {
    const b = block(pick('いまの命令', 'Current instruction'));
    b.append(el('div', 'bigval mono', (insn.mnemonic + ' ' + insn.operands).trim()));
    try {
      b.append(el('div', 'hint', brief(insn.mnemonic, insn.operands, lang(), { address: addr })));
    } catch { /* 説明が作れなくても続ける */ }
    sheet.body.append(b);
  }

  const activePatch = app.patches?.at?.(fileOffset)
    || app.patches?.byAddress?.(addr)
    || (app.patches?.list?.() || []).find((it) => fileOffset >= it.offset && fileOffset < it.offset + BigInt(it.after.length))
    || null;
  if (activePatch) {
    const activeBlock = block(pick('適用中のパッチ', 'Active patch'));
    activeBlock.append(el('div', 'bigval mono', activePatch.text || hexOf(activePatch.after)));
    activeBlock.append(el('div', 'hint mono', hexOf(activePatch.before) + '  →  ' + hexOf(activePatch.after)));
    const undoBar = el('div', 'chips');
    undoBar.append(button(pick('元に戻す (Undo)', 'Undo patch'), 'chip danger', () => {
      app.patches.remove(activePatch.offset);
      app.recordUndo?.({ type: 'patch', action: 'remove', offset: activePatch.offset, before: activePatch, after: null, meta: { addr: activePatch.addr, text: activePatch.text } });
      app.store?.set?.({ patches: app.patches.size });
      onChange?.();
      sheet.close();
      toast(pick('パッチを元に戻しました', 'Patch undone'));
    }));
    activeBlock.append(undoBar);
    sheet.body.append(activeBlock);
  }

  const regionRem = Number(region.size - (addr - region.vmAddr));
  const fileRem = file && Number.isFinite(Number(file.size)) ? Number(BigInt(file.size) - fileOffset) : regionRem;
  const fnRange = app.symbols?.functionAt?.(addr);
  const fnRem = fnRange && fnRange.end != null && BigInt(fnRange.end) > addr ? Number(BigInt(fnRange.end) - addr) : regionRem;
  const availableBytes = Math.max(0, Math.min(regionRem, fileRem, fnRem));

  const atFunctionStart = !fnRange || fnRange.start == null || BigInt(fnRange.start) === BigInt(addr);
  const arch = app.store?.get?.('fileInfo')?.arch || '';
  const suggestions = suggestPatches(insn ? insn.mnemonic : '', insn ? insn.operands : '', addr, { availableBytes, atFunctionStart, arch });
  const l = list();
  l.append(groupRow(pick('よく使う書き換え', 'Common patches')));
  for (const s of suggestions) {
    l.append(tapRow(s.label, { sub: s.why + '\n→ ' + s.text, onTap: () => (s.hex ? applyRawHex(s.text) : apply(s.text)) }));
  }
  sheet.body.append(l);

  sheet.body.append(heading(pick('自分で書く', 'Custom patch')));
  const asm = input(pick('例: mov w0, #1 または mov w0, #1; ret', 'e.g. mov w0, #1 or mov w0, #1; ret'));
  asm.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); apply(asm.value); }
  });
  sheet.body.append(field(asm, pick('書き換える', 'Patch'), () => apply(asm.value)));
  sheet.body.append(el('div', 'hint', pick(
    '使えるのは nop / ret / brk / mov / movz / movn / b / bl / b.条件 / cbz / cbnz / tbz / tbnz です（; 区切りで複数命令も可）。\n' +
    'それ以外は 16 進で直接どうぞ（例: 1F 20 03 D5）。',
    'Supports nop / ret / brk / mov / movz / movn / b / bl / b.<cond> / cbz / cbnz / tbz / tbnz (separate multiple instructions with ;).\n' +
    'For other instructions, enter raw hex bytes below (e.g. 1F 20 03 D5).',
  )));

  const hex = input('1F 20 03 D5');
  const applyHex = () => {
    const bytes = parseHexBytes(hex.value);
    if (!bytes || bytes.length < 4 || bytes.length % 4 !== 0) {
      toast(pick('4 バイト単位（8 桁の倍数）で指定してください', 'Specify a multiple of 4 bytes (8 hex digits).'));
      return;
    }
    commit(bytes, hex.value);
  };
  hex.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); applyHex(); }
  });
  sheet.body.append(field(hex, pick('16 進で書き換える', 'Patch hex'), applyHex));

  function applyRawHex(text) {
    const bytes = parseHexBytes(text);
    if (!bytes || !bytes.length) { toast(pick('16進バイトの形式が不正です', 'Invalid hex bytes')); return; }
    commit(bytes, text, { rawHex: true });
  }

  async function apply(text) {
    const built = assemble(text, addr);
    if (built.error) { alertDialog(pick('組み立てられません', 'Assembly error'), built.error); return; }
    commit(built.bytes, text);
  }

  async function commit(bytes, text, { rawHex = false } = {}) {
    const valid = rawHex
      ? validatePatchRange(region, addr, bytes.length, file && file.size, false)
      : (bytes.length === 4
        ? validatePatchRange(region, addr, bytes.length, file && file.size, true)
        : validateMultiInstructionPatchRange(region, addr, bytes.length, file && file.size));
    if (valid.error) { alertDialog(pick('登録できません', 'Cannot stage patch'), valid.error); return; }
    const before = await app.backend.readAt(addr, bytes.length)
      .then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
    if (!isAppEpochCurrent(app, snap, sheet)) return;
    if (!before || before.length !== bytes.length) {
      alertDialog(pick('登録できません', 'Cannot stage patch'), pick('元のバイトを読み取れませんでした。', 'Could not read original bytes.'));
      return;
    }
    const prevPatch = app.patches?.at?.(valid.fileOffset) || null;
    try {
      app.patches.add(valid.fileOffset, before, bytes, { addr, text });
      app.recordUndo?.({ type: 'patch', action: 'add', offset: valid.fileOffset, before, after: bytes, prevPatch, meta: { addr, text } });
      app.store?.set?.({ patches: app.patches.size });
    } catch (err) {
      alertDialog(pick('登録できません', 'Cannot stage patch'), userError(err, pick('既存のパッチと重なっています。先のパッチを元に戻してからお試しください。', 'Overlaps an existing patch. Undo the previous patch first.')));
      return;
    }
    onChange?.();
    sheet.close();
    toast(pick('書き換えを登録しました（エミュレータでそのまま試せます）', 'Patch staged (ready to test in the emulator)'));
  }
}

async function savePatched(app) {
  const file = app.store.get('file');
  if (!file) { toast('ファイルが開かれていません'); return; }
  toast('書き出しています…');
  try {
    const blob = await app.patches.apply(file);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (file.name || 'patched') + '.patched';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('保存しました');
  } catch (err) {
    alertDialog('保存できません', userError(err, 'ブラウザの保存設定を確認して、もう一度お試しください。'));
  }
}

/* ══════════════════════════════════════════════════════════
   実行してみる（デバッガ）
   ══════════════════════════════════════════════════════════ */

export function showDebugger(app, addr) {
  const arch = String(app?.store?.get?.('fileInfo')?.arch || '').toLowerCase();
  if (arch && !instructionPatchArchitectureSupported(arch)) {
    toast(pick(`エミュレータは現在 ARM64 のみ対応しています（現在: ${arch}）。`, `Emulator currently supports ARM64 only (current: ${arch}).`));
    return null;
  }
  let activeRun = null;
  const abortRun = (reason = 'debugger-operation-replaced') => {
    if (activeRun && !activeRun.signal.aborted) activeRun.abort(reason);
    activeRun = null;
  };
  const sheet = new Sheet(pick('実行してみる', 'Emulate / Debugger'), { onClose:() => abortRun('debugger-sheet-closed') });
  const stagedPatchCount = () => (app?.patches?.size || 0);
  let applyPatches = stagedPatchCount() > 0;
  let emu = makeEmulator(app, { applyPatches });
  let args = [0n, 0n, 0n, 0n];
  let lastArgsKey = '';
  let focusedArgIndex = 0;

  sheet.body.append(el('div', 'hint',
    fnName(app, addr) + '\n' +
    pick(
      'この関数を、ブラウザの中で 1 命令ずつ動かします。実機のアプリは起動しません。\n危ないことは何も起きないので、安心して何度でも試せます。',
      'Step through this function in the browser emulator without running the real app.\nNothing runs on a real device, so you can experiment safely.',
    )));
  sheet.body.append(noteBox(pick(
    'iOS のライブラリ（UIKit など）の中身はこのファイルに入っていないので、\nそこへ出たら「戻り値 0 で帰ってきた」ことにして先へ進みます。\n何をそう扱ったかは、下の「メモ」に出ます。',
    'External system libraries (such as UIKit) are not inside this binary, so calls to them return 0 and continue.\nStubbed calls are recorded in Notes below.',
  )));

  /* 引数 */
  const argWrap = el('div', 'field wrap');
  const argInputs = [];
  for (let i = 0; i < 4; i++) {
    const n = input('x' + i, '0');
    n.style.maxWidth = '120px';
    n.addEventListener('focus', () => { focusedArgIndex = i; });
    argInputs.push(n);
    argWrap.append(n);
  }
  const argPresetBar = el('div', 'chips');
  argPresetBar.append(button(pick('ダミー領域を引数にセット', 'Set dummy buffer as arg'), 'chip', () => {
    const targetIdx = focusedArgIndex >= 0 && focusedArgIndex < argInputs.length ? focusedArgIndex : 0;
    const dummyAddr = '0x' + emu.heapBase.toString(16);
    argInputs[targetIdx].value = dummyAddr;
    start();
    toast(pick(`x${targetIdx} にダミー領域（${dummyAddr}）をセットしました`, `Set x${targetIdx} to dummy buffer (${dummyAddr})`));
  }));
  sheet.body.append(heading(pick('引数（x0〜x3）', 'Arguments (x0–x3)')), argWrap, argPresetBar);

  if (stagedPatchCount() > 0) {
    const patchToggleWrap = el('label', 'chip');
    patchToggleWrap.style.display = 'inline-flex';
    patchToggleWrap.style.alignItems = 'center';
    patchToggleWrap.style.gap = '6px';
    patchToggleWrap.style.cursor = 'pointer';
    const patchCheckbox = el('input');
    patchCheckbox.type = 'checkbox';
    patchCheckbox.checked = applyPatches;
    const patchLabelText = el('span', '', pick(`パッチ適用状態で試す（${stagedPatchCount()} 件）`, `Run with staged patches (${stagedPatchCount()})`));
    patchToggleWrap.append(patchCheckbox, patchLabelText);
    patchCheckbox.addEventListener('change', () => {
      applyPatches = !!patchCheckbox.checked;
      const keep = new Set(emu.breakpoints);
      emu = makeEmulator(app, { applyPatches });
      emu.breakpoints = keep;
      start();
      toast(applyPatches
        ? pick('パッチ適用状態で実行します', 'Running with staged patches enabled')
        : pick('元の状態（パッチ無効）で実行します', 'Running original bytes (patches disabled)'));
    });
    const patchBar = el('div', 'chips');
    patchBar.append(patchToggleWrap);
    sheet.body.append(patchBar);
  }

  const chips = el('div', 'chips');
  const status = el('div', 'hint', pick('まだ動かしていません。', 'Not started yet.'));
  const regTable = el('div', 'regs mono');
  const traceBox = el('div', 'codeview small');
  const logBox = el('div');
  const bpBox = el('div');

  const parseAllArgs = () => {
    const parsed = argInputs.map((n) => parseDebuggerArgument(n.value));
    let invalid = false;
    parsed.forEach((result, i) => {
      const inputNode = argInputs[i];
      inputNode.setAttribute('aria-invalid', String(!result.ok));
      inputNode.classList.toggle('invalid', !result.ok);
      if (!result.ok) invalid = true;
    });
    if (invalid) {
      status.textContent = pick('引数に読み取れない値があります。赤く示した欄を直してください。', 'Some arguments are invalid. Fix the highlighted fields.');
      return null;
    }
    return parsed.map((result) => result.value);
  };

  const start = () => {
    abortRun('debugger-reset');
    const parsedValues = parseAllArgs();
    if (!parsedValues) return false;
    args = parsedValues;
    lastArgsKey = args.map((v) => v.toString()).join(',');
    const keep = new Set(emu.breakpoints);   // 置いた目印は、やり直しても残す
    emu.reset();
    emu.breakpoints = keep;
    emu.setup(addr, args);
    status.textContent = pick('準備しました。「1 命令進む」か「最後まで走らせる」を押してください。', 'Ready. Choose "Step 1" or "Run to end".');
    render();
    return true;
  };

  const ensureReadyForRun = () => {
    const parsedValues = parseAllArgs();
    if (!parsedValues) return false;
    const nextKey = parsedValues.map((v) => v.toString()).join(',');
    if (emu.stopped || nextKey !== lastArgsKey) {
      return start();
    }
    return true;
  };

  chips.append(button(pick('はじめから', 'Reset'), 'chip', start));
  chips.append(button(pick('1 命令進む', 'Step 1'), 'chip', async () => {
    if (!ensureReadyForRun()) return;
    abortRun('debugger-step-replaced');
    const controller = new AbortController();
    activeRun = controller;
    try {
      const r = await emu.step({ signal: controller.signal });
      if (controller.signal.aborted || activeRun !== controller || !sheet.root.isConnected) return;
      status.textContent = r.text ? (pick('実行: ', 'Executed: ') + r.text) : '';
      if (r.reason || emu.stopped) {
        const explained = explainEmulatorFault(r.code || emu.faultCode || emu.stopCode, r.reason || emu.stopped);
        status.textContent = status.textContent ? (status.textContent + '\n' + explained) : explained;
      }
      render();
    } catch (error) {
      if (!controller.signal.aborted && error?.name !== 'AbortError' && sheet.root.isConnected) {
        status.textContent = explainEmulatorFault(error?.code, error?.message || String(error));
      }
    } finally {
      if (activeRun === controller) activeRun = null;
    }
  }));
  chips.append(button(pick('10 命令進む', 'Step 10'), 'chip', async () => {
    if (!ensureReadyForRun()) return;
    abortRun('debugger-step10-replaced');
    const controller = new AbortController();
    activeRun = controller;
    try {
      for (let i = 0; i < 10 && !emu.stopped; i++) {
        if (controller.signal.aborted || activeRun !== controller || !sheet.root.isConnected) return;
        await emu.step({ signal: controller.signal });
      }
      if (controller.signal.aborted || activeRun !== controller || !sheet.root.isConnected) return;
      status.textContent = emu.stopped
        ? explainEmulatorFault(emu.faultCode || emu.stopCode, emu.stopped)
        : pick(emu.steps + ' 命令まで進みました。', 'Stepped to ' + emu.steps + ' instructions.');
      render();
    } catch (error) {
      if (!controller.signal.aborted && error?.name !== 'AbortError' && sheet.root.isConnected) {
        status.textContent = explainEmulatorFault(error?.code, error?.message || String(error));
      }
    } finally {
      if (activeRun === controller) activeRun = null;
    }
  }));
  chips.append(button(pick('最後まで走らせる', 'Run to end'), 'chip strong', async () => {
    if (!ensureReadyForRun()) return;
    abortRun('debugger-run-replaced');
    const controller = new AbortController();
    activeRun = controller;
    status.textContent = pick('走らせています…', 'Running…');
    try {
      await emu.run(50000, (n) => {
        if (!controller.signal.aborted && sheet.root.isConnected) status.textContent = pick(n + ' 命令…', n + ' instructions…');
      }, { signal:controller.signal });
      if (controller.signal.aborted || activeRun !== controller || !sheet.root.isConnected) return;
      const summary = emu.stopped
        ? explainEmulatorFault(emu.faultCode || emu.stopCode, emu.stopped)
        : pick('ブレークポイントで止まりました。', 'Stopped at a breakpoint.');
      status.textContent = summary +
        pick(
          '\n合計 ' + emu.steps + ' 命令、戻り値 x0 = ' + hexBig(emu.x[0]) + '（10 進で ' + emu.x[0].toString() + '）',
          '\nTotal ' + emu.steps + ' instructions, return x0 = ' + hexBig(emu.x[0]) + ' (decimal ' + emu.x[0].toString() + ')',
        );
      render();
    } catch (error) {
      if (!controller.signal.aborted && error?.name !== 'AbortError' && sheet.root.isConnected) {
        status.textContent = explainEmulatorFault(error?.code, error?.message || String(error));
      }
    } finally {
      if (activeRun === controller) activeRun = null;
    }
  }));
  sheet.body.append(chips, status);

  /* ブレークポイント: そこへ来たら止まる目印 */
  const bpInput = input(pick('0x… 止めたい場所', '0x… breakpoint address'), '');
  sheet.body.append(heading(pick('ブレークポイント', 'Breakpoints')), el('div', 'hint',
    pick('そこへ来たら止まる目印です。「最後まで走らせる」で、ここに着いた時点で止まります。',
      'Execution pauses here when using "Run to end".')));
  sheet.body.append(field(bpInput, pick('置く', 'Add'), () => {
    let a;
    const raw = bpInput.value.trim();
    if (!raw) { toast(pick('アドレスの形が違います', 'Invalid address format')); return; }
    try { a = BigInt(raw); } catch { toast(pick('アドレスの形が違います', 'Invalid address format')); return; }
    emu.breakpoints.add(a.toString());
    bpInput.value = '';
    renderBreakpoints();
    toast(pick(addrHex(a) + ' に置きました', 'Added breakpoint at ' + addrHex(a)));
  }));
  sheet.body.append(bpBox);

  function renderBreakpoints() {
    bpBox.replaceChildren();
    const l = list();
    if (!emu.breakpoints.size) l.append(tapRow(pick('まだありません', 'None yet'), { disabled: true }));
    for (const key of emu.breakpoints) {
      const a = BigInt(key);
      l.append(tapRow(addrHex(a), {
        sub: pick('タップすると外します', 'Tap to remove'),
        onTap: () => { emu.breakpoints.delete(key); renderBreakpoints(); },
      }));
    }
    bpBox.append(l);
  }
  renderBreakpoints();

  sheet.body.append(heading(pick('レジスタ', 'Registers')), regTable);
  sheet.body.append(heading(pick('通った道（最後の 40 命令）', 'Trace (last 40 instructions)')), traceBox);
  sheet.body.append(heading(pick('メモ', 'Notes')), logBox);

  const memWrap = el('div');
  sheet.body.append(heading(pick('メモリを覗く', 'Inspect memory')), memWrap);
  const memAddr = input(pick('0x… または x0', '0x… or x0'), '');
  memWrap.append(field(memAddr, pick('見る', 'Inspect'), async () => {
    let a;
    const v = memAddr.value.trim();
    if (/^[xw]\d+$/i.test(v) || /^(sp|wsp|pc|xzr|wzr)$/i.test(v)) {
      try { a = emu.get(v); } catch (err) {
        toast(pick('レジスタ名が正しくありません', 'Invalid register name'));
        memOut.replaceChildren(noteBox(explainEmulatorFault(err?.code, err?.message || String(err))));
        return;
      }
    } else {
      if (!v) { toast(pick('アドレスの形が違います', 'Invalid address format')); return; }
      try { a = BigInt(v); } catch { toast(pick('アドレスの形が違います', 'Invalid address format')); return; }
    }
    try {
      const bytes = await emu.dump(a, 64);
      if (!sheet.root.isConnected) return;
      memOut.replaceChildren(codeBlock(dumpText(a, bytes)));
    } catch (err) {
      if (!sheet.root.isConnected) return;
      memOut.replaceChildren(noteBox(explainEmulatorFault(err?.code, err?.message || String(err))));
    }
  }));
  const memOut = el('div');
  memWrap.append(memOut);

  function render() {
    regTable.replaceChildren();
    const regs = emu.registerList();
    for (const r of regs) {
      if (r.value === 0n && /^x(1[1-9]|2\d|30)$/.test(r.name)) continue;   // 0 のままの退避用は隠す
      const row = el('div', 'reg');
      row.append(el('span', 'reg-name', r.name), el('span', 'reg-val', hexBig(r.value)));
      regTable.append(row);
    }
    const f = el('div', 'reg');
    f.append(el('span', 'reg-name', 'flags'), el('span', 'reg-val', emu.flagText()));
    regTable.append(f);

    traceBox.replaceChildren();
    for (const t of emu.trace.slice(-40)) {
      const row = el('div', 'cl');
      row.append(el('span', 'cl-addr mono', t.addr.toString(16).toUpperCase().slice(-6)),
        el('span', 'cl-text mono', t.text));
      traceBox.append(row);
    }

    logBox.replaceChildren();
    if (!emu.log.length) logBox.append(el('div', 'hint', pick('（まだありません）', '(None yet)')));
    for (const l of emu.log.slice(-20)) {
      logBox.append(el('div', 'hint', '· ' + l.call + ' — ' + l.note));
    }
  }

  start();
}

function hexBig(v) {
  return '0x' + BigInt.asUintN(64, v).toString(16).toUpperCase().padStart(16, '0');
}

function dumpText(addr, bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = Array.from(bytes.slice(i, i + 16));
    const hex = chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push((addr + BigInt(i)).toString(16).toUpperCase().padStart(12, '0') + '  ' + hex.padEnd(48) + '  ' + ascii);
  }
  return lines.join('\n');
}

/* ══════════════════════════════════════════════════════════
   スクリプト
   ══════════════════════════════════════════════════════════ */

export function showScript(app) {
  const sheetController = new AbortController();
  let runController = null;
  const sheet = new Sheet(pick('スクリプト', 'Script'), {
    onClose: () => {
      sheetController.abort('script-sheet-closed');
      runController?.abort('script-sheet-closed');
      runController = null;
    },
  });
  sheet.body.append(el('div', 'hint',
    '同じ作業を何百回も繰り返すときの道具です（IDAPython にあたります）。\n' +
    '言語は JavaScript。hex.〜 で解析結果に触れて、print(…) で下に出します。'));

  const ta = textArea(SAMPLES[0].code, 10);
  sheet.body.append(ta);

  const chips = el('div', 'chips');
  chips.append(button('実行', 'chip strong', run));
  chips.append(button('消す', 'chip', () => { ta.value = ''; }));
  chips.append(button('お手本', 'chip', () => {
    menu(SAMPLES.map((s) => ({
      label: s.title,
      action: () => { ta.value = s.code; toast(s.why); },
    })), window.innerWidth / 2, 160);
  }));
  chips.append(button('使える命令', 'chip', showScriptHelp));
  sheet.body.append(chips);

  const out = el('div', 'codeview small');
  sheet.body.append(heading('結果'), out);

  async function run() {
    if (sheetController.signal.aborted || !sheet.root.isConnected) return;
    runController?.abort('script-run-replaced');
    const localController = new AbortController();
    runController = localController;
    const isCurrent = () => (
      !sheetController.signal.aborted
      && !localController.signal.aborted
      && runController === localController
      && sheet.root.isConnected
    );
    out.replaceChildren();
    const write = (line) => {
      if (!isCurrent()) return;
      const row = el('div', 'cl');
      row.append(el('span', 'cl-text mono', line));
      out.append(row);
      out.scrollTop = out.scrollHeight;
    };
    write(pick('— 実行しています —', '— Running —'));
    try {
      const res = await runScript(ta.value, app, write, { signal: localController.signal });
      if (!isCurrent()) return;
      if (res.error) {
        const row = el('div', 'cl warn');
        row.append(el('span', 'cl-text mono', '⚠ ' + res.error));
        out.append(row);
      } else {
        write(pick('— おわり —', '— Done —'));
      }
    } finally {
      if (runController === localController) runController = null;
    }
  }
}

function showScriptHelp() {
  const sheet = new Sheet('スクリプトで使える命令');
  sheet.body.append(para('よく使うものだけ並べます。すべて hex. から始めます。'));
  const groups = [
    ['調べる', [
      'hex.functions()            関数の一覧',
      'hex.name(addr)             名前を引く',
      'hex.disasm(addr, 20)       逆アセンブル',
      'await hex.decompile(addr)  逆コンパイル',
      'await hex.types(addr)      引数と戻り値の推定',
      'await hex.struct(addr)     構造体の復元',
      'hex.xrefsTo(addr)          呼んでいる場所',
      'hex.xrefsFrom(addr)        呼んでいる相手',
      'hex.mostCalled(20)         よく呼ばれる関数',
    ]],
    ['読む', [
      'await hex.bytes(addr, 16)  生バイト',
      'await hex.string(addr)     文字列として読む',
      'await hex.loadStrings()    文字列を集める',
    'await hex.findStrings("error")   文字列を探す',
    ]],
    ['書く・動かす', [
      'hex.rename(addr, "名前")   名前を付ける',
      'hex.comment(addr, "メモ")  メモを書く',
      'await hex.patch(addr, "nop")  書き換え',
      'await hex.run(addr, [1, 2])   動かしてみる',
      'hex.goto(addr) / hex.open(addr)  画面を動かす',
    ]],
    ['その他', [
      'hex.file()                 開いているファイルの情報',
      'hex.classes()              Objective-C のクラス',
      'hex.hex(v)                 0x… の文字列にする',
      'print(…)                   結果を下に出す',
    ]],
  ];
  for (const [title, lines] of groups) {
    sheet.body.append(heading(title));
    sheet.body.append(codeBlock(lines));
  }
}

/* ══════════════════════════════════════════════════════════
   プラグイン
   ══════════════════════════════════════════════════════════ */

export function showPlugins(app) {
  let runController = null;
  const sheet = new Sheet('プラグイン', {
    onClose: () => runController?.abort('plugin-sheet-closed'),
  });
  sheet.body.append(el('div', 'hint',
    'このツールに無い調べ方は、JavaScript を 1 ファイル書いて足せます。\n' +
    '読み込んだプラグインは、この画面から実行できます。'));
  sheet.body.append(noteBox(
    'プラグインは、あなたが選んだものだけが動きます。中身は必ず自分で確かめてください。\n' +
    '解析中のファイルが外へ送られることはありません（通信の道具は渡していません）。'));

  const render = () => {
    body.replaceChildren();
    const l = list();
    l.append(groupRow('入っているプラグイン（' + app.plugins.plugins.length + '）'));
    if (!app.plugins.plugins.length) l.append(tapRow('まだありません', { disabled: true }));
    for (const p of app.plugins.plugins) {
      l.append(tapRow(p.name, {
        sub: (p.description || '') + '\n出どころ: ' + p.origin,
        onTap: () => {
          menu([
            { label: '実行する', action: () => runPlugin(p) },
            { label: '中身を見る', action: () => { const s = new Sheet(p.name); s.body.append(codeBlock(p.source)); } },
            { label: '外す', action: () => { app.plugins.remove(p.id); render(); toast('外しました'); } },
          ], window.innerWidth / 2, 200);
        },
      }));
    }
    body.append(l);

    const chips = el('div', 'chips');
    chips.append(button('ファイルから読み込む', 'chip', () => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.js,text/javascript';
      picker.addEventListener('change', async () => {
        const f = picker.files && picker.files[0];
        if (!f) return;
        if (f.size > MAX_PLUGIN_SOURCE_BYTES) {
          toast('プラグインが大きすぎます（512 KB まで）。');
          return;
        }
        const text = await f.text();
        confirmInstall(text, f.name);
      });
      picker.click();
    }));
    chips.append(button('URL から読み込む', 'chip', () => {
      const sh = new Sheet('URL から読み込む');
      const u = input('https://…');
      sh.body.append(para('プラグインの JavaScript ファイルの URL を入れてください。'), field(u, '取り寄せる', async () => {
        sh.close();
        toast('取り寄せています…');
        const res = await app.plugins.installFromUrl(u.value.trim());
        if (res.error) alertDialog('読み込めません', res.error);
        else confirmInstall(res.source, res.origin);
      }));
    }));
    chips.append(button('お手本を見る', 'chip', () => {
      const s = new Sheet('プラグインの書き方');
      s.body.append(para('この形で書いて、.js として保存し、上の「ファイルから読み込む」で入れてください。'));
      s.body.append(codeBlock(EXAMPLE_PLUGIN));
      s.body.append(button('このお手本を入れる', 'tb-btn strong', async () => {
        const res = await app.plugins.install(EXAMPLE_PLUGIN, 'お手本');
        s.close();
        if (res.error) alertDialog('入れられません', res.error);
        else { render(); toast('入れました'); }
      }));
    }));
    body.append(chips);
  };

  function confirmInstall(text, origin) {
    const s = new Sheet('中身を確かめる');
    s.body.append(para('入れる前に、中身を確かめてください。'));
    s.body.append(para('全 ' + text.length.toLocaleString() + ' 文字です。以下が全文です。'));
    s.body.append(codeBlock(text));
    s.body.append(button('全文を確認して入れる', 'tb-btn strong', async () => {
      const res = await app.plugins.install(text, origin);
      s.close();
      if (res.error) alertDialog('入れられません', res.error);
      else { render(); toast(res.added.length + ' 個入りました'); }
    }));
  }

  function runPlugin(p) {
    runController?.abort('plugin-run-replaced');
    const controller = runController = new AbortController();
    const s = new Sheet(p.name, {
      onClose: () => {
        if (!controller.signal.aborted) controller.abort('plugin-output-sheet-closed');
        if (runController === controller) runController = null;
      },
    });
    const out = el('div', 'codeview small');
    s.body.append(el('div', 'hint', pick('実行しています…', 'Running…')), out);
    const isCurrent = () => (
      !controller.signal.aborted
      && runController === controller
      && s.root.isConnected
      && sheet.root.isConnected
    );
    const write = (line) => {
      if (!isCurrent()) return;
      const row = el('div', 'cl');
      row.append(el('span', 'cl-text mono', line));
      out.append(row);
    };
    app.plugins.run(p.id, write, { signal:controller.signal }).then((res) => {
      if (!isCurrent()) return;
      if (res.error) write('⚠ ' + res.error);
      else write(pick('— おわり —', '— Done —'));
    }).finally(() => {
      if (runController === controller) runController = null;
    });
  }

  const body = el('div');
  sheet.body.append(body);
  render();
}

/* ══════════════════════════════════════════════════════════
   Unity（IL2CPP）
   ══════════════════════════════════════════════════════════ */

export function showIl2cpp(app) {
  const sheet = new Sheet('Unity（IL2CPP）');
  let activeController = null;
  const abortActive = () => {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  };
  sheet.onClose = abortActive;

  sheet.body.append(el('div', 'hint',
    'Unity のアプリは C# で書かれていますが、出荷時にはクラス名やメソッド名が\n' +
    '実行ファイルから消え、global-metadata.dat という別ファイルに移ります。\n' +
    'そのファイルを読み込むと、名前の一覧が戻ります。'));

  sheet.body.append(codeBlock([
    'YourApp.app/',
    '  YourApp                                    ← いま開いているファイル',
    '  Data/Managed/Metadata/global-metadata.dat  ← これを読み込みます',
  ]));

  const unity = looksLikeUnity(app.stringIndex, app.currentSlice());
  sheet.body.append(el('div', 'hint',
    unity ? '✓ このファイルは Unity 製のようです。' :
      'このファイルが Unity 製かどうかは、まだ分かりません（文字列を集めると精度が上がります）。'));

  const body = el('div');
  const pick = button('global-metadata.dat を読み込む', 'tb-btn strong', () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.addEventListener('change', async () => {
      const f = picker.files && picker.files[0];
      if (!f) return;
      if (f.size > MAX_IL2CPP_METADATA_BYTES) {
        body.replaceChildren(el('div', 'hint', `global-metadata.dat が大きすぎます (${Math.ceil(f.size/1024/1024)} MiB)。安全上 ${MAX_IL2CPP_METADATA_BYTES/1024/1024} MiB までです。`));
        return;
      }
      abortActive();
      const snap = captureAppEpoch(app);
      const controller = new AbortController();
      activeController = controller;
      body.replaceChildren(el('div', 'hint', '読み込んでいます…'));
      try {
        const meta = await parseMetadataFileInWorker(f, { signal:controller.signal });
        if (controller.signal.aborted || !isAppEpochCurrent(app, snap, sheet)) return;
        await bindMethodAddresses(meta, {
          regions: app.store.get('regions') || [], signal: controller.signal,
          read: (addr, len) => app.backend.readAt(addr, len)
            .then((r) => (r && r.found ? r.bytes : null)),
        });
        if (controller.signal.aborted || !isAppEpochCurrent(app, snap, sheet)) return;
        const named = meta.methods.filter((m) => m.address != null)
          .map((m) => ({ addr: m.address, name: m.full }));
        if (named.length && !controller.signal.aborted && isAppEpochCurrent(app, snap, sheet)) {
          app.symbols.addNames(named);
          app.symbols.addFunctions(named.map((n) => n.addr));
          app.viewer.setSymbols(app.symbols);
        }
        if (!controller.signal.aborted && isAppEpochCurrent(app, snap, sheet)) {
          show(meta);
        }
      } catch (err) {
        if (controller.signal.aborted || err?.code === 'ABORT_ERR' || err?.name === 'AbortError') return;
        if (!isAppEpochCurrent(app, snap, sheet)) return;
        body.replaceChildren(el('div', 'hint warn', userError(err,
          'IL2CPPメタデータを解析できませんでした。別の解析ツールは引き続き利用できます。')));
      } finally {
        if (activeController === controller) activeController = null;
      }
    });
    picker.click();
  });
  sheet.body.append(pick, body);

  function show(meta) {
    body.replaceChildren();
    body.append(el('div', 'hint',
      'version ' + meta.version + '  ·  クラス ' + meta.classes.length +
      ' 個  ·  メソッド ' + meta.methods.length + ' 個  ·  文字列 ' + meta.literals.length + ' 個'));
    for (const w of meta.warnings) body.append(el('div', 'hint warn', '⚠ ' + w));
    body.append(noteBox(meta.methodBinding && meta.methodBinding.bound
      ? meta.methodBinding.bound + ' 個のメソッドを、検証済みのCodeRegistration表から機械語addressへ対応づけました。'
      : 'Method→address表を検証できなかったため、名前だけを表示します。推測addressは作りません。'));

    const search = input('クラス名・メソッド名で絞り込む');
    const results = list();
    body.append(field(search, '探す', run), results);
    let classLower = null;
    let methodLower = null;
    let literalLower = null;
    const takeMatches = (source, lowered, q, limit) => {
      const out = [];
      for (let i = 0; i < source.length && out.length < limit; i++) {
        if (lowered[i].includes(q)) out.push(source[i]);
      }
      return out;
    };

    function run() {
      const q = search.value.trim().toLowerCase();
      results.replaceChildren();
      if (!q) {
        results.append(groupRow('クラス（先頭 100 個）'));
        for (const c of meta.classes.slice(0, 100)) {
          results.append(tapRow(c.full, { sub: 'クラス', onTap: () => copyText(c.full, '名前') }));
        }
        return;
      }
      if (!classLower) {
        classLower = meta.classes.map((c) => c.full.toLowerCase());
        methodLower = meta.methods.map((m) => m.name.toLowerCase());
        literalLower = meta.literals.map((x) => x.text.toLowerCase());
      }
      const cs = takeMatches(meta.classes, classLower, q, 60);
      const ms = takeMatches(meta.methods, methodLower, q, 100);
      const ls = takeMatches(meta.literals, literalLower, q, 60);
      if (cs.length) results.append(groupRow('クラス'));
      for (const c of cs) results.append(tapRow(c.full, { sub: 'クラス', onTap: () => copyText(c.full, '名前') }));
      if (ms.length) results.append(groupRow('メソッド'));
      for (const m of ms) {
        results.append(tapRow(m.name, {
          sub: (m.className || '（所属不明）') + (m.address != null ? '\n' + addrHex(m.address) : ''),
          onTap: () => m.address != null ? app.goToAddress(m.address) : copyText(m.full, '名前'),
        }));
      }
      if (ls.length) results.append(groupRow('プログラムの中の文字列'));
      for (const x of ls) {
        results.append(tapRow(x.text.slice(0, 80), {
          sub: 'この文字列で「検索」すると、使っている場所が見つかることがあります',
          onTap: () => copyText(x.text, '文字列'),
        }));
      }
      if (!cs.length && !ms.length && !ls.length) results.append(tapRow('見つかりませんでした', { disabled: true }));
    }
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    run();
  }
}

/* ══════════════════════════════════════════════════════════
   そのほか（ほかの画面から呼ぶ小さな入口）
   ══════════════════════════════════════════════════════════ */

/** 名前が読み直せるものなら、読める形にして返す。 */
export function prettyName(name) {
  if (!name) return name;
  /*
   * 一覧や図の中では、短い形で出す。
   * 完全に戻した形は 150 字を超えることがあり、行からあふれて
   * 「どのクラスの何か」がかえって読めなくなる。
   * 完全な形は、関数の詳細（名前を付ける画面）に出している。
   */
  return isMangled(name) ? shortName(name) : name;
}

/** 完全に戻した形。詳細画面で「本当の名前」を見せるときだけ使う。 */
export function fullName(name) {
  if (!name) return name;
  return isMangled(name) ? readableName(name) : name;
}

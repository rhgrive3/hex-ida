import { Sheet, el, list, tapRow, para, toast } from '../../ui.js';
import { addrHex } from '../../format.js';
import { goalLabel } from '../../goals.js';
import { VERDICT } from '../../evidence.js';
import { investigationServiceFor } from '../../analysis/investigation-service.js';
import { pick } from '../../i18n.js';
import { showField } from './field-access.js';
import { appendJevAlternativeAction } from '../jev-advisory.js';
import { showPatchEditor } from '../../tools.js';

function isAbort(error) { return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'; }
function functionLabel(app, address) {
  if (address == null) return pick('不明な関数', 'Unknown function');
  return app.symbols?.nameAt?.(address) || `sub_${BigInt(address).toString(16).toUpperCase()}`;
}
function verdictLabel(verdict) {
  if (verdict === VERDICT.CONFIRMED) return pick('確認済み', 'Confirmed');
  if (verdict === VERDICT.LIKELY) return pick('ほぼ確実', 'Likely');
  if (verdict === VERDICT.AMBIGUOUS) return pick('候補あり', 'Ambiguous');
  return pick('未確認', 'Unverified');
}
const REASON_LABELS = {
  'string-ref':['文字列を参照', 'string reference'],
  'name-match':['名前が一致', 'name match'],
  'callee-name':['呼び先の名前が一致', 'callee name match'],
  'caller-name':['呼び元の名前が一致', 'caller name match'],
  'calls-match':['有力候補を呼ぶ', 'calls a candidate'],
  'called-by-match':['有力候補から呼ばれる', 'called by a candidate'],
  numeric:['数値の計算', 'arithmetic'],
  store:['メモリへ書き込む', 'memory writes'],
  compare:['値を比べる', 'comparisons'],
  popular:['よく呼ばれる', 'widely called'],
};
function reasonLabel(code) {
  const entry = REASON_LABELS[code];
  return entry ? pick(entry[0], entry[1]) : String(code ?? '');
}
function progressView(body, onCancel = null) {
  const wrap = el('div', 'analysis-progress');
  const head = el('div', 'row');
  const label = el('div', 'hint', pick('解析の準備をしています…', 'Preparing analysis…'));
  head.append(label);
  if (typeof onCancel === 'function') {
    const cancelBtn = el('button', 'btn sm', pick('キャンセル', 'Cancel'));
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => onCancel());
    head.append(cancelBtn);
  }
  const bar = el('div', 'progress');
  const fill = el('i');
  bar.append(fill); wrap.append(head, bar); body.append(wrap);
  return {
    update(value = {}) {
      const phase = String(value.phase || 'analysis');
      const names = {
        strings:pick('アプリ内の言葉を集めています…', 'Collecting text…'),
        program:pick('呼び出しと参照を索引しています…', 'Indexing calls and references…'),
        shapes:pick('値のふるまいを調べています…', 'Analysing value behaviour…'),
        pinpoint:pick('候補を命令まで確認しています…', 'Verifying candidates…'),
        goals:pick('目的ごとに候補を比較しています…', 'Comparing candidates…'),
        deep:pick('有力な関数を詳しく読んでいます…', 'Reading strong candidates…'),
      };
      label.textContent = names[phase] || pick('解析しています…', 'Analysing…');
      if (Number(value.all) > 0) fill.style.width = `${Math.min(100, Math.round(Number(value.done || 0) / Number(value.all) * 100))}%`;
    },
    done() { wrap.remove(); },
  };
}
const COMPLETENESS_LABELS = {
  'strings-partial': ['文字列スキャン途中', 'string scan in progress'],
  'program-partial': ['呼び出し解析途中', 'call graph in progress'],
  'functions-partial': ['関数一覧スキャン途中', 'function scan in progress'],
  'budget-exhausted': ['探索上限に到達', 'search budget reached'],
  'aborted': ['中断されました', 'cancelled'],
};
function completenessReasonText(reason) {
  const entry = COMPLETENESS_LABELS[String(reason || '')];
  return entry ? pick(entry[0], entry[1]) : String(reason || '');
}
function appendCompleteness(body, result) {
  if (result?.completeness?.complete) return;
  const reasons = (result?.completeness?.reasons || []).map(completenessReasonText).filter(Boolean);
  body.append(para(pick(
    `一部のみ確認済み${reasons.length ? `（${reasons.join('・')}）` : ''}。未走査の範囲にも候補がある可能性があります。`,
    `Partial scan${reasons.length ? ` (${reasons.join(', ')})` : ''}. Unscanned areas may still contain matches.`
  ), 'sub'));
}
function productRouter() {
  return (typeof window !== 'undefined' && window.__hexUi?.router) || null;
}

/* The answer is a function, so open its workspace. goToFunction alone only
   moved the hidden code view: the sheet closed and the screen stayed on
   Investigate, so the tap looked like it did nothing. */
function openFunction(app, sheet, address, tab = 'overview') {
  if (address == null) return;
  sheet.close();
  const target = BigInt(address);
  const router = productRouter();
  if (router) { router.navigate(`/function/${target.toString()}/${tab}`); return; }
  if (typeof app.goToFunction === 'function') app.goToFunction(target);
  else app.goToAddress?.(target, { announce:true });
}

function openAddress(app, sheet, address) {
  if (address == null) return;
  sheet.close();
  const target = BigInt(address);
  app.goToAddress?.(target, { announce:true });
  productRouter()?.navigate(`/code/${target.toString()}`);
}

/* A field answer (HP, attack, ...) has no single function; its useful next
   step is every instruction that reads or writes the field. */
function fieldOf(top) {
  const field = top?.field;
  return field && top?.className && Number.isFinite(Number(field.offset)) ? { className:String(top.className), field } : null;
}
function fieldLabel(target) {
  return `${target.className}.${String(target.field.name || '').replace(/^_/, '') || '?'}`;
}

export function showCandidates(app, goal) {
  if (!goal) return null;
  app.lastGoal = goal;
  void app.persistAnalysisSession?.(['lastGoal']);
  const initialGen = app?.backend?.gen;
  const initialFile = app?.store?.get?.('fileInfo');
  const isCurrentBinary = () => app?.backend?.gen === initialGen && app?.store?.get?.('fileInfo') === initialFile;
  const controller = new AbortController();
  const sheet = new Sheet(goalLabel(goal), { onClose:() => controller.abort('candidate-sheet-closed') });
  const progress = progressView(sheet.body, () => { controller.abort('user-cancelled'); sheet.close(); });
  const host = el('div'); sheet.body.append(host);

  const run = () => investigationServiceFor(app).investigate(goal, {
    signal:controller.signal,
    onProgress:(value) => { if (isCurrentBinary()) progress.update(value); },
  }).then((result) => {
    progress.done();
    if (controller.signal.aborted || !sheet.root.isConnected || !isCurrentBinary()) return;
    appendCompleteness(host, result);
    const pin = result.pin;
    if (pin?.top && pin.verdict !== VERDICT.NONE) {
      const answer = el('section', 'answer-summary');
      answer.append(el('h3', null, pick('最も強い答え', 'Strongest answer')));
      const address = pin.top.addr ?? pin.top.function ?? pin.top.address ?? null;
      const title = pin.top.name || (address != null ? functionLabel(app, address) : pin.top.field?.name) || goalLabel(goal);
      answer.append(el('div', 'fn-name', String(title)));
      answer.append(el('div', 'hint', verdictLabel(pin.verdict)));
      const answerField = address == null ? fieldOf(pin.top) : null;
      if (answerField) {
        const fieldRow = list();
        fieldRow.append(tapRow(pick('このフィールドを使う場所', 'Where this field is used'), {
          sub:fieldLabel(answerField), right:'›', onTap:() => showField(app, answerField.className, answerField.field),
        }));
        answer.append(fieldRow);
      }
      if (address != null) {
        const quick = el('div', 'row');
        const pseudoBtn = el('button', 'btn sm', pick('疑似C', 'Pseudo-C'));
        pseudoBtn.type = 'button';
        pseudoBtn.addEventListener('click', () => openFunction(app, sheet, address, 'pseudocode'));
        const asmBtn = el('button', 'btn sm', pick('アセンブリ', 'Assembly'));
        asmBtn.type = 'button';
        asmBtn.addEventListener('click', () => openAddress(app, sheet, address));
        const patchBtn = el('button', 'btn sm', pick('パッチ', 'Patch'));
        patchBtn.type = 'button';
        patchBtn.addEventListener('click', () => {
          sheet.close();
          app.goToAddress?.(BigInt(address), { announce:true });
          showPatchEditor(app, BigInt(address));
        });
        quick.append(pseudoBtn, asmBtn, patchBtn);
        answer.append(quick);
      }
      host.append(answer);
    }

    appendJevAlternativeAction(app, goal, pin, host, controller.signal, {
      rankedCandidates: result.ranked?.candidates || [],
      onOpenFunction: (addr) => openFunction(app, sheet, addr, 'pseudocode'),
    });

    const candidates = result.ranked?.candidates || [];
    if (!candidates.length) {
      host.append(para(pick('条件に合う候補が見つかりませんでした。別の言い方や英単語で試してください。', 'No matching candidates found. Try different keywords.')));
      return;
    }
    host.append(el('div', 'sec-title', pick('候補一覧', 'Ranked candidates')));
    const rows = list();
    candidates.forEach((candidate, idx) => {
      const reasons = (candidate.reasons || []).slice(0, 2).map((reason) => reasonLabel(reason.code)).join(' · ');
      const rankTag = idx < 3 ? `#${idx + 1}` : '';
      rows.append(tapRow(`${rankTag ? `${rankTag} ` : ''}${functionLabel(app, candidate.addr)}`, {
        sub:[addrHex(candidate.addr), reasons].filter(Boolean).join(' · '),
        right:'›',
        onTap:() => openFunction(app, sheet, candidate.addr, 'pseudocode'),
      }));
    });
    host.append(rows);
  }).catch((error) => {
    progress.done();
    if (isAbort(error) || !sheet.root.isConnected) return;
    const retryBtn = el('button', 'btn sm', pick('再試行', 'Retry'));
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', () => { sheet.close(); showCandidates(app, goal); });
    host.replaceChildren(para(pick('解析に失敗しました: ', 'Analysis failed: ') + String(error?.message || error)), retryBtn);
  });
  run();
  return sheet;
}

export function showOverview(app) {
  if (!app.store.get('fileInfo')) { toast(pick('先にファイルを開いてください。', 'Open a file first.')); return null; }
  const initialGen = app?.backend?.gen;
  const initialFile = app?.store?.get?.('fileInfo');
  const isCurrentBinary = () => app?.backend?.gen === initialGen && app?.store?.get?.('fileInfo') === initialFile;
  const controller = new AbortController();
  const sheet = new Sheet(pick('このアプリを解析しました', 'Application overview'), { onClose:() => controller.abort('overview-sheet-closed') });
  const progress = progressView(sheet.body, () => { controller.abort('user-cancelled'); sheet.close(); });
  const host = el('div'); sheet.body.append(host);

  investigationServiceFor(app).overview({
    signal:controller.signal,
    onProgress:(value) => { if (isCurrentBinary()) progress.update(value); },
  }).then((result) => {
    progress.done();
    if (controller.signal.aborted || !sheet.root.isConnected || !isCurrentBinary()) return;
    app.autoReport = { report:result.report, key:result.context.region?.id ?? null, gen:app.symbols?.gen, snapshotId:result.snapshotId };
    void app.persistAnalysisSession?.(['autoReport', 'lastGoal']);
    appendCompleteness(host, result);
    const report = result.report;
    const summary = list();
    summary.append(tapRow(pick('関数', 'Functions'), { right:String(report?.stats?.functions ?? 0), disabled:true }));
    summary.append(tapRow(pick('文字列', 'Strings'), { right:String(report?.stats?.strings ?? 0), disabled:true }));
    summary.append(tapRow(pick('呼び出し', 'Calls'), { right:String(report?.stats?.calls ?? 0), disabled:true }));
    summary.append(tapRow(pick('参照', 'References'), { right:String(report?.stats?.refs ?? 0), disabled:true }));
    host.append(summary);

    const confirmed = report?.confirmed || [];
    const goals = report?.goals || [];
    const findings = report?.findings || [];
    if (confirmed.length || goals.length) {
      host.append(el('div', 'sec-title', pick('目的ごとの結果', 'Goal results')));
      const rows = list();
      const seenGoals = new Set();
      const combined = [...confirmed, ...goals].filter((item) => {
        const key = String(item?.goal?.id || item?.goal?.en || item?.goal?.ja || '') + ':' + String(item?.top?.addr ?? item?.addr ?? item?.top?.field?.offset ?? '');
        if (seenGoals.has(key)) return false;
        seenGoals.add(key);
        return true;
      });
      for (const item of combined.slice(0, 32)) {
        const address = item?.top?.addr ?? item?.addr ?? item?.address ?? null;
        const target = address == null ? fieldOf(item?.top) : null;
        const label = item?.goal?.ja || item?.goal?.en || item?.goal?.id || pick('解析結果', 'Finding');
        if (target) {
          rows.append(tapRow(label, {
            sub:`${fieldLabel(target)} · ${verdictLabel(item?.verdict)}`,
            right:'›',
            onTap:() => showField(app, target.className, target.field),
          }));
          continue;
        }
        rows.append(tapRow(label, {
          sub:address != null ? `${functionLabel(app, address)} · ${addrHex(BigInt(address))}` : verdictLabel(item?.verdict),
          right:address != null ? '›' : '',
          disabled:address == null,
          onTap:address != null ? () => openFunction(app, sheet, address) : null,
        }));
      }
      host.append(rows);
    }
    if (findings.length) {
      host.append(el('div', 'sec-title', pick('見つかった手がかり', 'Notable evidence')));
      const rows = list();
      for (const finding of findings.slice(0, 24)) {
        const users = Array.isArray(finding.users) ? finding.users.length : null;
        const usage = users == null ? '' : users ? pick(` · 使っている場所 ${users} か所`, ` · used in ${users} places`) : pick(' · どこからも使われていません', ' · not referenced');
        rows.append(tapRow(String(finding.text || finding.id || pick('手がかり', 'Evidence')), {
          sub:finding.addr != null ? addrHex(BigInt(finding.addr)) + usage : '',
          right:finding.addr != null ? '›' : '',
          disabled:finding.addr == null,
          onTap:finding.addr != null ? () => openAddress(app, sheet, finding.addr) : null,
        }));
      }
      host.append(rows);
    }
  }).catch((error) => {
    progress.done();
    if (isAbort(error) || !sheet.root.isConnected) return;
    host.replaceChildren(para(pick('解析に失敗しました: ', 'Analysis failed: ') + String(error?.message || error)));
  });
  return sheet;
}

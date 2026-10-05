import { Sheet, el, list, tapRow, para, toast } from '../../ui.js';
import { addrHex } from '../../format.js';
import { goalLabel } from '../../goals.js';
import { VERDICT } from '../../evidence.js';
import { investigationServiceFor } from '../../analysis/investigation-service.js';
import { pick } from '../../i18n.js';
import { showField } from './field-access.js';

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
function progressView(body) {
  const wrap = el('div', 'analysis-progress');
  const label = el('div', 'hint', pick('解析の準備をしています…', 'Preparing analysis…'));
  const bar = el('div', 'progress');
  const fill = el('i');
  bar.append(fill); wrap.append(label, bar); body.append(wrap);
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
function appendCompleteness(body, result) {
  if (result?.completeness?.complete) return;
  const reasons = result?.completeness?.reasons || [];
  body.append(para(pick(
    `まだ全範囲の確認は終わっていません${reasons.length ? `（${reasons.join(' / ')}）` : ''}。未走査を「該当なし」とは扱いません。`,
    `Analysis is still partial${reasons.length ? ` (${reasons.join(' / ')})` : ''}. Unscanned data is not treated as negative evidence.`
  ), 'sub'));
}
function productRouter() {
  return (typeof window !== 'undefined' && window.__hexUi?.router) || null;
}

/* The answer is a function, so open its workspace. goToFunction alone only
   moved the hidden code view: the sheet closed and the screen stayed on
   Investigate, so the tap looked like it did nothing. */
function openFunction(app, sheet, address) {
  if (address == null) return;
  sheet.close();
  const target = BigInt(address);
  const router = productRouter();
  if (router) { router.navigate(`/function/${target.toString()}/overview`); return; }
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
  const controller = new AbortController();
  const sheet = new Sheet(goalLabel(goal), { onClose:() => controller.abort('candidate-sheet-closed') });
  const progress = progressView(sheet.body);
  const host = el('div'); sheet.body.append(host);

  investigationServiceFor(app).investigate(goal, {
    signal:controller.signal,
    onProgress:(value) => progress.update(value),
  }).then((result) => {
    progress.done();
    if (controller.signal.aborted || !sheet.root.isConnected) return;
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
        // A tap row is an <li>; outside a list it rendered as a bullet with
        // the chevron wrapped onto its own line.
        const openRow = list();
        openRow.append(tapRow(pick('この処理を開く', 'Open this routine'), {
          sub:addrHex(BigInt(address)), right:'›', onTap:() => openFunction(app, sheet, address),
        }));
        answer.append(openRow);
      }
      host.append(answer);
    }

    const candidates = result.ranked?.candidates || [];
    if (!candidates.length) {
      host.append(para(pick('現在の証拠からは、処理候補を絞れませんでした。', 'The current evidence does not narrow this to a routine yet.')));
      return;
    }
    host.append(el('div', 'sec-title', pick('関係の強い処理', 'Strongest related routines')));
    const rows = list();
    for (const candidate of candidates) {
      const reasons = (candidate.reasons || []).slice(0, 2).map((reason) => reasonLabel(reason.code)).join(' · ');
      rows.append(tapRow(functionLabel(app, candidate.addr), {
        sub:[addrHex(candidate.addr), reasons].filter(Boolean).join('  ·  '),
        right:`${Math.round(candidate.score)} pt`,
        onTap:() => openFunction(app, sheet, candidate.addr),
      }));
    }
    host.append(rows);
  }).catch((error) => {
    progress.done();
    if (isAbort(error) || !sheet.root.isConnected) return;
    host.replaceChildren(para(pick('解析に失敗しました: ', 'Analysis failed: ') + String(error?.message || error)));
  });
  return sheet;
}

export function showOverview(app) {
  if (!app.store.get('fileInfo')) { toast(pick('先にファイルを開いてください。', 'Open a file first.')); return null; }
  const controller = new AbortController();
  const sheet = new Sheet(pick('このアプリを解析しました', 'Application overview'), { onClose:() => controller.abort('overview-sheet-closed') });
  const progress = progressView(sheet.body);
  const host = el('div'); sheet.body.append(host);

  investigationServiceFor(app).overview({
    signal:controller.signal,
    onProgress:(value) => progress.update(value),
  }).then((result) => {
    progress.done();
    if (controller.signal.aborted || !sheet.root.isConnected) return;
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
      for (const item of (confirmed.length ? confirmed : goals).slice(0, 32)) {
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

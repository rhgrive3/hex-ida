import { Sheet, el, list, tapRow, para, toast } from '../../ui.js';
import { addrHex } from '../../format.js';
import { goalLabel } from '../../goals.js';
import { VERDICT } from '../../evidence.js';
import { investigationServiceFor } from '../../analysis/investigation-service.js';
import { pick } from '../../i18n.js';

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
function openFunction(app, sheet, address) {
  if (address == null) return;
  sheet.close();
  if (typeof app.goToFunction === 'function') app.goToFunction(BigInt(address));
  else app.goToAddress?.(BigInt(address), { announce:true });
}

export function showCandidates(app, goal) {
  if (!goal) return null;
  app.lastGoal = goal;
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
      if (address != null) {
        answer.append(tapRow(pick('この処理を開く', 'Open this routine'), {
          sub:addrHex(BigInt(address)), right:'›', onTap:() => openFunction(app, sheet, address),
        }));
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
      const reasons = (candidate.reasons || []).slice(0, 2).map((reason) => reason.code).join(' · ');
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
        rows.append(tapRow(item?.goal?.ja || item?.goal?.en || item?.goal?.id || pick('解析結果', 'Finding'), {
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
        rows.append(tapRow(String(finding.text || finding.id || pick('手がかり', 'Evidence')), {
          sub:finding.addr != null ? addrHex(BigInt(finding.addr)) : '', disabled:true,
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

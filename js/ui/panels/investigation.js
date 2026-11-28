import { Sheet, el, list, tapRow, para, toast } from '../../ui.js';
import { addrHex } from '../../format.js';
import { goalLabel } from '../../goals.js';
import { VERDICT } from '../../evidence.js';
import { investigationServiceFor } from '../../analysis/investigation-service.js';
import { pick } from '../../i18n.js';
import { reasonText, statusNotice } from '../primitives.js';
import { showField } from './field-access.js';
import { appendJevAlternativeAction } from '../jev-advisory.js';
import { showPatchEditor } from '../../tools.js';
import { pinpointMatchesAddress } from '../function-analysis-presentation.js';

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
  'string-ref':['文字列を参照', 'Refers to a string'],
  'name-match':['名前が一致', 'Name match'],
  'callee-name':['呼び先の名前が一致', 'Callee name match'],
  'caller-name':['呼び元の名前が一致', 'Caller name match'],
  'calls-match':['有力候補を呼ぶ', 'Calls a candidate'],
  'called-by-match':['有力候補から呼ばれる', 'Called by a candidate'],
  'crypto-const':['暗号定数を参照', 'References crypto constant'],
  'size-penalty':['関数が大きい', 'Large function'],
  vendor:['外部ライブラリ', 'Vendor library'],
  numeric:['数値の計算', 'Arithmetic'],
  store:['メモリへ書き込む', 'Memory writes'],
  compare:['値を比べる', 'Comparisons'],
  popular:['よく呼ばれる', 'Widely called'],
};
function clipDetail(value, max = 36) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function safeAddrHex(value) {
  if (value == null) return '';
  try { return addrHex(BigInt(value)); } catch { return String(value); }
}
function reasonLabel(code) {
  const entry = Object.hasOwn(REASON_LABELS, code) ? REASON_LABELS[code] : null;
  return entry ? pick(entry[0], entry[1]) : String(code ?? '');
}

export function formatCandidateReason(reason) {
  if (!reason) return '';
  if (typeof reason === 'string') return reasonLabel(reason);
  const code = String(reason.code || '');
  const d = (reason.detail && typeof reason.detail === 'object') ? reason.detail : {};
  const strText = clipDetail(d.text ?? d.string ?? reason.text ?? reason.string ?? '');
  const symName = clipDetail(d.name ?? reason.name ?? '');
  const fieldName = clipDetail(d.field ?? reason.field ?? '');
  const callerName = clipDetail(d.fromName ?? d.caller ?? reason.caller ?? (code === 'caller-name' && symName ? symName : null) ?? safeAddrHex(d.from));
  const calleeName = clipDetail(d.toName ?? d.callee ?? reason.callee ?? (code === 'callee-name' && symName ? symName : null) ?? safeAddrHex(d.to));
  const algoName = clipDetail(d.name ?? d.algo ?? reason.algo ?? '');

  switch (code) {
    case 'string-ref':
      return strText
        ? pick(`"${strText}" を参照`, `Refers to "${strText}"`)
        : reasonLabel(code);
    case 'name-match': {
      const target = symName || clipDetail(d.term ?? '');
      return target
        ? pick(`関数名 "${target}" が一致`, `Name matches "${target}"`)
        : reasonLabel(code);
    }
    case 'callee-name':
    case 'calls-match':
      return calleeName
        ? pick(`${calleeName} を呼ぶ`, `Calls ${calleeName}`)
        : reasonLabel(code);
    case 'caller-name':
    case 'called-by-match':
      return callerName
        ? pick(`${callerName} から呼ばれる`, `Called by ${callerName}`)
        : reasonLabel(code);
    case 'crypto-const':
      return algoName
        ? pick(`暗号定数 (${algoName}) を参照`, `References crypto constant (${algoName})`)
        : reasonLabel(code);
    case 'store': {
      if (fieldName) return pick(`${fieldName} へ書き込む`, `Writes ${fieldName}`);
      const n = Number(d.n);
      return Number.isFinite(n) && n > 0
        ? pick(`メモリへ書き込む (${n}か所)`, `Memory writes (${n})`)
        : reasonLabel(code);
    }
    case 'compare': {
      const n = Number(d.n);
      return Number.isFinite(n) && n > 0
        ? pick(`値を比べる (${n}か所)`, `Comparisons (${n})`)
        : reasonLabel(code);
    }
    case 'numeric': {
      const ops = [d.mul, d.div, d.fmul, d.farith].map(Number).filter((x) => Number.isFinite(x) && x > 0).reduce((a, b) => a + b, 0);
      return ops > 0
        ? pick(`数値の計算 (${ops}回)`, `Arithmetic (${ops} ops)`)
        : reasonLabel(code);
    }
    case 'popular': {
      const n = Number(d.n);
      return Number.isFinite(n) && n > 0
        ? pick(`${n}か所から呼ばれる`, `Called from ${n} places`)
        : reasonLabel(code);
    }
    case 'vendor': {
      const vendor = clipDetail(d.vendor ?? symName ?? '');
      return vendor
        ? pick(`外部ライブラリ (${vendor})`, `Vendor library (${vendor})`)
        : reasonLabel(code);
    }
    case 'size-penalty': {
      const n = Number(d.n);
      return Number.isFinite(n) && n > 0
        ? pick(`関数が大きい (${n}命令)`, `Large function (${n} insns)`)
        : reasonLabel(code);
    }
    default: {
      const base = reasonLabel(code);
      const concrete = fieldName || symName || strText || algoName;
      if (concrete && base) return `${base} (${concrete})`;
      return concrete || base;
    }
  }
}

export function formatCandidateReasons(reasons, maxCount = 2) {
  if (!Array.isArray(reasons) || !reasons.length) return [];
  const limit = Number.isInteger(maxCount) && maxCount > 0 ? maxCount : 2;
  const ordered = [...reasons].sort((a, b) => {
    const ap = Number.isFinite(Number(a?.points)) ? Number(a.points) : 0;
    const bp = Number.isFinite(Number(b?.points)) ? Number(b.points) : 0;
    if ((ap > 0) !== (bp > 0)) return ap > 0 ? -1 : 1;
    return bp - ap;
  });
  const picked = [];
  const seenCodes = new Set();
  const seenTexts = new Set();
  const deferredSameCode = [];

  for (const reason of ordered) {
    const formatted = formatCandidateReason(reason);
    if (!formatted || seenTexts.has(formatted)) continue;
    const code = String(reason?.code || '');
    if (code && seenCodes.has(code)) {
      deferredSameCode.push({ code, formatted, hasDetail: formatted !== reasonLabel(code) });
      continue;
    }
    seenTexts.add(formatted);
    if (code) seenCodes.add(code);
    picked.push(formatted);
    if (picked.length >= limit) return picked;
  }

  for (const item of deferredSameCode) {
    if (!item.hasDetail || seenTexts.has(item.formatted)) continue;
    seenTexts.add(item.formatted);
    picked.push(item.formatted);
    if (picked.length >= limit) break;
  }
  return picked;
}

export function describeStrongestAnswer(app, goal, pin, rankedCandidates = []) {
  const rawAddr = pin?.top?.addr ?? pin?.top?.function ?? pin?.top?.address ?? null;
  const isAddresslessLocationOrField = rawAddr == null && (
    pin?.kind === 'location'
    || pin?.top?.kind === 'location'
    || pin?.kind === 'field'
    || pin?.top?.kind === 'field'
  );
  const topField = rawAddr == null ? fieldOf(pin?.top) : null;
  if (topField || isAddresslessLocationOrField) {
    const title = pin?.top?.name
      || (topField ? fieldLabel(topField) : null)
      || pin?.top?.field?.name
      || pin?.top?.label
      || goalLabel(goal);
    const reasonsSource = pin?.top?.reasons?.length
      ? pin.top.reasons
      : (pin?.reasons?.length ? pin.reasons : []);
    const strongestReason = formatCandidateReasons(reasonsSource, 1)[0]
      || (topField ? pick(`${fieldLabel(topField)} のフィールド参照`, `Field access on ${fieldLabel(topField)}`) : '');
    return { address: null, title: String(title), addrText: '', strongestReason, answerField: topField };
  }
  let matchedCandidate = null;
  if (rawAddr != null && Array.isArray(rankedCandidates)) {
    try {
      const target = BigInt(rawAddr);
      matchedCandidate = rankedCandidates.find((c) => c?.addr != null && BigInt(c.addr) === target) || null;
    } catch { /* ignore */ }
  }
  if (!matchedCandidate && rawAddr == null && Array.isArray(rankedCandidates) && rankedCandidates.length > 0) {
    matchedCandidate = rankedCandidates[0];
  }
  const address = rawAddr ?? matchedCandidate?.addr ?? null;
  const answerField = address == null ? fieldOf(pin?.top) : null;
  const title = pin?.top?.name
    || (address != null ? functionLabel(app, address) : (answerField ? fieldLabel(answerField) : pin?.top?.field?.name))
    || matchedCandidate?.name
    || goalLabel(goal);
  const addrText = address != null ? safeAddrHex(address) : '';
  const reasonsSource = pin?.top?.reasons?.length
    ? pin.top.reasons
    : (pin?.reasons?.length ? pin.reasons : (matchedCandidate?.reasons || []));
  const strongestReason = formatCandidateReasons(reasonsSource, 1)[0]
    || (answerField ? pick(`${fieldLabel(answerField)} のフィールド参照`, `Field access on ${fieldLabel(answerField)}`) : '');
  return { address, title: String(title), addrText, strongestReason, answerField };
}
function progressView(body, onCancel = null) {
  const wrap = el('div', 'analysis-progress');
  const head = el('div', 'inv-row');
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
function isAutoDiscoveryComplete(app) {
  if (!app) return false;
  const v6State = app.v6Workbench?.getAutoAnalysisState?.() ?? null;
  const v6Done = v6State?.status === 'done' || v6State?.staged?.status === 'done';
  if (v6Done && app.store?.get?.('symbolsReady') !== false) return true;
  if (app.store?.get?.('symbolsReady') === true && Number(app.symbols?.functionCount ?? 0) > 0 && app.symbols?.guessed === false) return true;
  return false;
}

export function appendCompleteness(body, result, { onContinue = null, app = null } = {}) {
  if (result?.completeness?.complete) return null;
  const initialReasons = (result?.completeness?.reasons || []).map((r) => String(r || '').trim()).filter(Boolean);
  const discoveryDone = isAutoDiscoveryComplete(app);
  const rawReasons = discoveryDone
    ? initialReasons.filter((r) => !r.includes('function-discovery-incomplete') && r !== 'functions-partial')
    : initialReasons;
  if (discoveryDone && initialReasons.length > 0 && rawReasons.length === 0) return null;
  const hasIncompleteDiscovery = rawReasons.some((r) => r.includes('function-discovery-incomplete') || r === 'functions-partial');
  const lead = rawReasons.length
    ? ''
    : pick('一部のみ確認済みです。未走査の範囲にも候補がある可能性があります。', 'Partial scan. Unscanned areas may still contain matches.');
  const notice = statusNotice(rawReasons, {
    lead,
    actionLabel: pick('続きを調べる', 'Continue scanning'),
    onAction: typeof onContinue === 'function' && (hasIncompleteDiscovery || rawReasons.length > 0) ? onContinue : null,
  });
  body.append(notice);
  return notice;
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
    const candidates = result.ranked?.candidates || [];
    appendCompleteness(host, result, {
      app,
      onContinue: () => { sheet.close(); showCandidates(app, goal); },
    });
    const pin = result.pin;
    const findCandidateByAddr = (targetAddr) => {
      if (targetAddr == null) return null;
      try {
        const target = BigInt(targetAddr);
        return candidates.find((c) => {
          if (c?.addr == null) return false;
          try { return BigInt(c.addr) === target; } catch { return false; }
        }) || null;
      } catch { return null; }
    };
    const openCandidateFunction = (targetAddr, candidate = null, tab = 'pseudocode') => {
      if (targetAddr == null) return;
      const resolvedCandidate = candidate || findCandidateByAddr(targetAddr);
      const matchedPin = pinpointMatchesAddress(pin, targetAddr) ? pin : null;
      app.lastGoalContext = {
        targetAddr: BigInt(targetAddr),
        goal,
        candidate: resolvedCandidate,
        pinpoint: matchedPin,
        fields: result.context?.fields || null,
        setAt: Date.now(),
      };
      openFunction(app, sheet, targetAddr, tab);
    };
    if (pin?.top && pin.verdict !== VERDICT.NONE) {
      const answer = el('section', 'answer-summary');
      answer.append(el('h3', null, pick('最も強い答え', 'Strongest answer')));
      const strongest = describeStrongestAnswer(app, goal, pin, candidates);
      const { address, title, addrText, strongestReason, answerField } = strongest;
      const headingText = addrText && !title.includes(addrText) ? `${title} (${addrText})` : title;
      answer.append(el('div', 'fn-name', headingText));
      const hintParts = [verdictLabel(pin.verdict), strongestReason].filter(Boolean);
      answer.append(el('div', 'hint', hintParts.join(' · ')));
      if (answerField) {
        const fieldRow = list();
        fieldRow.append(tapRow(pick('このフィールドを使う場所', 'Where this field is used'), {
          sub:fieldLabel(answerField), right:'›', onTap:() => showField(app, answerField.className, answerField.field),
        }));
        answer.append(fieldRow);
      }
      if (address != null) {
        const quick = el('div', 'inv-actions-row');
        const pseudoBtn = el('button', 'btn sm', pick('疑似C', 'Pseudo-C'));
        pseudoBtn.type = 'button';
        pseudoBtn.addEventListener('click', () => openCandidateFunction(address, null, 'pseudocode'));
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
      onOpenFunction: (addr) => openCandidateFunction(addr, null, 'pseudocode'),
    });

    if (!candidates.length) {
      host.append(para(pick('条件に合う候補が見つかりませんでした。別の言い方や英単語で試してください。', 'No matching candidates found. Try different keywords.')));
      return;
    }
    host.append(el('div', 'sec-title', pick('候補一覧', 'Ranked candidates')));
    const rows = list();
    candidates.forEach((candidate, idx) => {
      const reasons = formatCandidateReasons(candidate.reasons, 2).join(' · ');
      const rankTag = idx < 3 ? `#${idx + 1}` : '';
      rows.append(tapRow(`${rankTag ? `${rankTag} ` : ''}${functionLabel(app, candidate.addr)}`, {
        sub:[addrHex(candidate.addr), reasons].filter(Boolean).join(' · '),
        right:'›',
        onTap:() => openCandidateFunction(candidate.addr, candidate, 'pseudocode'),
      }));
    });
    host.append(rows);
  }).catch((error) => {
    progress.done();
    if (isAbort(error) || !sheet.root.isConnected) return;
    const retryBtn = el('button', 'btn sm', pick('再試行', 'Retry'));
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', () => { sheet.close(); showCandidates(app, goal); });
    const rawMsg = String(error?.message || error);
    const friendly = reasonText(rawMsg);
    host.replaceChildren(friendly ? statusNotice(rawMsg) : para(pick('解析に失敗しました: ', 'Analysis failed: ') + rawMsg), retryBtn);
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
  const sheet = new Sheet(pick('このアプリを解析しています…', 'Analysing application…'), { onClose:() => controller.abort('overview-sheet-closed') });
  const progress = progressView(sheet.body, () => { controller.abort('user-cancelled'); sheet.close(); });
  const host = el('div'); sheet.body.append(host);

  investigationServiceFor(app).overview({
    signal:controller.signal,
    onProgress:(value) => { if (isCurrentBinary()) progress.update(value); },
  }).then((result) => {
    progress.done();
    if (controller.signal.aborted || !sheet.root.isConnected || !isCurrentBinary()) return;
    sheet.setTitle(pick('このアプリを解析しました', 'Application overview'));
    app.autoReport = { report:result.report, key:result.context.region?.id ?? null, gen:app.symbols?.gen, snapshotId:result.snapshotId };
    void app.persistAnalysisSession?.(['autoReport', 'lastGoal']);
    appendCompleteness(host, result, {
      app,
      onContinue: () => { sheet.close(); showOverview(app); },
    });
    const report = result.report;
    const summary = list();
    const functionTotal = Number(app?.symbols?.functionCount ?? report?.stats?.functions ?? 0);
    summary.append(tapRow(pick('関数', 'Functions'), { right:functionTotal.toLocaleString(), disabled:true }));
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
    const rawMsg = String(error?.message || error);
    const friendly = reasonText(rawMsg);
    host.replaceChildren(friendly ? statusNotice(rawMsg) : para(pick('解析に失敗しました: ', 'Analysis failed: ') + rawMsg));
  });
  return sheet;
}

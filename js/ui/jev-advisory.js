import { Sheet, el, button, list, tapRow, para, toast } from '../ui.js';
import { pick } from '../i18n.js';
import { pinpointField } from '../pinpoint.js';
import { cxxMemberIndexForApp } from '../analysis/query/app-adapter.js';
import { requestJevAlternative, requestJevFunctionAlternative } from '../analysis/query/jev-advisory.js';
import { addrHex } from '../format.js';
import { showField } from './panels/field-access.js';

// In-memory session key only (never persisted to localStorage or disk).
let sessionJevApiKey = '';

// Optional, user-requested alternative for anonymous C++ fields. Opening
// the result or recovering members never sends an external request.
export function appendJevAlternativeAction(app, goal, current, host, parentSignal, options = {}) {
  if (['confirmed', 'likely'].includes(current?.verdict)) return;
  const index = cxxMemberIndexForApp(app);
  const anonCandidates = Array.isArray(current?.candidates)
    ? current.candidates.filter(c => c?.source === 'cxx' && c.anonymous === true && !c.askedByName && !c.field?.conflict)
    : [];
  const hasAnonFieldMode = Boolean(index && index.fieldCount >= 2
    && (anonCandidates.length >= 2 || [...index.classes.values()].some(cls => cls.ivars.some(field => field.anonymous))));
  const rankedFunctions = Array.isArray(options?.rankedCandidates) ? options.rankedCandidates : [];
  const hasFunctionMode = !hasAnonFieldMode && rankedFunctions.length >= 2;
  if (!hasAnonFieldMode && !hasFunctionMode) return;
  const actions = list();
  actions.append(tapRow(pick('Jevで候補を再判定（任意）', 'Re-rank candidates with Jev (optional)'), {
    sub: pick('現在の結果を保ったまま、候補を高速比較します。', 'Compare recovered candidates without overwriting the local result.'),
    onTap: () => {
      let activeController = null;
      let keyInput;
      const abortActive = () => { activeController?.abort(parentSignal?.reason); };
      if (typeof parentSignal?.addEventListener === 'function') {
        parentSignal.addEventListener('abort', abortActive, { once: true });
      }
      const sheet = new Sheet(pick('Jevで再判定', 'Jev Re-ranking'), { onClose: () => {
        abortActive();
        if (typeof parentSignal?.removeEventListener === 'function') {
          parentSignal.removeEventListener('abort', abortActive);
        }
      } });
      sheet.body.append(para(pick(
        '質問と候補のクラス名・位置・型・関連関数名のみ送信します（バイナリ本体は送信しません）。',
        'Sends only the query and candidate metadata (class, offset, type, routine names). Binary bytes are never sent.')));
      keyInput = el('input'); keyInput.type = 'password'; keyInput.autocomplete = 'off';
      keyInput.value = sessionJevApiKey;
      keyInput.placeholder = 'OpenJev API key'; keyInput.setAttribute('aria-label', 'OpenJev API key');
      sheet.body.append(keyInput, para(pick('キーはメモリ上のみ保持し、ディスクには保存しません。', 'Key stays in memory for this session only and is never saved to disk.')));
      const status = el('div'); let running = false;
      const controls = el('div', 'chips');
      const cancelBtn = button(pick('キャンセル', 'Cancel'), 'chip', () => { activeController?.abort('user-cancelled'); });
      cancelBtn.hidden = true;
      const submit = button(pick('候補を比較する', 'Compare candidates'), 'chip strong', async () => {
        if (running || parentSignal?.aborted) return;
        const apiKey = keyInput.value.trim();
        if (!apiKey) {
          toast(pick('OpenJev APIキーを入力してください。', 'Enter an OpenJev API key first.'));
          keyInput.focus();
          return;
        }
        sessionJevApiKey = apiKey;
        const controller = new AbortController();
        activeController = controller;
        running = true; submit.disabled = true; cancelBtn.hidden = false;
        status.textContent = pick('候補を比較しています…', 'Comparing candidates…');
        const initialGen = app?.backend?.gen;
        const snapshot = index?.snapshotId, revision = index?.revision;
        const isCurrent = () => !controller.signal.aborted && !parentSignal?.aborted && sheet.root.isConnected
          && app?.backend?.gen === initialGen
          && (!hasAnonFieldMode || (cxxMemberIndexForApp(app) === index && index.snapshotId === snapshot && index.revision === revision));
        try {
          const phrase = String(goal?.text || goal?.ja || goal?.en || '');
          const result = hasAnonFieldMode
            ? await requestJevAlternative(phrase, anonCandidates.length >= 2
                ? { ...current, candidates: anonCandidates }
                : await pinpointField({ goal, cxxFields: index, symbols: app.symbols, binaryContextPreference: true, limit: 400 }),
              { enabled: true, mode: 'partial', apiKey, symbols: app.symbols, timeoutMs: 5000, signal: controller.signal, isCurrent })
            : await requestJevFunctionAlternative(phrase, rankedFunctions,
              { enabled: true, apiKey, symbols: app.symbols, timeoutMs: 5000, signal: controller.signal, isCurrent });
          if (!isCurrent()) return;
          const candidate = result.advisory.candidate;
          const conf = result.advisory.confidence;
          const confNote = typeof conf === 'number' && Number.isFinite(conf) ? ` (${Math.round(conf * 100)}%)` : '';
          status.textContent = candidate
            ? pick(`Jevの参考候補${confNote}です。ローカル結果は保持されています。`, `Jev suggestion${confNote}. Local result is unchanged.`)
            : pick('利用できる参考候補はありません。ローカル結果は保持されています。', 'No usable suggestion. Local result is unchanged.');
          if (candidate && hasAnonFieldMode) {
            const row = list(); row.append(tapRow(`${candidate.className}.${candidate.field.name}`, {
              sub: pick('アクセス元の処理と根拠を確認する', 'Inspect access routines and evidence'),
              onTap: () => showField(app, candidate.className, candidate.field),
            })); status.append(row);
          } else if (candidate && candidate.addr != null) {
            const label = app.symbols?.nameAt?.(candidate.addr) || `sub_${BigInt(candidate.addr).toString(16).toUpperCase()}`;
            const row = list(); row.append(tapRow(label, {
              sub: addrHex(BigInt(candidate.addr)),
              right: '›',
              onTap: () => {
                sheet.close();
                if (typeof options?.onOpenFunction === 'function') options.onOpenFunction(candidate.addr);
                else app.goToFunction?.(BigInt(candidate.addr));
              },
            })); status.append(row);
          }
        } catch (_) {
          if (isCurrent()) status.textContent = pick('参考候補を取得できませんでした。ローカル結果は保持されています。', 'Suggestion unavailable. Local result is unchanged.');
        } finally {
          running = false;
          activeController = null;
          cancelBtn.hidden = true;
          submit.disabled = !!parentSignal?.aborted;
        }
      });
      if (parentSignal?.aborted) submit.disabled = true;
      controls.append(submit, cancelBtn);
      sheet.body.append(controls, status);
    },
  }));
  host.append(actions);
}

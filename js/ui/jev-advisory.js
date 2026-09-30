import { Sheet, el, button, list, tapRow, para } from '../ui.js';
import { pick } from '../i18n.js';
import { pinpointField } from '../pinpoint.js';
import { cxxMemberIndexForApp } from '../analysis/query/app-adapter.js';
import { requestJevAlternative } from '../analysis/query/jev-advisory.js';
import { showField } from './panels/field-access.js';

// Optional, user-requested alternative for anonymous C++ fields only. Opening
// the result or recovering members never sends an external request.
export function appendJevAlternativeAction(app, goal, current, host, parentSignal) {
  const index = cxxMemberIndexForApp(app);
  if (!index || index.fieldCount < 2 || app.fields?.classCount > 0
    || ['confirmed', 'likely'].includes(current?.verdict)
    || [...index.classes.values()].some(cls => cls.ivars.some(field => !field.anonymous))) return;
  const actions = list();
  actions.append(tapRow(pick('Jevに別案を聞く（任意）', 'Ask Jev for an alternative (optional)'), {
    sub: pick('いまの結果を保ったまま、回収済みの候補を比較します。', 'Compare recovered candidates while keeping the current result.'),
    onTap: () => {
      const controller = new AbortController();
      let keyInput;
      const cancel = () => controller.abort();
      parentSignal?.addEventListener('abort', cancel, { once: true });
      const sheet = new Sheet(pick('Jevの参考案', 'Jev alternative'), { onClose: () => {
        controller.abort(); if (keyInput) keyInput.value = '';
        parentSignal?.removeEventListener('abort', cancel);
      } });
      sheet.body.append(para(pick(
        '質問と、クラス名・位置・型・関連する処理名をOpenJevへ送ります。バイナリ本体は送りません。参考案は正解の証明ではありません。',
        'Send your question, class names, offsets, types and related routine names to OpenJev. The binary file is not sent. A suggestion is not proof.')));
      keyInput = el('input'); keyInput.type = 'password'; keyInput.autocomplete = 'off';
      keyInput.placeholder = 'OpenJev API key'; keyInput.setAttribute('aria-label', 'OpenJev API key');
      sheet.body.append(keyInput, para(pick('キーは保存しません。', 'The key is not saved.')));
      const status = el('div'); let running = false;
      const submit = button(pick('候補を比較する', 'Compare candidates'), 'chip', async () => {
        if (running || !keyInput.value.trim() || controller.signal.aborted) return;
        running = true; submit.disabled = true;
        const apiKey = keyInput.value; keyInput.value = '';
        status.textContent = pick('候補を比較しています…', 'Comparing candidates…');
        const snapshot = index.snapshotId, revision = index.revision;
        const isCurrent = () => !controller.signal.aborted && !parentSignal?.aborted && sheet.root.isConnected
          && cxxMemberIndexForApp(app) === index && index.snapshotId === snapshot && index.revision === revision;
        try {
          const local = await pinpointField({ goal, cxxFields: index, symbols: app.symbols,
            binaryContextPreference: true, limit: 400 });
          const result = await requestJevAlternative(goal.text, local, { enabled: true, mode: 'partial',
            apiKey, symbols: app.symbols, signal: controller.signal, isCurrent });
          if (!isCurrent()) return;
          const candidate = result.advisory.candidate;
          status.textContent = candidate ? pick('参考案です。いまの結果は変更していません。', 'An alternative; the current result is unchanged.')
            : pick('利用できる参考案はありません。いまの結果は変更していません。', 'No usable alternative. The current result is unchanged.');
          if (candidate) {
            const row = list(); row.append(tapRow(`${candidate.className}.${candidate.field.name}`, {
              sub: pick('アクセス元の処理と、実際の証拠を確認する', 'Inspect access routines and actual evidence'),
              onTap: () => showField(app, candidate.className, candidate.field),
            })); status.append(row);
          }
        } catch (_) {
          if (isCurrent()) status.textContent = pick('参考案を取得できませんでした。いまの結果は変更していません。', 'Alternative unavailable. The current result is unchanged.');
        } finally { running = false; submit.disabled = false; }
      });
      sheet.body.append(submit, status);
    },
  }));
  host.append(actions);
}

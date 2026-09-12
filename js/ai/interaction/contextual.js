/*
 * Contextual "Ask AI" entries.
 *
 * Binary-derived strings, symbols, labels, and disassembly text are untrusted
 * evidence. Keep the user goal fixed and carry the selected target separately
 * so the model receives it under ContextBroker's untrusted-data boundary.
 */
import { menu } from '../../ui.js';
import { pick } from '../../i18n.js';
import { addrHex } from '../../format.js';

function ask(assistant, question, options) {
  assistant.open();
  assistant.ask(question, options);
}

function untrustedTarget(kind, { address, text, name, label } = {}) {
  const target = { kind, trust: 'untrusted-data' };
  if (address != null) target.address = addrHex(address);
  if (typeof text === 'string') target.text = text.slice(0, 2048);
  if (typeof name === 'string') target.name = name.slice(0, 1024);
  if (typeof label === 'string') target.label = label.slice(0, 1024);
  return Object.freeze(target);
}

export function instructionAiItems(assistant, { address, text }) {
  const target = untrustedTarget('instruction', { address, text });
  return [
    {
      label: pick('この命令を説明して', 'Explain this instruction'),
      action: () => ask(assistant, pick('選択した命令は何をしていますか？', 'What does the selected instruction do?'), { scope: 'selection', untrustedTarget: target }),
    },
    {
      label: pick('この値を追って', 'Trace this value'),
      action: () => ask(assistant, pick('選択した命令で扱っている値は、どこから来てどこへ行きますか？', 'Trace the value handled by the selected instruction: where does it come from and where does it go?'), { scope: 'function', untrustedTarget: target }),
    },
    {
      label: pick('なぜここに来るの？', 'Why is this reached?'),
      action: () => ask(assistant, pick('選択した命令に到達する条件を教えてください。', 'Under what conditions is the selected instruction reached?'), { scope: 'function', untrustedTarget: target }),
    },
  ];
}

export function functionAiItems(assistant, { address, name }) {
  const target = untrustedTarget('function', { address, name });
  return [
    {
      label: pick('この関数は何をしている？', 'What does this function do?'),
      action: () => ask(assistant, pick('選択した関数は何をする関数ですか？', 'What does the selected function do?'), { scope: 'function', untrustedTarget: target }),
    },
    {
      label: pick('役割を調べて（エージェント）', 'Investigate purpose (Agent)'),
      action: () => ask(assistant, pick('選択した関数の役割を、呼び出し元と書き込み先まで含めて調べてください。', 'Investigate the role of the selected function, including its callers and what it writes.'), { mode: 'agent', scope: 'neighborhood', untrustedTarget: target }),
    },
    {
      label: pick('名前を提案して', 'Suggest a name'),
      action: () => ask(assistant, pick('選択した関数にふさわしい名前を、根拠つきで提案してください。', 'Propose a name for the selected function with evidence.'), { scope: 'function', untrustedTarget: target }),
    },
  ];
}

export function stringAiItems(assistant, { text, address }) {
  const target = untrustedTarget('binary-string', { address, text });
  return [
    {
      label: pick('この文字列の使われ方', 'How this string is used'),
      action: () => ask(assistant, pick('選択したバイナリ文字列を使っているのはどの処理ですか？', 'Which code uses the selected binary string?'), { mode: 'agent', scope: 'binary', untrustedTarget: target }),
    },
  ];
}

export function fieldAiItems(assistant, { label }) {
  const target = untrustedTarget('field', { label });
  return [
    {
      label: pick('このフィールドを書いている場所', 'Who writes this field'),
      action: () => ask(assistant, pick('選択したフィールドに書き込んでいる処理を全部調べてください。', 'Find every routine that writes the selected field.'), { mode: 'agent', scope: 'binary', untrustedTarget: target }),
    },
    {
      label: pick('このフィールドを読んでいる場所', 'Who reads this field'),
      action: () => ask(assistant, pick('選択したフィールドを読んでいる処理を調べてください。', 'Find the routines that read the selected field.'), { mode: 'agent', scope: 'binary', untrustedTarget: target }),
    },
  ];
}

/** One row for a host menu; opens the assistant's own verbs next to it. */
export function askAiMenuItem(assistant, items, position) {
  return {
    label: pick('AI に聞く…', 'Ask AI…'),
    action: () => {
      const x = position && position.x != null ? position.x : window.innerWidth / 2;
      const y = position && position.y != null ? position.y : window.innerHeight / 2;
      menu(items, x, y);
    },
  };
}

export default askAiMenuItem;

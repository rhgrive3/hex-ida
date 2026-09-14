import assert from 'node:assert/strict';
import test from 'node:test';

import { explain } from '../../js/arm64.js';
import { lang, setLang } from '../../js/i18n.js';

function explainIn(language, mnemonic, operands = '') {
  const previous = lang();
  setLang(language);
  try {
    return explain(mnemonic, operands);
  } finally {
    setLang(previous);
  }
}

test('#3688 gives DMB, DSB, and ISB distinct bilingual semantics', () => {
  const dmb = explainIn('en', 'dmb', 'sy');
  const dsb = explainIn('en', 'dsb', 'sy');
  const isb = explainIn('en', 'isb');

  assert.equal(dmb.title, 'Data memory ordering barrier');
  assert.match(dmb.summary, /orders data-memory accesses/);
  assert.match(dmb.summary, /does not wait .*complete/);
  assert.doesNotMatch(dmb.summary, /instruction fetch/);

  assert.equal(dsb.title, 'Data synchronization barrier');
  assert.match(dsb.summary, /orders data-memory accesses/);
  assert.match(dsb.summary, /waits .*complete/);

  assert.equal(isb.title, 'Instruction synchronization barrier');
  assert.match(isb.summary, /instruction (?:stream|fetch|execution)/i);
  assert.match(isb.summary, /context-changing/);
  assert.match(isb.summary, /not a data-memory ordering barrier/);
  assert.doesNotMatch(isb.summary, /multiple threads/);

  assert.equal(new Set([dmb.title, dsb.title, isb.title]).size, 3);
  assert.equal(new Set([dmb.summary, dsb.summary, isb.summary]).size, 3);
  assert.deepEqual(dmb.terms, ['thread']);
  assert.deepEqual(dsb.terms, ['thread']);
  assert.deepEqual(isb.terms, []);

  const dmbJa = explainIn('ja', 'dmb', 'sy');
  const dsbJa = explainIn('ja', 'dsb', 'sy');
  const isbJa = explainIn('ja', 'isb');
  assert.match(dmbJa.summary, /データメモリアクセス.*順序/);
  assert.match(dmbJa.summary, /完了を待つ命令ではない/);
  assert.match(dsbJa.summary, /データメモリアクセス.*完了を待って/);
  assert.match(isbJa.summary, /コンテキスト変更/);
  assert.match(isbJa.summary, /命令ストリームを同期/);
  assert.doesNotMatch(isbJa.summary, /スレッド間のデータ順序付け/);
});

test('#3688 keeps finite option labels truthful and makes unknown options explicit', () => {
  const dmb = explainIn('en', 'dmb', 'ishst');
  assert.equal(dmb.pseudo, 'dmb(ishst)');
  assert.match(dmb.summary, /ishst/);
  assert.match(dmb.summary, /inner-shareable stores/);

  const isb = explainIn('en', 'isb', 'sy');
  assert.equal(isb.pseudo, 'isb(sy)');
  assert.match(isb.summary, /sy/);
  assert.match(isb.summary, /instruction-synchronization option/);
  assert.doesNotMatch(isb.summary, /full-system loads|data-memory scope/);

  const omitted = explainIn('en', 'isb');
  assert.equal(omitted.pseudo, 'isb()');
  assert.match(omitted.summary, /option omitted/);
  assert.match(omitted.summary, /default: sy/);

  const unknown = explainIn('en', 'dmb', 'future-option');
  assert.equal(unknown.pseudo, 'dmb(future-option)');
  assert.match(unknown.summary, /future-option/);
  assert.match(unknown.summary, /not interpreted/);
  assert.match(unknown.summary, /scope\/type/);

  const unknownJapanese = explainIn('ja', 'dmb', 'future-option');
  assert.match(unknownJapanese.summary, /future-option/);
  assert.match(unknownJapanese.summary, /未解釈/);

  for (const inheritedOption of ['constructor', '__proto__']) {
    const inherited = explainIn('en', 'dmb', inheritedOption);
    assert.equal(inherited.pseudo, `dmb(${inheritedOption})`);
    assert.match(inherited.summary, /not interpreted/);
    assert.match(inherited.summary, /scope\/type unknown/);
    assert.doesNotMatch(inherited.summary, /undefined/);
  }
});

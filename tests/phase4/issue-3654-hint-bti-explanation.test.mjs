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

test('#3654 does not explain every generic HINT as BTI', () => {
  const allocated = [
    ['#0', /NOP/, /does not .*branch target/],
    ['#1', /YIELD/, /not BTI/],
    ['#2', /WFE/, null],
    ['#3', /WFI/, null],
    ['#4', /SEV/, null],
    ['#5', /SEVL/, null],
    ['#16', /ESB/, null],
    ['#20', /CSDB/, null],
  ];
  for (const [operand, label, distinction] of allocated) {
    const result = explainIn('en', 'hint', operand);
    assert.equal(result.pseudo, `hint(${operand})`);
    assert.match(result.summary, label, `HINT ${operand} should retain its allocated hint name`);
    assert.doesNotMatch(result.summary, /Branch target marker/i);
    if (distinction) assert.match(result.summary, distinction);
  }

  const unknown = explainIn('en', 'hint', '#127');
  assert.equal(unknown.pseudo, 'hint(#127)');
  assert.match(unknown.title, /Architectural hint/);
  assert.match(unknown.summary, /HINT #127/);
  assert.match(unknown.summary, /not interpreted/);
  assert.doesNotMatch(unknown.summary, /Branch target marker/);

  const malformed = explainIn('en', 'hint', '#128');
  assert.match(malformed.summary, /HINT #128/);
  assert.doesNotMatch(malformed.summary, /Branch target marker/);

  const omitted = explainIn('en', 'hint');
  assert.equal(omitted.pseudo, 'hint()');
  assert.match(omitted.summary, /immediate unavailable/);
  assert.doesNotMatch(omitted.summary, /Branch target marker/);
});

test('#3654 keeps generic BTI encodings and decoded BTI mnemonics distinct from other HINTs', () => {
  for (const [operand, name] of [['#32', 'BTI'], ['#34', 'BTI c'], ['#36', 'BTI j'], ['#38', 'BTI jc']]) {
    const result = explainIn('en', 'hint', operand);
    assert.match(result.title, /Branch target marker/);
    assert.match(result.summary, new RegExp(name.replace(' ', '\\s+')));
  }

  for (const operands of ['', 'c', 'j', 'jc']) {
    const result = explainIn('en', 'bti', operands);
    assert.equal(result.title, 'Branch target marker');
    assert.match(result.summary, /legitimate branch target/);
  }
});

test('#3654 keeps the generic HINT distinction in Japanese', () => {
  const hint = explainIn('ja', 'hint', '#1');
  assert.match(hint.summary, /YIELD/);
  assert.match(hint.summary, /BTI ではありません/);

  const unknown = explainIn('ja', 'hint', '#127');
  assert.match(unknown.title, /アーキテクチャのヒント/);
  assert.match(unknown.summary, /解釈せず/);
  assert.match(unknown.summary, /BTI と決めつけません/);
  assert.doesNotMatch(unknown.summary, /分岐先を示す目印/);
});

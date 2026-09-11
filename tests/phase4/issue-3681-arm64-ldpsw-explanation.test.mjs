import test from 'node:test';
import assert from 'node:assert/strict';
import { explain } from '../../js/arm64.js';
import { lang, setLang } from '../../js/i18n.js';

function inEnglish(fn) {
  const previous = lang();
  setLang('en');
  try {
    return fn();
  } finally {
    setLang(previous);
  }
}

function explanationText(mnemonic, operands) {
  const out = explain(mnemonic, operands, 0n, {});
  assert.equal(out.handlerError, undefined, `${mnemonic} must explain without a handler error`);
  return [out.pseudo, out.summary, ...(out.detail || [])].filter(Boolean).join(' ');
}

test('LDPSW explains signed 32-bit pair loads and 64-bit sign extension', () => inEnglish(() => {
  const text = explanationText('ldpsw', 'x0, x1, [x2]');
  assert.match(text, /signed 32-bit word/i);
  assert.match(text, /4 bytes each, 8 bytes total/i);
  assert.match(text, /sign-extend|sign extension|sign_extend32/i);
  assert.doesNotMatch(text, /8 bytes each/i);
}));

test('LDPSW keeps 32-bit element semantics across offset and writeback addressing', () => inEnglish(() => {
  for (const operands of [
    'x0, x1, [x2, #16]',
    'x0, x1, [x2, #-8]!',
    'x0, x1, [sp], #8',
  ]) {
    const text = explanationText('ldpsw', operands);
    assert.match(text, /signed 32-bit word/i, operands);
    assert.match(text, /4 bytes each, 8 bytes total/i, operands);
    assert.match(text, /sign-extend|sign extension|sign_extend32/i, operands);
  }
}));

test('ordinary pair load/store explanations retain their existing element widths', () => inEnglish(() => {
  const ldpW = explanationText('ldp', 'w0, w1, [x2]');
  const ldpX = explanationText('ldp', 'x0, x1, [x2]');

  setLang('ja');
  try {
    const ldpWJa = explanationText('ldp', 'w0, w1, [x2]');
    const ldpXJa = explanationText('ldp', 'x0, x1, [x2]');
    assert.match(ldpWJa, /4 バイト（32 ビット）/);
    assert.match(ldpXJa, /8 バイト（64 ビット）/);
  } finally {
    setLang('en');
  }

  for (const [mnemonic, operands] of [
    ['ldnp', 'x0, x1, [x2]'],
    ['stp', 'x0, x1, [x2]'],
    ['stnp', 'x0, x1, [x2]'],
  ]) {
    const text = explanationText(mnemonic, operands);
    assert.doesNotMatch(text, /signed 32-bit word/i, `${mnemonic} must not inherit LDPSW semantics`);
  }
  assert.doesNotMatch(ldpW, /sign_extend32/i);
  assert.doesNotMatch(ldpX, /sign_extend32/i);
}));

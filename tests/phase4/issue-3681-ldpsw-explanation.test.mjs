import assert from 'node:assert/strict';
import { explain } from '../../js/arm64.js';
import { lang, setLang } from '../../js/i18n.js';

const previousLanguage = lang();
try {
  setLang('en');

  for (const operands of [
    'x0, x1, [x2]',
    'x0, x1, [x2, #8]!',
    'x0, x1, [x2], #8',
  ]) {
    const result = explain('ldpsw', operands, 0n, {});
    assert.match(result.summary, /two signed 32-bit values/i, `${operands} must describe 32-bit memory elements`);
    assert.match(result.summary, /8 bytes total/i, `${operands} must describe the pair's total memory span`);
    assert.match(result.summary, /sign-extend each to 64 bits/i, `${operands} must describe sign extension`);
    assert.equal(result.title, 'Load and sign-extend a pair');
  }

  assert.equal(explain('ldp', 'w0, w1, [x2]', 0n, {}).summary, 'Read two values into w0 and w1.');
  assert.equal(explain('ldp', 'x0, x1, [x2]', 0n, {}).summary, 'Read two values into x0 and x1.');
  assert.equal(explain('ldnp', 'x0, x1, [x2]', 0n, {}).summary, 'Read two values into x0 and x1.');
  assert.equal(explain('stp', 'x0, x1, [x2]', 0n, {}).summary, 'Write x0 and x1 side by side.');
  assert.equal(explain('stnp', 'x0, x1, [x2]', 0n, {}).summary, 'Write x0 and x1 side by side.');

  const stackPost = explain('ldpsw', 'x29, x30, [sp], #8', 0n, {});
  assert.equal(stackPost.title, 'Load and sign-extend a pair');
  assert.match(stackPost.summary, /signed 32-bit values/i);
  assert.doesNotMatch(stackPost.summary, /Take .* back off the stack/i);

  setLang('ja');
  const japanese = explain('ldpsw', 'x0, x1, [x2]', 0n, {});
  assert.match(japanese.summary, /4 バイト（32 ビット）/);
  assert.match(japanese.summary, /合計 8 バイト（64 ビット）/);
  assert.match(japanese.summary, /64 ビットへ符号拡張/);
} finally {
  setLang(previousLanguage);
}

console.log('issue-3681-ldpsw-explanation: PASS');

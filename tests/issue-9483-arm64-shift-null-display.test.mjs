// Regression test for Issue #9483:
// shiftText() and presentation explainer must not display raw "null" literals when shift amount is omitted.
import assert from 'node:assert/strict';
import { explain } from '../js/arm64.js';
import { setLang } from '../js/i18n.js';
import { parseOperands, memExpr, opShort } from '../js/ui/explain/arm64-operands.js';

// 1. Japanese locale verification
setLang('ja');

{
  const res = explain('ldr', 'x0, [x1, x2, lsl]', 0x1000n);
  assert.equal(
    res.summary,
    'x1 と x2 を足したアドレスから 8 バイト（64 ビット） 読み込み、x0 に入れる。'
  );
  assert.equal(res.pseudo, 'x0 = *(uint64*)(x1 + x2)');
  assert.doesNotMatch(res.summary, /null/);
  assert.doesNotMatch(res.pseudo, /null/);
}

{
  const res = explain('ldr', 'x0, [x1, x2, lsr]', 0x1000n);
  assert.equal(
    res.summary,
    'x1 と x2 を足したアドレスから 8 バイト（64 ビット） 読み込み、x0 に入れる。'
  );
  assert.doesNotMatch(res.summary, /null/);
}

{
  const res = explain('ldr', 'x0, [x1, x2, asr]', 0x1000n);
  assert.equal(
    res.summary,
    'x1 と x2 を足したアドレスから 8 バイト（64 ビット） 読み込み、x0 に入れる。'
  );
  assert.doesNotMatch(res.summary, /null/);
}

{
  const res = explain('ldr', 'x0, [x1, x2, ror]', 0x1000n);
  assert.equal(
    res.summary,
    'x1 と x2 を足したアドレスから 8 バイト（64 ビット） 読み込み、x0 に入れる。'
  );
  assert.doesNotMatch(res.summary, /null/);
}

{
  // Explicit shift amount should still render
  const res = explain('ldr', 'x0, [x1, x2, lsl #2]', 0x1000n);
  assert.equal(
    res.summary,
    'x1 と x2（左へ 2 ビットずらす＝ 4 倍してから） を足したアドレスから 8 バイト（64 ビット） 読み込み、x0 に入れる。'
  );
}

// 2. English locale verification
setLang('en');

{
  const res = explain('add', 'x0, x1, x2, lsl', 0x1000n);
  assert.equal(res.summary, 'Add x2 to x1, result in x0.');
  assert.equal(res.pseudo, 'x0 = x1 + x2');
  assert.doesNotMatch(res.summary, /null/);
  assert.doesNotMatch(res.pseudo, /null/);
}

{
  const res = explain('ldr', 'x0, [x1, x2, lsl]', 0x1000n);
  assert.equal(res.summary, 'Read 8 bytes from x1 + x2 into x0.');
  assert.equal(res.pseudo, 'x0 = *(uint64*)(x1 + x2)');
  assert.doesNotMatch(res.summary, /null/);
  assert.doesNotMatch(res.pseudo, /null/);
}

// 3. Direct presentation adapter check
{
  const mem = parseOperands('[x1, x2, lsl]')[0];
  assert.equal(memExpr(mem), 'x1 + x2');
  assert.equal(opShort(mem), '[x1 + x2]');
}

// Restore default lang
setLang('ja');

console.log('issue #9483 regression passed');

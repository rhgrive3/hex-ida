// Issue #5368 regression: recognizeObjcBlockLiteral() rejected only
// invoke == null, so a Block_layout whose invoke field is the null function
// pointer (0 / 0n / numeric-zero text) was published as valid block evidence
// with confidence 0.72. A null invoke cannot be a block: reject it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { recognizeObjcBlockLiteral } from '../js/apple/objc-runtime.js';

test('#5368 null invoke pointers are not block evidence', () => {
  for (const invoke of [0, 0n, '0', '0x0']) {
    const result = recognizeObjcBlockLiteral(new Map([[0x10, invoke]]));
    assert.equal(result, null, `invoke ${String(invoke)} must not be recognized as a valid Block literal`);
  }
});

test('#5368 a non-null invoke keeps the existing recognition contract', () => {
  const result = recognizeObjcBlockLiteral(new Map([[0x10, 0x1234n]]));
  assert.ok(result, 'non-null invoke still recognizes');
  assert.equal(result.kind, 'block');
  assert.equal(result.invoke, 0x1234n);
  assert.equal(result.confidence, 0.72, 'isa/descriptor-less block keeps its legacy confidence');
});

test('#5368 the null-invoke rule applies to 32-bit layouts too', () => {
  // Code contract: invokeOffset = pointerSize + 8 = 12 for 32-bit layouts.
  assert.equal(recognizeObjcBlockLiteral(new Map([[0xc, 0]]), { pointerSize: 4 }), null);
  const ok = recognizeObjcBlockLiteral(new Map([[0xc, 0x4000n]]), { pointerSize: 4 });
  assert.ok(ok);
});

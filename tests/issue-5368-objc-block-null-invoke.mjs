// Issue #5368 regression: recognizeObjcBlockLiteral() rejected only
// invoke == null, so a Block_layout whose invoke field is the null function
// pointer (0 / 0n / numeric-zero text) was published as valid block evidence
// with confidence 0.72. A null invoke cannot be a block: reject it.
// Review round 2: invoke must be a CANONICAL NON-NEGATIVE ADDRESS — negatives,
// fractional/unsafe numbers, and non-address spellings fail closed to null
// WITHOUT throwing (BigInt(1.5) must never RangeError out of the recognizer).
import assert from 'node:assert/strict';
import test from 'node:test';

import { recognizeObjcBlockLiteral } from '../js/apple/objc-runtime.js';

test('#5368 null invoke pointers are not block evidence', () => {
  for (const invoke of [0, 0n, '0', '0x0']) {
    const result = recognizeObjcBlockLiteral(new Map([[0x10, invoke]]));
    assert.equal(result, null, `invoke ${String(invoke)} must not be recognized as a valid Block literal`);
  }
});

test('#5368 negative, fractional, unsafe and non-address invokes fail closed without throwing', () => {
  for (const invoke of [-1, -1n, -0x10n, 1.5, -1.5, Number.MAX_SAFE_INTEGER + 1, 'abc', '', true, {}, null]) {
    const result = recognizeObjcBlockLiteral(new Map([[0x10, invoke]]));
    assert.equal(result, null, `invoke ${String(invoke)} must fail closed to null, not throw or recognize`);
  }
});

test('#5368 canonical address spellings stay valid invoke evidence', () => {
  for (const invoke of [0x1234n, 4660, '0x1234', '4660', '  0x1234  ']) {
    const result = recognizeObjcBlockLiteral(new Map([[0x10, invoke]]));
    assert.ok(result, `invoke ${String(invoke)} is a canonical non-negative address and recognizes`);
    assert.equal(result.kind, 'block');
    assert.equal(result.invoke, invoke, 'raw invoke value is preserved verbatim');
  }
  // Full-width 64-bit control values stay valid via bigint/string spellings.
  const wide = recognizeObjcBlockLiteral(new Map([[0x10, 0xfffffffffffffffcn]]));
  assert.ok(wide, '64-bit invoke pointer recognizes');
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

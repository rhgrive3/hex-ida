import assert from 'node:assert/strict';
import test from 'node:test';

import { renderNZCVCondition } from '../../../js/decompiler/flag-semantics.js';

test('#5247 floating NZCV comparisons render without integer signedness casts', () => {
  // Equality across the full floating domain.
  assert.equal(renderNZCVCondition('fsub', 'eq', 'a', 'b', 32), 'a == b');
  assert.equal(renderNZCVCondition('fsub', 'ne', 'a', 'b', 64), 'a != b');
  // Ordered relations, including the FCMP aliases (V=0 makes LT≡MI, LE≡LS).
  assert.equal(renderNZCVCondition('fsub', 'lt', 'a', 'b', 32), 'a < b');
  assert.equal(renderNZCVCondition('fsub', 'mi', 'a', 'b', 32), 'a < b');
  assert.equal(renderNZCVCondition('fsub', 'le', 'a', 'b', 64), 'a <= b');
  assert.equal(renderNZCVCondition('fsub', 'ls', 'a', 'b', 64), 'a <= b');
  assert.equal(renderNZCVCondition('fsub', 'ge', 'a', 'b', 32), 'a >= b');
  assert.equal(renderNZCVCondition('fsub', 'gt', 'a', 'b', 32), 'a > b');
  for (const text of ['(uint32_t)a == (uint32_t)b', '(int32_t)a < (int32_t)b', '(int64_t)a >= (int64_t)b']) {
    const rendered = [
      renderNZCVCondition('fsub', 'eq', 'a', 'b', 32),
      renderNZCVCondition('fsub', 'lt', 'a', 'b', 32),
      renderNZCVCondition('fsub', 'ge', 'a', 'b', 64),
    ];
    assert.ok(!rendered.includes(text), `floating comparison must not be printed as ${text}: ${rendered}`);
  }
});

test('#5247 integer NZCV comparisons keep their signedness views', () => {
  assert.equal(renderNZCVCondition('sub', 'eq', 'a', 'b', 32), '(uint32_t)a == (uint32_t)b');
  assert.equal(renderNZCVCondition('sub', 'lt', 'a', 'b', 32), '(int32_t)a < (int32_t)b');
  assert.equal(renderNZCVCondition('sub', 'ge', 'a', 'b', 64), '(int64_t)a >= (int64_t)b');
});

test('#5247 unordered/flag-only FP conditions stay on the exact intrinsic', () => {
  // VS/VC/HS/HI involve unordered or carry semantics a plain C comparison
  // cannot express; they must not lose the flag boundary. The operand view
  // inside the intrinsic is the pre-existing #6204 contract and is unchanged.
  assert.equal(renderNZCVCondition('fsub', 'vs', 'a', 'b', 32), '__arm64_nzcv_fsub_vs_32((uint32_t)a, (uint32_t)b)');
  assert.equal(renderNZCVCondition('fsub', 'vc', 'a', 'b', 32), '__arm64_nzcv_fsub_vc_32((uint32_t)a, (uint32_t)b)');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOperands, opShort } from '../../js/ui/explain/arm64-operands.js';

/**
 * ARM64 presentation operand parser hardening (same owner:
 * js/ui/explain/arm64-operands.js). Invalid spellings must fail soft to
 * `other` instead of being promoted to register / memory DTOs.
 */

const kind = (input) => parseOperands(input)[0]?.k;

test('#5340 x31/w31 are not general-purpose registers', () => {
  assert.equal(kind('x31'), 'other');
  assert.equal(kind('w31'), 'other');
  assert.equal(parseOperands('x30')[0]?.cls, 'gp');
  assert.equal(parseOperands('w30')[0]?.cls, 'gp');
  assert.equal(parseOperands('xzr')[0]?.cls, 'zr');
  assert.equal(parseOperands('sp')[0]?.cls, 'sp');
});

test('#5449 non-existent vector arrangements are rejected', () => {
  for (const bad of ['v0.0b', 'v0.99b', 'v0.3s', 'v0.2q', 'v0.5d']) assert.equal(kind(bad), 'other', `${bad} must fail soft`);
  for (const good of ['v0.8b', 'v0.16b', 'v0.4h', 'v0.8h', 'v0.2s', 'v0.4s', 'v0.1d', 'v0.2d', 'v31.16b', 'v0']) {
    assert.equal(kind(good), 'reg', `${good} must remain a register`);
  }
});

test('#5342 SIMD/FP registers cannot be a memory base', () => {
  for (const bad of ['[v0]', '[d0]', '[q0]', '[s1]', '[h2]', '[b3]', '[w0]']) assert.equal(kind(bad), 'other', `${bad} must fail soft`);
  for (const good of ['[x0]', '[x30]', '[sp]', '[x0, #0x10]', '[x0, x1]', '[x0, w1, uxtw #2]']) {
    assert.equal(kind(good), 'mem', `${good} must remain a memory operand`);
  }
});

test('#5348 unbalanced memory operands are rejected', () => {
  assert.equal(kind('[x1'), 'other');
  assert.equal(kind('[x0, #8'), 'other');
  assert.equal(kind('[x0]'), 'mem');
  assert.equal(kind('[x0, #-16]!'), 'mem');
});

test('#5351 duplicate displacement/index components are rejected, not rewritten', () => {
  assert.equal(kind('[x1, #8, #16]'), 'other');
  assert.equal(kind('[x1, x2, x3]'), 'other');
  const single = parseOperands('[x1, #8]')[0];
  assert.equal(single.k, 'mem');
  assert.equal(single.disp.value, 8n);
  assert.equal(opShort(single), '[x1 + 8]');
});

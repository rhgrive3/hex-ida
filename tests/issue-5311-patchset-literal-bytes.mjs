// Issue #5311 regression: PatchSet.add() normalized before/after bytes with
// Uint8Array.from(), whose modulo/truncation coercion laundered schema-invalid
// values into different valid bytes (256 -> 0, 257 -> 1, -1 -> 255, 1.5 -> 1,
// '1' -> 1, true -> 1). The stored patch then no longer matched the caller's
// request. Patch bytes are literal integers 0..255, fail-closed.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PatchSet } from '../js/patch.js';

test('#5311 literal bytes 0 and 255 are accepted', () => {
  const p = new PatchSet();
  p.add(0n, [0, 255], [255, 0]);
  const item = [...p.items.values()][0];
  assert.deepEqual([...item.before], [0, 255]);
  assert.deepEqual([...item.after], [255, 0]);
});

test('#5311 out-of-range, fractional, negative, and non-number bytes are rejected', () => {
  for (const bad of [256, 257, -1, 1.5, NaN, Infinity, true, false, '1', null]) {
    const p = new PatchSet();
    assert.throws(() => p.add(0n, [bad], [1]), TypeError, `before byte ${String(bad)} must be rejected`);
    const q = new PatchSet();
    assert.throws(() => q.add(0n, [1], [bad]), TypeError, `after byte ${String(bad)} must be rejected`);
  }
});

test('#5311 the stored patch matches the request, never a coerced variant', () => {
  const p = new PatchSet();
  assert.throws(() => p.add(0n, [256], [257]), TypeError);
  assert.equal(p.size, 0, 'no patch may be minted from coercible bytes');
});

test('#5311 an existing Uint8Array is still accepted', () => {
  const p = new PatchSet();
  p.add(0n, new Uint8Array([0x12]), new Uint8Array([0x34]));
  const item = [...p.items.values()][0];
  assert.deepEqual([...item.before], [0x12]);
  assert.deepEqual([...item.after], [0x34]);
});

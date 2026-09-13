// Issue #4337 regression: finiteStrength()/finitePositiveLr() normalized
// evidence strength and likelihood ratio through Number(value), so
// Array/boolean/numeric-string values were promoted to legitimate
// probability authority in evidence(), adapterEvidence() and fuse().
import assert from 'node:assert/strict';
import test from 'node:test';

import { evidence, adapterEvidence, fuse } from '../js/evidence.js';

test('#4337 evidence() rejects structured strength/lr instead of Number()-coercing them', () => {
  for (const bad of [['1'], ['0.8'], true, false, {}, { valueOf: () => 0.5 }, '1', '0.8', ' 1 ', '1e3', '0x1']) {
    const item = evidence('no-such-code', bad, null, bad);
    assert.equal(item.strength, 0, `strength ${String(bad)} must fall back, not coerce`);
    assert.equal(item.lr, 1, `lr ${String(bad)} must fall back, not coerce`);
  }
});

test('#4337 evidence() keeps canonical number strength/lr math', () => {
  assert.equal(evidence('no-such-code', 1).strength, 1);
  assert.equal(evidence('no-such-code', 0.5).strength, 0.5);
  assert.equal(evidence('no-such-code', 2).strength, 1, 'clamps to 1');
  assert.equal(evidence('no-such-code', -1).strength, 0, 'clamps to 0');
  assert.equal(evidence('no-such-code').strength, 1, 'nullish defaults to 1');
  assert.equal(evidence('fn-numeric').lr, 2.2, 'table default lr');
  assert.equal(evidence('fn-numeric', 1, null, 30).lr, 30);
  assert.equal(evidence('fn-numeric', 1, null, 0.5).lr, 0.5, 'fractional lr preserved');
  assert.equal(evidence('fn-numeric', 1, null, 0).lr, 2.2, 'zero lr falls back');
  assert.equal(evidence('fn-numeric', 1, null, -3).lr, 2.2, 'negative lr falls back');
  assert.equal(evidence('fn-numeric', 1, null, NaN).lr, 2.2, 'NaN lr falls back');
  assert.equal(evidence('fn-numeric', 1, null, Infinity).lr, 2.2, 'non-finite lr falls back');
});

test('#4337 adapterEvidence() rejects structured strength/lr', () => {
  for (const bad of [['1000000'], true, '1000000', {}]) {
    const item = adapterEvidence('runtime-field-verified', bad, {}, bad);
    assert.equal(item.strength, 0);
    assert.equal(item.lr, 1);
  }
});

test('#4337 fuse() neutralizes structured strength/lr minted through evidence()', () => {
  const forged = evidence('fn-numeric', ['1'], null, ['1000000']);
  const neutral = evidence('fn-numeric', null);
  assert.equal(forged.strength, 0);
  assert.equal(forged.lr, 2.2);
  const fused = fuse([forged, evidence('no-such-code', true, null, '500')], { candidates: 1000 });
  const baseline = fuse([], { candidates: 1000 });
  assert.equal(fused.probability, baseline.probability, 'structured authority must not move log odds');
  assert.equal(neutral.lr, 2.2);
});

test('#4337 canonical number evidence still moves fusion the same way', () => {
  const strong = fuse([evidence('fn-numeric', 1, null, 20)], { candidates: 1000 });
  const weak = fuse([evidence('fn-numeric', 0.5, null, 20)], { candidates: 1000 });
  const baseline = fuse([], { candidates: 1000 });
  assert.ok(strong.probability > baseline.probability);
  assert.ok(weak.probability > baseline.probability);
  assert.ok(strong.probability > weak.probability, 'strength scaling formula preserved');
});

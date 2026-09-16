// Issue #4338 regression: exclusiveLR()/rarityLR() fed total/users/matching/
// score straight into Math.max, division and comparison, so Array/boolean/
// numeric-string values became legitimate observation counts and produced
// high likelihood ratios that flow into fuse().
import assert from 'node:assert/strict';
import test from 'node:test';

import { evidence, fuse, exclusiveLR, rarityLR } from '../js/evidence.js';

test('#4338 exclusiveLR rejects structured counts and score', () => {
  assert.equal(exclusiveLR(['1000'], ['1'], ['1'], 'damage %d'), 0);
  assert.equal(exclusiveLR('1000', '1', '1', 'damage %d'), 0);
  assert.equal(exclusiveLR(true, true, true, 'damage %d'), 0);
  assert.equal(exclusiveLR({}, {}, {}, 'damage %d'), 0);
  assert.equal(exclusiveLR(1000, 1, Infinity, 'damage %d'), 0);
  assert.equal(exclusiveLR(1000, NaN, 1, 'damage %d'), 0);
  assert.equal(exclusiveLR(NaN, 1, 1, 'damage %d'), 0);
  assert.equal(exclusiveLR(1000.5, 1, 1, 'damage %d'), 0);
  assert.equal(exclusiveLR(1000, 1.5, 1, 'damage %d'), 0);
  assert.equal(exclusiveLR(-5, 1, 1, 'damage %d'), 0);
  assert.equal(exclusiveLR(1000, -1, 1, 'damage %d'), 0);
});

test('#4338 rarityLR rejects structured counts', () => {
  assert.equal(rarityLR(['1000'], ['1']), 0);
  assert.equal(rarityLR('1000', '1'), 0);
  assert.equal(rarityLR(true, true), 0);
  assert.equal(rarityLR({}, {}), 0);
  assert.equal(rarityLR(1000, Infinity), 0);
  assert.equal(rarityLR(1000.5, 1), 0);
  assert.equal(rarityLR(1000, -4), 0);
});

test('#4338 exclusiveLR keeps canonical count math, caps and thresholds', () => {
  assert.equal(exclusiveLR(1000, 1, 0.95, 'damage %d'), 250);
  assert.equal(exclusiveLR(1000, 2, 0.95, 'damage %d'), 125);
  assert.equal(exclusiveLR(1000, 3, 0.95, 'damage %d'), 0, 'EXCLUSIVE_MAX_USERS preserved');
  assert.equal(exclusiveLR(1000, 1, 0.89, 'damage %d'), 0, 'EXCLUSIVE_MIN_SCORE preserved');
  assert.equal(exclusiveLR(1e9, 1, 1, 'damage %d'), 1e5, 'LR cap preserved');
  assert.equal(exclusiveLR(0, 0, 1, 'damage %d'), 1, 'zero counts keep legacy defaults');
  assert.equal(exclusiveLR(undefined, undefined, 1, 'damage %d'), 1, 'nullish counts keep legacy defaults');
  assert.equal(exclusiveLR(1000, 1, 1, 'skill_wave_attack.maanim'), 0, 'material names still not naming');
});

test('#4338 rarityLR keeps canonical count math and caps', () => {
  assert.equal(rarityLR(342, 4), (342 / 4) * 0.3);
  assert.equal(rarityLR(1e6, 1), 1e4, 'rarity cap preserved');
  assert.equal(rarityLR(2, 2), 0, 'k>=n preserved');
  assert.equal(rarityLR(0, 0), 1, 'zero counts keep legacy defaults');
});

test('#4338 invalid observations cannot raise fused probability', () => {
  const poisoned = fuse([evidence('fn-string-exclusive', 1, {}, exclusiveLR(['1000'], ['1'], ['1'], 'damage %d'))], { candidates: 1000 });
  const neutral = fuse([evidence('fn-string-exclusive', 1, {}, 0)], { candidates: 1000 });
  assert.equal(poisoned.probability, neutral.probability, 'structured counts must fall back to the table default, not a coerced 250');
});

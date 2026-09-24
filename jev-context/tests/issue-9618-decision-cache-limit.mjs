import assert from 'node:assert/strict';
import { createDecisionCache } from '../core/decision-cache.mjs';

const decision = { action: 'keep', confidence: 1, dropProbability: 0, reason: 'test', timestamp: 1 };
for (const maxEntries of [-1, 0, 0.5, Infinity, -Infinity, Number.NaN, '-1', '2', true, {}]) {
  const cache = createDecisionCache({ policyVersion: 'v1', maxEntries });
  cache.set('digest-a', decision);
  assert.equal(cache.summary().size, 1, `invalid maxEntries must not self-evict: ${String(maxEntries)}`);
  assert.equal(cache.get('digest-a')?.a, 'keep', `stored digest must hit: ${String(maxEntries)}`);
}

const bounded = createDecisionCache({ policyVersion: 'v1', maxEntries: 2 });
bounded.set('a', decision);
bounded.set('b', decision);
bounded.set('c', decision);
assert.equal(bounded.summary().size, 2);
assert.equal(bounded.get('a'), null, 'oldest insertion must be evicted at the configured integer capacity');
assert.equal(bounded.get('b')?.a, 'keep');
assert.equal(bounded.get('c')?.a, 'keep');
console.log('issue #9618 decision-cache maxEntries: PASS');

import test from 'node:test';
import assert from 'node:assert/strict';

import { __investigationInternalsForTests } from '../js/analysis/investigation-service.js';

// #4071: the pinpoint cache key is only the (snapshot, goal.id, goal.text)
// tuple, so a pin produced under `budget.pinpoint: 1` / `limit: 1` was served
// verbatim to a later high-budget query for the same snapshot and goal. The
// reuse gate must therefore bind every input that changes what a cached pin
// means: the effective pinpoint budget and the ranking limit that bounds the
// candidate universe.

const { pinCacheKey, pinRequestIdentity, pinRequestMatches } = __investigationInternalsForTests;

const context = Object.freeze({
  fields: null, shapes: null, program: null, symbols: null, strings: null, region: null,
});
const goal = Object.freeze({ id: 'hp', text: 'HP', expects: { numeric: true, store: true } });

test('#4071 the goal-tuple cache key alone cannot distinguish budget profiles', () => {
  const lowKey = pinCacheKey('snap-1', goal);
  const highKey = pinCacheKey('snap-1', goal);
  assert.equal(lowKey, highKey, 'the tuple key is budget/limit independent by design');
  assert.notEqual(pinCacheKey('snap-1', goal), pinCacheKey('snap-2', goal));
});

test('#4071 a low-budget pin must not authorize a high-budget query', () => {
  const low = pinRequestIdentity(context, goal, { budget: { pinpoint: 1 }, limit: 1 });
  const high = pinRequestIdentity(context, goal, { budget: { pinpoint: 48 }, limit: 40 });
  assert.equal(low.pinpointBudget, 1);
  assert.equal(high.pinpointBudget, 48);
  assert.equal(low.rankingLimit, 1);
  assert.equal(high.rankingLimit, 40);
  assert.equal(pinRequestMatches(low, high), false, 'budget 1 cache must not satisfy budget 48');
  assert.equal(pinRequestMatches(high, low), false, 'a richer cached pin must not be laundered into a narrower request profile');
});

test('#4071 limit alone changes the pin request identity', () => {
  const narrow = pinRequestIdentity(context, goal, { budget: { pinpoint: 48 }, limit: 1 });
  const wide = pinRequestIdentity(context, goal, { budget: { pinpoint: 48 }, limit: 40 });
  assert.equal(pinRequestMatches(narrow, wide), false, 'the candidate universe bound must be part of cache identity');
});

test('#4071 an identical request profile still reuses the cached pin', () => {
  const first = pinRequestIdentity(context, goal, { budget: { pinpoint: 12 }, limit: 20 });
  const second = pinRequestIdentity(context, goal, { budget: { pinpoint: 12 }, limit: 20 });
  assert.equal(pinRequestMatches(first, second), true, 'same-profile queries must keep caching');
});

test('#4071 missing budget/limit options normalize to the documented defaults', () => {
  const omitted = pinRequestIdentity(context, goal, {});
  const explicit = pinRequestIdentity(context, goal, { budget: { pinpoint: 48 }, limit: 40 });
  assert.equal(omitted.pinpointBudget, 48);
  assert.equal(omitted.rankingLimit, 40);
  assert.equal(pinRequestMatches(omitted, explicit), true, 'defaulted and explicit profiles must agree');
});

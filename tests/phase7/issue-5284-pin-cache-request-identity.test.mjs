import test from 'node:test';
import assert from 'node:assert/strict';

import { InvestigationService, __investigationInternalsForTests } from '../../js/analysis/investigation-service.js';

const { pinRequestIdentity, pinRequestMatches } = __investigationInternalsForTests;

// #5284: the pinpoint cache identity must bind every input that changes what
// the pin means. Reuse was keyed only on snapshotId/goal.id/goal.text, so a
// wide-evidence, wider-ranking, or high-budget re-investigation silently reused
// a pin computed under narrower semantics. The stored request identity
// (canonical `expects` digest + effective ranking/pinpoint budgets + evidence
// coverage) must gate cache reuse: any semantic change re-runs pinpoint; an
// identical canonical request stays a hit. Keys stay per goal tuple (#5610);
// pin entries stay pin-valued and snapshot-scoped (#4062).

function fixtureApp() {
  return {
    backend: { gen: 1 },
    store: { get: () => null },
    symbols: null,
    stringIndex: Object.assign([], { complete: true, __lookup: () => null }),
    fields: { classCount: 1, classes: new Map() },
    ensureShapes: async () => null,
    analysisQueries: {
      snapshot: async () => ({ snapshotId: 'snapshot-A' }),
      binaryInfo: async () => ({})
    }
  };
}

function onlyCacheKey(service) {
  const keys = [...service.pinRequestIdentityCache.keys()];
  assert.equal(keys.length, 1, 'fixture must have one pin request identity');
  return keys[0];
}

test('#5284 same snapshot/id/text with different expects re-runs pinpoint', async () => {
  const service = new InvestigationService(fixtureApp());
  const goalA = { id: 'custom', text: 'target field', expects: { call: true } };
  const goalB = { id: 'custom', text: 'target field', expects: { numeric: true, store: true } };

  await service.investigate(goalA);
  const cacheKey = onlyCacheKey(service);
  const sentinel = Object.freeze({ sentinel: 'expects-cache-hit' });
  service.pinCache.set(cacheKey, sentinel);
  const second = await service.investigate(goalB);

  assert.notEqual(second.pin, sentinel,
    'a different expects selector must re-run pinpoint instead of returning the cached sentinel');
  assert.equal(service.pinCache.size, 1,
    'the goal tuple owns one cache entry, replaced when its identity changes');
});

test('#5284 a higher pinpoint budget re-runs pinpoint instead of reusing the low-budget pin', async () => {
  const service = new InvestigationService(fixtureApp());
  const goal = { id: 'custom', text: 'target field' };

  await service.investigate(goal, { budget: { pinpoint: 1 } });
  const cacheKey = onlyCacheKey(service);
  const sentinel = Object.freeze({ sentinel: 'low-budget-cache-hit' });
  service.pinCache.set(cacheKey, sentinel);
  const widened = await service.investigate(goal, { budget: { pinpoint: 48 } });

  assert.notEqual(widened.pin, sentinel,
    'the high-budget request must actually re-run pinpoint instead of returning the low-budget cached sentinel');
  const identities = [...service.pinRequestIdentityCache.values()].map((identity) => identity.pinpointBudget);
  assert.ok(identities.includes(48),
    'the widened request must publish its own identity instead of inheriting the low-budget entry');
});

test('#5284 ranking limit 1 -> 40 re-runs pinpoint and binds returned context coverage', async () => {
  const service = new InvestigationService(fixtureApp());
  const goal = { id: 'custom', text: 'target field' };

  await service.investigate(goal, { limit: 1 });
  const cacheKey = onlyCacheKey(service);
  const sentinel = Object.freeze({ sentinel: 'limit-one-cache-hit' });
  service.pinCache.set(cacheKey, sentinel);

  const widened = await service.investigate(goal, { limit: 40 });
  assert.notEqual(widened.pin, sentinel,
    'a wider ranked-candidate universe must actually re-run pinpoint');
  assert.equal(service.pinCache.get(cacheKey), widened.pin,
    'the cache must contain the pin produced for the returned request');

  const cachedIdentity = service.pinRequestIdentityCache.get(cacheKey);
  const returnedIdentity = pinRequestIdentity(widened.context, goal, { limit: 40 });
  assert.equal(cachedIdentity.rankingLimit, 40,
    'the effective ranking limit is part of the stored request identity');
  assert.equal(pinRequestMatches(cachedIdentity, returnedIdentity), true,
    'cached pin identity/coverage must match the context returned with that pin');
  for (const name of ['fields', 'shapes', 'program', 'symbols', 'strings', 'region']) {
    assert.equal(cachedIdentity.evidenceCoverage[name], widened.context[name],
      `cached evidence coverage must bind returned context.${name}`);
  }
});

test('#5284 an identical canonical request remains a cache hit', async () => {
  const service = new InvestigationService(fixtureApp());
  const goal = { id: 'custom', text: 'target field', expects: { call: true } };

  await service.investigate(goal, { limit: 40 });
  const cacheKey = onlyCacheKey(service);
  const sentinel = Object.freeze({ sentinel: 'identical-cache-hit' });
  service.pinCache.set(cacheKey, sentinel);
  const second = await service.investigate(goal, { limit: 40 });

  assert.equal(second.pin, sentinel, 'the identical canonical request must stay a cache hit');
});

test('#5284 a request that collects shapes never reuses a pin computed without them', async () => {
  const service = new InvestigationService(fixtureApp());
  const withoutShapes = { id: 'custom', text: 'target field' };
  const withShapes = { id: 'custom', text: 'target field', expects: { numeric: true } };

  await service.investigate(withoutShapes);
  const second = await service.investigate(withShapes);

  const identity = pinRequestIdentity(second.context, withShapes, {});
  assert.equal(identity.shapesCollected, true);
  assert.ok(service.pinRequestIdentityCache.size >= 1);
  assert.ok([...service.pinRequestIdentityCache.values()].some((entry) => entry.shapesCollected === true),
    'the shape-evidence request must publish a distinct identity');
});

test('#5284 a different snapshot never shares pin entries', async () => {
  let snapshotId = 'snapshot-A';
  const app = fixtureApp();
  app.analysisQueries.snapshot = async () => ({ snapshotId });
  const service = new InvestigationService(app);
  const goal = { id: 'custom', text: 'target field' };

  const first = await service.investigate(goal);
  snapshotId = 'snapshot-B';
  const second = await service.investigate(goal);

  assert.notEqual(second.pin, first.pin);
  assert.equal(service.pinCache.size, 1,
    'the pin snapshot sync must keep only the current snapshot\u0027s entries');
  assert.equal(service.pinRequestIdentityCache.size, 1,
    'the request-identity side cache must be snapshot-synced with the pin cache');
});

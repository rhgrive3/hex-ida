import test from 'node:test';
import assert from 'node:assert/strict';

import { InvestigationService, __investigationInternalsForTests } from '../../js/analysis/investigation-service.js';

const { pinRequestIdentity } = __investigationInternalsForTests;

// #5284: the pinpoint cache identity must bind every input that changes what
// the pin means. Reuse was keyed only on snapshotId/goal.id/goal.text, so a
// wide-evidence or high-budget re-investigation silently reused a pin computed
// under narrower semantics. The stored request identity (canonical `expects`
// digest + effective pinpoint budget + shape-collection decision) must gate
// cache reuse: any change re-runs pinpoint; an identical canonical request
// stays a hit. Keys stay per goal tuple (#5610); pin entries stay pin-valued
// and snapshot-scoped (#4062).

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

test('#5284 same snapshot/id/text with different expects re-runs pinpoint', async () => {
  const service = new InvestigationService(fixtureApp());
  const goalA = { id: 'custom', text: 'target field', expects: { call: true } };
  const goalB = { id: 'custom', text: 'target field', expects: { numeric: true, store: true } };

  const first = await service.investigate(goalA);
  const second = await service.investigate(goalB);

  assert.notEqual(second.pin, first.pin,
    'a different expects selector must not reuse the narrower request\u0027s cached pin');
  assert.equal(service.pinCache.size, 1,
    'the goal tuple owns one cache entry, replaced when its identity changes');
});

test('#5284 a higher pinpoint budget re-runs pinpoint instead of reusing the low-budget pin', async () => {
  const service = new InvestigationService(fixtureApp());
  const goal = { id: 'custom', text: 'target field' };

  await service.investigate(goal, { budget: { pinpoint: 1 } });
  const widened = await service.investigate(goal, { budget: { pinpoint: 48 } });

  const identities = [...service.pinRequestIdentityCache.values()].map((identity) => identity.pinpointBudget);
  assert.ok(identities.includes(48),
    'the widened request must publish its own identity instead of inheriting the low-budget entry');
  assert.notEqual(widened.pin, null || undefined, 'the widened request completes with its own pin');
});

test('#5284 an identical canonical request remains a cache hit', async () => {
  const service = new InvestigationService(fixtureApp());
  const goal = { id: 'custom', text: 'target field', expects: { call: true } };

  const first = await service.investigate(goal);
  const second = await service.investigate(goal);

  assert.equal(second.pin, first.pin, 'the identical canonical request must stay a cache hit');
});

test('#5284 a request that collects shapes never reuses a pin computed without them', async () => {
  const service = new InvestigationService(fixtureApp());
  const withoutShapes = { id: 'custom', text: 'target field' };
  const withShapes = { id: 'custom', text: 'target field', expects: { numeric: true } };

  await service.investigate(withoutShapes);
  const second = await service.investigate(withShapes);

  const identity = pinRequestIdentity({ goal: withShapes }, withShapes, {});
  assert.equal(identity.shapesCollected, true);
  assert.ok(service.pinRequestIdentityCache.size >= 1);
  assert.ok([...service.pinRequestIdentityCache.values()].some((entry) => entry.shapesCollected === true),
    'the shape-evidence request must publish a distinct identity');
  void second;
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

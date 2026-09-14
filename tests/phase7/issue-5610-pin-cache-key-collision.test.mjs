import test from 'node:test';
import assert from 'node:assert/strict';

import { InvestigationService, __investigationInternalsForTests } from '../../js/analysis/investigation-service.js';

const { pinCacheKey } = __investigationInternalsForTests;

function fixtureApp() {
  return {
    backend: { gen: 1 },
    store: { get: () => null },
    symbols: null,
    stringIndex: Object.assign([], { complete: true, __lookup: () => null }),
    fields: { classCount: 1, classes: new Map() },
    analysisQueries: {
      snapshot: async () => ({ snapshotId: 'snapshot-A' }),
      binaryInfo: async () => ({}),
    },
  };
}

test('#5610 pin cache key encodes the goal tuple without delimiter collisions', () => {
  const goalA = { id: 'a:b', text: 'c' };
  const goalB = { id: 'a', text: 'b:c' };
  assert.notEqual(pinCacheKey('snapshot-A', goalA), pinCacheKey('snapshot-A', goalB),
    'distinct goal tuples must not alias one cache key');
  assert.equal(pinCacheKey('snapshot-A', goalA), pinCacheKey('snapshot-A', { id: 'a:b', text: 'c' }),
    'the same canonical goal tuple must keep reusing one cache key');
  assert.notEqual(pinCacheKey('snapshot-A', goalA), pinCacheKey('snapshot-B', goalA),
    'the snapshot id must participate in the key');
  assert.equal(pinCacheKey('snapshot-A', null), pinCacheKey('snapshot-A', null),
    'a missing goal must produce a stable key');
  assert.equal(pinCacheKey('snapshot-A', { id: '', text: 'x' }), pinCacheKey('snapshot-A', { text: 'x' }),
    'empty and absent id are the same canonical tuple (previous || \u0027\u0027 semantics preserved)');
  assert.notEqual(pinCacheKey('snapshot-A', { id: '1', text: '2' }), pinCacheKey('snapshot-A', { id: '1:2' }),
    'numeric-looking fragments must not alias');
});

test('#5610 a cached pin for one goal is never served to a colliding goal tuple', async () => {
  const service = new InvestigationService(fixtureApp());
  const goalA = { id: 'a:b', text: 'c' };
  const goalB = { id: 'a', text: 'b:c' };

  const resultA = await service.investigate(goalA);
  assert.ok(resultA.pin, 'fixture must produce a truthy pin for the first goal');
  const resultB = await service.investigate(goalB);

  assert.notEqual(resultB.pin, resultA.pin,
    'goalB must run its own pinpoint instead of reusing goalA\u0027s cached pin');
  assert.equal(service.pinCache.size, 2,
    'two distinct goal tuples must occupy two cache entries');
});

test('#5610 the same canonical goal still reuses its cached pin', async () => {
  const service = new InvestigationService(fixtureApp());
  const goalA = { id: 'a:b', text: 'c' };

  const first = await service.investigate(goalA);
  const second = await service.investigate(goalA);

  assert.equal(second.pin, first.pin, 'the identical goal tuple must remain a cache hit');
  assert.equal(service.pinCache.size, 1, 'reuse must not grow the cache');
});

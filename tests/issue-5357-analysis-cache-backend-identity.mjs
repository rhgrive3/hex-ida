// Regression for #5357: analyzeFunctionCached() keys its module-global LRU and
// single-flight map by region shape, symbol generation, row range and budget —
// but not by the analysis producer. Two backends that expose identical region
// metadata (a different binary, slice or source behind the same region id) got
// the same cache key, so the second backend's request was answered from the
// first backend's cache without ever reaching the second backend. The key now
// includes a producer namespace (and the backend's stable binary id when it has
// one), so results can never cross backends.
import assert from 'node:assert/strict';

import { analyzeFunctionCached, clearAnalysisCache } from '../js/analyze.js';
import { CHUNK_ROWS } from '../js/backend.js';

function mockBackend(words) {
  const mn = [...words];
  const ops = words.map(() => '');
  const backend = {
    fetchCalls: 0,
    async fetchChunk() {
      backend.fetchCalls += 1;
      return { mn, ops, bytes: new Uint8Array(CHUNK_ROWS * 4) };
    },
    async readAt() {
      return { found: false, bytes: new Uint8Array() };
    },
  };
  return backend;
}

const region = { id: 'text', vmAddr: 0x1000n, size: 0x1000n, revision: 1 };
const symbols = { gen: 1, nameAt: () => null, label: () => null };

{
  clearAnalysisCache();
  const backendA = mockBackend(['mov', 'ret']);
  const backendB = mockBackend(['bl', 'ret']);

  const a = await analyzeFunctionCached(backendA, region, 0, 1, symbols, null, { texts: false });
  const b = await analyzeFunctionCached(backendB, region, 0, 1, symbols, null, { texts: false });

  assert.equal(backendA.fetchCalls, 1, 'first backend is consulted once');
  assert.equal(backendB.fetchCalls, 1,
    'a different backend with the same region metadata must reach its own bytes, not reuse the cache');
  assert.notEqual(a, b, 'the two analyses must be distinct results');
  assert.equal(a.analyzedRows, 2);
  assert.equal(b.analyzedRows, 2);
}

// Same backend instance still reuses its own cached entry (the producer
// namespace must not defeat intra-backend caching).
{
  clearAnalysisCache();
  const backend = mockBackend(['mov', 'ret']);
  const first = await analyzeFunctionCached(backend, region, 0, 1, symbols, null, { texts: false });
  const second = await analyzeFunctionCached(backend, region, 0, 1, symbols, null, { texts: false });
  assert.equal(backend.fetchCalls, 1, 'the same backend instance reuses its cached analysis');
  assert.equal(first, second);
}

// A backend that reports a different stable binary id after the fact must not
// inherit the previous binary's cached analysis for the same region shape.
{
  clearAnalysisCache();
  const backend = mockBackend(['mov', 'ret']);
  const first = await analyzeFunctionCached(backend, region, 0, 1, symbols, null, { texts: false });
  backend.binaryId = 'binary-2';
  const second = await analyzeFunctionCached(backend, region, 0, 1, symbols, null, { texts: false });
  assert.equal(backend.fetchCalls, 2, 'a changed binary identity invalidates the cached entry');
  assert.notEqual(first, second);
}

console.log('issue #5357 analysis cache backend identity regression passed');

// Regression for #5428: ObservationStore retention/paging budgets adopt only
// primitive finite numbers. Numeric strings, arrays, booleans, and objects
// never become the retention/paging authority; valid numbers keep the exact
// clamp/floor semantics, and defaults plus pinning/eviction are unchanged.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ObservationStore } from '../js/ai/tools/storage/observation-store.js';

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

test('#5428 structured retention budgets must not coerce into authorities', () => {
  const structured = new ObservationStore({ maxEntries: ['17'], maxAgeMs: ['10000'] });
  assert.equal(structured.maxEntries, DEFAULT_MAX_ENTRIES, 'numeric string maxEntries must fall back');
  assert.equal(structured.maxAgeMs, DEFAULT_MAX_AGE_MS, 'numeric string maxAgeMs must fall back');

  const boxed = new ObservationStore({ maxEntries: ['17'], maxAgeMs: [10000] });
  assert.equal(boxed.maxEntries, DEFAULT_MAX_ENTRIES, 'single-element array maxEntries must fall back');
  assert.equal(boxed.maxAgeMs, DEFAULT_MAX_AGE_MS, 'single-element array maxAgeMs must fall back');

  const boolean = new ObservationStore({ maxEntries: true, maxAgeMs: true });
  assert.equal(boolean.maxEntries, DEFAULT_MAX_ENTRIES, 'boolean maxEntries must fall back');
  assert.equal(boolean.maxAgeMs, DEFAULT_MAX_AGE_MS, 'boolean maxAgeMs must fall back');

  const object = new ObservationStore({ maxEntries: { valueOf: () => 17 }, maxAgeMs: { valueOf: () => 10000 } });
  assert.equal(object.maxEntries, DEFAULT_MAX_ENTRIES, 'valueOf-backed object maxEntries must fall back');
  assert.equal(object.maxAgeMs, DEFAULT_MAX_AGE_MS, 'valueOf-backed object maxAgeMs must fall back');
});

test('#5428 valid primitive numbers keep the existing clamp/floor semantics', () => {
  const store = new ObservationStore({ maxEntries: 17, maxAgeMs: 10000 });
  assert.equal(store.maxEntries, 17);
  assert.equal(store.maxAgeMs, 10000);

  const floored = new ObservationStore({ maxEntries: 17.9, maxAgeMs: 10000.9 });
  assert.equal(floored.maxEntries, 17, 'fractional maxEntries is floored as before');
  assert.equal(floored.maxAgeMs, 10000, 'fractional maxAgeMs is floored as before');

  const clamped = new ObservationStore({ maxEntries: 1, maxAgeMs: 5 });
  assert.equal(clamped.maxEntries, 16, 'minimum maxEntries clamp unchanged');
  assert.equal(clamped.maxAgeMs, 10000, 'minimum maxAgeMs clamp unchanged');

  const zeroFallsBack = new ObservationStore({ maxEntries: 0, maxAgeMs: 0 });
  assert.equal(zeroFallsBack.maxEntries, DEFAULT_MAX_ENTRIES, '0 stays a fallback (existing contract)');
  assert.equal(zeroFallsBack.maxAgeMs, DEFAULT_MAX_AGE_MS, '0 stays a fallback (existing contract)');

  const defaults = new ObservationStore({});
  assert.equal(defaults.maxEntries, DEFAULT_MAX_ENTRIES);
  assert.equal(defaults.maxAgeMs, DEFAULT_MAX_AGE_MS);
});

test('#5428 structured detail paging limits must not coerce into page authorities', () => {
  const store = new ObservationStore({ context: { binaryId: 'b1' } });
  const rows = Array.from({ length: 600 }, (_, i) => `row-${i}`);
  const record = store.put({ tool: 't', arguments: {}, fullResult: { rows } });
  store.pin(record.id);

  const structured = store.detail({ detailRef: record.id, path: '$.rows', limit: ['2'] });
  assert.equal(structured.data.length, 100, "array limit must fall back to the 100 default (Number(['2'])===2 today)");
  assert.equal(structured.completeness.complete, false);

  const booleanLimit = store.detail({ detailRef: record.id, path: '$.rows', limit: true });
  assert.equal(booleanLimit.data.length, 100, 'boolean limit must fall back (Number(true)===1 today)');

  const objectLimit = store.detail({ detailRef: record.id, path: '$.rows', limit: { valueOf: () => 2 } });
  assert.equal(objectLimit.data.length, 100, 'valueOf-backed object limit must fall back');

  const valid = store.detail({ detailRef: record.id, path: '$.rows', limit: 2 });
  assert.equal(valid.data.length, 2, 'primitive limit keeps the exact paging semantics');
  assert.equal(valid.completeness.total, 600);
  assert.ok(valid.continuation?.cursor, 'primitive limit still produces a continuation cursor');

  const clamped = store.detail({ detailRef: record.id, path: '$.rows', limit: 10_000 });
  assert.equal(clamped.data.length, 500, 'maximum page clamp unchanged (600 rows, limit 10000 → 500)');

  const floored = store.detail({ detailRef: record.id, path: '$.rows', limit: 2.9 });
  assert.equal(floored.data.length, 2, 'fractional limit is floored as before');

  const fallback = store.detail({ detailRef: record.id, path: '$.rows', limit: Number.NaN });
  assert.equal(fallback.data.length, 100, 'non-finite limit keeps the default');
});

test('#5428 pinning/eviction correctness is unchanged under strict budgets', () => {
  const store = new ObservationStore({ context: { binaryId: 'b1' }, maxEntries: 16 });
  const pinned = store.put({ tool: 'p', arguments: {}, fullResult: { keep: true } });
  store.pin(pinned.id);
  for (let i = 0; i < 20; i += 1) {
    store.put({ tool: `t${i}`, arguments: {}, fullResult: { i } });
  }
  assert.equal(store.records.size, 16, 'count-based eviction still caps the store');
  assert.equal(store.get(pinned.id).id, pinned.id, 'pinned evidence survives eviction');
});

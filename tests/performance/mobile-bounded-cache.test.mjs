import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedWeakCache, BoundedWeakMetadata } from '../../js/core/identity/bounded-weak-cache.js';

test('bounded weak cache validates budgets and weights', () => {
  for (const n of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new BoundedWeakCache(n, 8), /invalid-weak-cache-budget/);
    assert.throws(() => new BoundedWeakCache(8, n), /invalid-weak-cache-budget/);
    assert.throws(() => new BoundedWeakMetadata(n), /invalid-weak-cache-budget/);
  }
  const cache = new BoundedWeakCache(2, 8);
  for (const weight of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => cache.set({}, 'x', weight), /invalid-weak-cache-weight/);
  }
  assert.equal(cache.stats().entries, 0);
});

test('entry limit drops an old generation before retaining a new key', () => {
  const cache = new BoundedWeakCache(2, 100), a = {}, b = {}, c = {};
  assert.equal(cache.set(a, 'a', 1), cache);
  cache.set(b, 'b', 1);
  assert.deepEqual(cache.stats(), { entries: 2, weight: 2, maxEntries: 2, maxWeight: 100 });
  cache.set(c, 'c', 1);
  assert.equal(cache.get(a), undefined); assert.equal(cache.get(b), undefined);
  assert.equal(cache.get(c), 'c'); assert.equal(cache.stats().entries, 1);
});

test('payload limit accepts the boundary and rejects oversized new entries', () => {
  const cache = new BoundedWeakCache(10, 8), a = {}, b = {}, large = {};
  cache.set(a, '日本', 4).set(b, '語語', 4);
  assert.equal(cache.stats().weight, 8);
  cache.set(large, 'too-large', 9);
  assert.equal(cache.get(large), undefined); assert.equal(cache.get(a), '日本');
  cache.set({}, 'x', 1);
  assert.equal(cache.get(a), undefined); assert.equal(cache.stats().weight, 1);
});

test('replacement accounting subtracts old weight and does not add an entry', () => {
  const cache = new BoundedWeakCache(2, 8), a = {}, b = {};
  cache.set(a, 'first', 6).set(a, 'second', 3).set(b, 'b', 5);
  assert.equal(cache.stats().weight, 8); assert.equal(cache.stats().entries, 2);
  cache.set(a, 'new', 4);
  assert.equal(cache.get(b), undefined); assert.equal(cache.get(a), 'new');
  assert.equal(cache.stats().weight, 4); assert.equal(cache.stats().entries, 1);
});

test('zero-weight values still obey the entry bound and stats are detached', () => {
  const cache = new BoundedWeakCache(2, 8), a = {}, b = {}, c = {};
  cache.set(a, undefined, 0).set(a, 'updated', 0).set(b, false, 0);
  const stats = cache.stats(); stats.entries = 900;
  assert.equal(cache.stats().entries, 2);
  cache.set(c, null, 0); assert.equal(cache.get(a), undefined);
  assert.equal(cache.get(c), null); assert.equal(cache.stats().weight, 0);
  cache.clear(); assert.equal(cache.get(c), undefined); assert.equal(cache.stats().entries, 0);
});

test('metadata preserves false and replacement without wrapper allocations', () => {
  const cache = new BoundedWeakMetadata(2), a = {}, b = {}, c = {};
  cache.set(a, false).set(b, 1).set(a, 2);
  assert.equal(cache.get(a), 2); assert.equal(cache.stats().entries, 2);
  cache.set(c, false);
  assert.equal(cache.get(a), undefined); assert.equal(cache.get(b), undefined);
  assert.equal(cache.get(c), false); assert.equal(cache.stats().entries, 1);
});

test('sustained live-key churn stays within both explicit bookkeeping bounds', () => {
  const cache = new BoundedWeakCache(31, 113), metadata = new BoundedWeakMetadata(97);
  const keys = Array.from({ length: 20000 }, () => ({}));
  for (let i = 0; i < keys.length; i++) {
    const weight = i % 17;
    cache.set(keys[i], 'x'.repeat(weight), weight); metadata.set(keys[i], i & 3);
    const stats = cache.stats();
    assert.ok(stats.entries <= 31); assert.ok(stats.weight <= 113);
    assert.ok(metadata.stats().entries <= 97);
    assert.equal(cache.get(keys[i]), 'x'.repeat(weight));
    assert.equal(metadata.get(keys[i]), i & 3);
  }
  assert.equal(cache.get(keys[0]), undefined); assert.equal(metadata.get(keys[0]), undefined);
});

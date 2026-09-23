import test from 'node:test';
import assert from 'node:assert/strict';
import { LRU } from '../js/lru.js';

test('Issue #9506: LRU.prototype.delete() returns boolean matching Map interface', () => {
  const lru = new LRU(5);
  lru.set('a', 1);
  lru.set('b', 2);

  // Deleting existing keys should return true
  assert.equal(lru.delete('a'), true);
  assert.equal(lru.has('a'), false);
  assert.equal(lru.size, 1);

  // Deleting non-existent or already deleted keys should return false
  assert.equal(lru.delete('a'), false);
  assert.equal(lru.delete('non_existent'), false);
  assert.equal(lru.size, 1);

  // Deleting the remaining key
  assert.equal(lru.delete('b'), true);
  assert.equal(lru.has('b'), false);
  assert.equal(lru.size, 0);

  // Deleting from empty LRU returns false
  assert.equal(lru.delete('b'), false);
});

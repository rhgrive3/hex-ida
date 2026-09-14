import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../js/script.js';

function makeApp(notes, calls) {
  return {
    notes,
    symbols: {
      rename(address, name) { calls.push(['rename', address, name]); },
    },
    viewer: {
      setSymbols() { calls.push(['setSymbols']); },
    },
  };
}

test('issue #5893 - annotation APIs report persistence failure', () => {
  const calls = [];
  const { api } = createApi(makeApp({
    setName() { return false; },
    setComment() { return false; },
  }, calls), () => {});

  assert.equal(api.rename(0x1000n, 'target'), false);
  assert.equal(api.comment(0x1000n, 'memo'), false);
  assert.deepEqual(calls, []);
});

test('issue #5893 - successful annotation keeps the existing boolean API', () => {
  const calls = [];
  const { api } = createApi(makeApp({
    setName() { return true; },
    setComment() { return true; },
  }, calls), () => {});

  assert.equal(api.rename(0x1000n, 'target'), true);
  assert.equal(api.comment(0x1000n, 'memo'), true);
  assert.deepEqual(calls, [
    ['rename', 0x1000n, 'target'],
    ['setSymbols'],
  ]);
});

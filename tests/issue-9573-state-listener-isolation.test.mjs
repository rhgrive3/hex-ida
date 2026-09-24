import assert from 'node:assert/strict';
import test from 'node:test';

import { Store } from '../js/state.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('#9573 synchronous listener failure is isolated from later subscribers and caller', () => {
  const store = new Store();
  const seen = [];
  store.subscribe((state, patch) => {
    seen.push(['a', state.theme, patch.theme]);
    throw new Error('subscriber A exploded');
  });
  store.subscribe((state, patch) => seen.push(['b', state.theme, patch.theme]));
  store.subscribe((state, patch) => seen.push(['c', state.theme, patch.theme]));

  assert.doesNotThrow(() => store.set({ theme: 'dark' }));
  assert.equal(store.get('theme'), 'dark');
  assert.deepEqual(seen, [
    ['a', 'dark', 'dark'],
    ['b', 'dark', 'dark'],
    ['c', 'dark', 'dark'],
  ]);
});

test('#9573 rejected async listener is observed and later subscribers still run', async () => {
  const store = new Store();
  const seen = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    store.subscribe(async () => {
      seen.push('async');
      throw new Error('async subscriber rejected');
    });
    store.subscribe(() => seen.push('after'));

    assert.doesNotThrow(() => store.set({ theme: 'dark' }));
    await turn();
    await turn();

    assert.deepEqual(seen, ['async', 'after']);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

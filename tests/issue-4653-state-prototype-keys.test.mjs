import assert from 'node:assert/strict';
import { Store } from '../js/state.js';

const store = new Store();
const beforePrototype = Object.getPrototypeOf(store.state);
let notifications = 0;
store.subscribe(() => { notifications++; });

const pollutedPatch = JSON.parse('{"theme":"dark","__proto__":{"polluted":"yes"}}');
assert.throws(
  () => store.set(pollutedPatch),
  (error) => error instanceof TypeError && error.message === 'state-key-invalid',
  '__proto__ patch must fail at the Store boundary',
);
assert.equal(store.get('theme'), 'system', 'invalid patches must not partially commit valid keys');
assert.equal(Object.getPrototypeOf(store.state), beforePrototype, 'invalid patch must not replace state prototype');
assert.equal(store.get('polluted'), undefined, 'prototype values must not become readable state');
assert.equal(notifications, 0, 'rejected patches must not notify listeners');

for (const key of ['constructor', 'prototype']) {
  const patch = Object.create(null);
  patch[key] = { polluted:'yes' };
  assert.throws(
    () => store.set(patch),
    (error) => error instanceof TypeError && error.message === 'state-key-invalid',
    `${key} must be rejected as a reserved state key`,
  );
}

store.set({ capability:{ architecture:'arm64' }, analysisLevel:'full' });
assert.equal(store.get('capability').architecture, 'arm64', 'ordinary dynamic app-state keys remain supported');
assert.equal(store.get('analysisLevel'), 'full');
assert.equal(notifications, 1, 'valid patch keeps existing listener notification semantics');

console.log('issue #4653 state prototype key boundary: PASS');

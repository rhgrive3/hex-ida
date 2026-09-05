import assert from 'node:assert/strict';
import { Store } from '../js/state.js';

const store = new Store();
for (const invalid of [true, false, 1, 0, 'listener', '', {}, [], null, undefined]) {
  assert.throws(
    () => store.subscribe(invalid),
    (error) => error instanceof TypeError && error.message === 'state-listener-invalid',
    `non-function listener ${String(invalid)} must fail at subscribe()`,
  );
}

const calls = [];
const unsubscribeA = store.subscribe((state, patch) => calls.push(['a', state.theme, patch.theme]));
store.subscribe((state, patch) => calls.push(['b', state.theme, patch.theme]));
store.set({ theme:'dark' });
assert.deepEqual(calls, [
  ['a', 'dark', 'dark'],
  ['b', 'dark', 'dark'],
], 'valid listeners retain insertion order and notification arguments');

unsubscribeA();
store.set({ theme:'light' });
assert.deepEqual(calls.at(-1), ['b', 'light', 'light'], 'unsubscribe removes only the registered function');
assert.equal(store.get('theme'), 'light', 'listener validation does not alter state semantics');

console.log('issue #3413 state listener callability: PASS');

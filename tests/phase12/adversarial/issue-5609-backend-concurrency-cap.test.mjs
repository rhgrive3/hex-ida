import assert from 'node:assert/strict';
import { Backend } from '../../../js/backend.js';

const backend = new Backend();
const pending = [];
let active = 0;
let maxActive = 0;

backend.call = () => new Promise((resolve, reject) => {
  active++;
  maxActive = Math.max(maxActive, active);
  const settle = (fn, value) => {
    active--;
    fn(value);
  };
  pending.push({
    resolve: (value) => settle(resolve, value),
    reject: (error) => settle(reject, error),
  });
});

for (let chunk = 0; chunk < 7; chunk++) backend.request('region', chunk, false);
assert.equal(active, 6);
assert.equal(backend.queue.length, 1);

pending[0].resolve({ bytes: new Uint8Array([1]), rows: 1 });
await Promise.resolve();

// This request lands after the completion callback but before a separate
// queue-drain microtask in the buggy scheduler.
backend.request('region', 7, false);
assert.equal(active, 6);

await Promise.resolve();
assert.equal(active, 6);
assert.equal(maxActive, 6);
assert.equal(backend.queue.length, 1);

backend.dispose();
console.log('issue #5609 backend concurrency cap: PASS');

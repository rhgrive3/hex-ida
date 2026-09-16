import assert from 'node:assert/strict';
import { readBoundedBytes } from '../js/userscript/loader-transport.js';

let consumed = 0;
let cancelled = false;
const body = new ReadableStream({
  pull(controller) {
    consumed += 1;
    controller.enqueue(new Uint8Array(8).fill(consumed));
    if (consumed === 5) controller.close();
  },
  cancel() { cancelled = true; },
});

await assert.rejects(
  () => readBoundedBytes({ headers: { get: () => null }, body }, {
    maxBytes: 1024,
    exactBytes: 16,
    overBudgetMessage: 'OVER',
    mismatchMessage: 'MISMATCH',
  }),
  /MISMATCH/,
);
assert.equal(consumed, 3, 'the reader must stop before retaining bytes beyond the exact manifest bound');
assert.equal(cancelled, true, 'the reader must cancel a chunked body at the exact manifest bound');

console.log('issue-8927 exact streaming bound: ok');

import assert from 'node:assert/strict';
import { requestJSON } from '../../../js/ai/transport.js';
import { AIError } from '../../../js/ai/schema.js';

let abortedReads = 0;
let addReads = 0;
let removeReads = 0;
let fetchCalls = 0;

const signal = {
  get aborted() {
    abortedReads += 1;
    if (abortedReads === 1) return false;
    throw new Error('late-aborted-getter');
  },
  get addEventListener() {
    addReads += 1;
    if (addReads > 1) throw new Error('add-listener-reread');
    return function addEventListener() {};
  },
  get removeEventListener() {
    removeReads += 1;
    if (removeReads > 1) throw new Error('remove-listener-reread');
    return function removeEventListener() {};
  },
};

await assert.rejects(
  requestJSON('/turn', {}, {
    signal,
    timeoutMs: 60_000,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('transport-must-not-start');
    },
  }),
  (error) => error instanceof AIError
    && error.type === 'provider_error'
    && /AbortSignal-compatible/.test(error.message),
  'a live abort-state accessor that becomes unreadable must fail closed before transport I/O',
);

assert.equal(abortedReads, 2, 'aborted is sampled once for admission and once after listener registration');
assert.equal(addReads, 1, 'listener authority must be snapshotted once');
assert.equal(removeReads, 1, 'cleanup authority must be snapshotted once');
assert.equal(fetchCalls, 0, 'malformed live signal authority must not reach fetch');

console.log('issue #4286 transport signal accessor snapshot regression passed');

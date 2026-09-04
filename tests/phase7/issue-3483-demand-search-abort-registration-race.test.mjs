import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../js/analysis/demand-driven-runtime.js', import.meta.url), 'utf8');
const searchStart = source.indexOf('    async search(_snapshot, query, page = {}, options = {}) {');
const searchEnd = source.indexOf('\n    },\n  };', searchStart);
assert.notEqual(searchStart, -1, 'typed search adapter must exist');
assert.notEqual(searchEnd, -1, 'typed search adapter must have a bounded source slice');
const search = source.slice(searchStart, searchEnd);

const listenerIndex = search.indexOf("options.signal?.addEventListener('abort', onAbort, { once:true });");
const recheckIndex = search.indexOf('if (options.signal?.aborted) onAbort();');
const requestJoinIndex = search.indexOf('Promise.resolve(request).then(resolve, reject)');
assert.ok(listenerIndex >= 0, 'typed search must register an abort listener');
assert.ok(recheckIndex > listenerIndex, 'typed search must recheck cancellation after listener registration');
assert.ok(requestJoinIndex > recheckIndex, 'the cancellation recheck must happen before waiting on the backend request');
assert.match(search, /let aborted = false;/);
assert.match(search, /if \(aborted\) return;\s*aborted = true;\s*request\.cancel\?\.\(\);/s);

function waitForSearch(request, signal) {
  return new Promise((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      request.cancel?.();
      const error = signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Search aborted'), { name:'AbortError' });
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once:true });
    if (signal?.aborted) onAbort();
    Promise.resolve(request).then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
  });
}

{
  let cancelCalls = 0;
  const reason = Object.assign(new Error('registration-edge'), { name:'AbortError' });
  const signal = {
    aborted:false,
    reason,
    addEventListener() { this.aborted = true; },
    removeEventListener() {},
  };
  const request = new Promise(() => {});
  request.cancel = () => { cancelCalls++; };
  await assert.rejects(waitForSearch(request, signal), (error) => error === reason);
  assert.equal(cancelCalls, 1, 'a raced abort with no event replay must cancel the backend request');
}

{
  let cancelCalls = 0;
  const reason = Object.assign(new Error('synchronous-event'), { name:'AbortError' });
  const signal = {
    aborted:false,
    reason,
    addEventListener(_type, listener) { this.aborted = true; listener(); },
    removeEventListener() {},
  };
  const request = new Promise(() => {});
  request.cancel = () => { cancelCalls++; };
  await assert.rejects(waitForSearch(request, signal), (error) => error === reason);
  assert.equal(cancelCalls, 1, 'listener delivery plus post-registration recheck must not double-cancel');
}

{
  let cancelCalls = 0;
  let removals = 0;
  const signal = {
    aborted:false,
    addEventListener() {},
    removeEventListener() { removals++; },
  };
  const request = Promise.resolve({ results:[] });
  request.cancel = () => { cancelCalls++; };
  const value = await waitForSearch(request, signal);
  await Promise.resolve();
  assert.deepEqual(value, { results:[] });
  assert.equal(cancelCalls, 0, 'normal completion must not cancel the backend request');
  assert.equal(removals, 1, 'normal completion must remove the abort listener');
}

console.log('issue #3483 demand search abort registration race regression passed');

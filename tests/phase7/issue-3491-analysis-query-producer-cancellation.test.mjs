import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../js/analysis/query/app-adapter.js', import.meta.url), 'utf8');

const programOptionCall = /app\.ensureProgram\(\{ signal:options\.signal \?\? null, onProgress:options\.onProgress, priority:options\.priority, budget:options\.budget \}\)/g;
assert.equal((source.match(programOptionCall) || []).length, 3, 'callers/callees/xrefs must forward the full per-consumer program options');
assert.doesNotMatch(source, /app\.ensureProgram\(options\.onProgress\)/, 'legacy callback-only ensureProgram calls lose AbortSignal ownership');

const searchStart = source.indexOf('    async search(_snapshot, query, page = {}, options = {}) {');
const searchEnd = source.indexOf('    async causalPath(', searchStart);
assert.ok(searchStart >= 0 && searchEnd > searchStart, 'search adapter source boundary must exist');
const searchSource = source.slice(searchStart, searchEnd);
assert.match(searchSource, /throwIfAborted\(options\.signal\);\n      const request = app\.backend\.search\(query, options\.onProgress\);\n      const value = await requestWithSignal\(request, options\.signal\);/,
  'backend search must avoid pre-aborted work and bind the cancelable request to the consumer signal');

const helperStart = source.indexOf('function abortError(signal, fallback =');
const helperEnd = source.indexOf('function pageOf(page = {})', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'cancelable request helper source boundary must exist');
const helperSource = source.slice(helperStart, helperEnd);
assert.match(helperSource, /signal\.addEventListener\('abort', onAbort, \{ once:true \}\);\n    if \(signal\.aborted\) onAbort\(\);/,
  'abort registration must synchronously recheck the signal');
assert.match(helperSource, /const onAbort = \(\) => \{\n      if \(settled\) return;\n      try \{ request\.cancel\?\.\(\); \} catch/,
  'event delivery plus post-registration recheck must not double-cancel');

const { requestWithSignal } = Function(`${helperSource}\nreturn { requestWithSignal };`)();

function pendingRequest(onCancel) {
  const promise = new Promise(() => {});
  promise.cancel = onCancel;
  return promise;
}

{
  let cancelCalls = 0;
  let removals = 0;
  const signal = {
    aborted:false,
    reason:null,
    addEventListener() { this.aborted = true; },
    removeEventListener() { removals++; },
  };
  await assert.rejects(requestWithSignal(pendingRequest(() => { cancelCalls++; }), signal), (error) => error?.name === 'AbortError');
  assert.equal(cancelCalls, 1, 'abort during listener registration must cancel the backend request exactly once');
  assert.equal(removals, 1, 'registration-race cancellation must clean up the listener');
}

{
  let cancelCalls = 0;
  const signal = {
    aborted:false,
    reason:null,
    addEventListener(_type, listener) { this.aborted = true; listener(); },
    removeEventListener() {},
  };
  await assert.rejects(requestWithSignal(pendingRequest(() => { cancelCalls++; }), signal), (error) => error?.name === 'AbortError');
  assert.equal(cancelCalls, 1, 'synchronous abort delivery plus recheck must remain exactly-once');
}

{
  let cancelCalls = 0;
  let removals = 0;
  const request = Promise.resolve({ results:[{ id:1 }], capped:false, cancelled:false });
  request.cancel = () => { cancelCalls++; };
  const signal = {
    aborted:false,
    addEventListener() {},
    removeEventListener() { removals++; },
  };
  assert.deepEqual(await requestWithSignal(request, signal), { results:[{ id:1 }], capped:false, cancelled:false });
  assert.equal(cancelCalls, 0, 'normal completion must not cancel backend search');
  assert.equal(removals, 1, 'normal completion must clean up the listener');
}

{
  let cancelCalls = 0;
  const controller = new AbortController();
  const wait = requestWithSignal(pendingRequest(() => { cancelCalls++; }), controller.signal);
  controller.abort();
  await assert.rejects(wait, (error) => error?.name === 'AbortError');
  assert.equal(cancelCalls, 1, 'ordinary consumer abort must cancel the backend search request');
}

console.log('analysis query producer cancellation regression passed');

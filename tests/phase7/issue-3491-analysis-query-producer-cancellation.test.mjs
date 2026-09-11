import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';
import { installSharedAppArtifacts } from '../../js/analysis/shared-app-artifacts.js';

const source = fs.readFileSync(new URL('../../js/analysis/query/app-adapter.js', import.meta.url), 'utf8');

{
  const signal = new AbortController().signal;
  const onProgress = () => {};
  const seen = [];
  const app = {
    ensureProgram: async (options) => {
      seen.push(options);
      const empty = () => { const rows = []; rows.complete = true; return rows; };
      return {
        callersOf: empty,
        calleesOf: empty,
        refSitesTo: empty,
        callSitesTo: empty,
      };
    },
    symbols: { functionAt: () => ({ start:0x2000n, end:0x2004n }) },
    store: { get: (key) => key === 'regions' ? [{ exec:true, vmAddr:0x2000n, size:0x10n }] : null },
  };
  const adapter = createAppAnalysisQueryAdapter(app);
  const options = { signal, onProgress, priority:'high', budget:123 };
  await adapter.callers(null, 0x2000n, {}, options);
  await adapter.callees(null, 0x2000n, {}, options);
  await adapter.xrefs(null, 0x2000n, {}, options);
  assert.equal(seen.length, 3, 'callers/callees/xrefs must each acquire the program');
  for (const received of seen) {
    assert.equal(received.signal, signal);
    assert.equal(received.onProgress, onProgress);
    assert.equal(received.priority, 'high');
    assert.equal(received.budget, 123);
  }
}
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

{
  let cancelCalls = 0;
  let rejectRequest;
  let addCalls = 0;
  let removeCalls = 0;
  const request = new Promise((_, reject) => { rejectRequest = reject; });
  request.cancel = () => {
    cancelCalls++;
    rejectRequest(new Error('synchronous producer cancellation'));
  };
  const signal = {
    aborted:false,
    reason:'synchronous producer abort',
    addEventListener() { addCalls++; },
    removeEventListener() { removeCalls++; },
  };
  const app = {
    backend: {
      search() {
        signal.aborted = true;
        return request;
      },
    },
  };
  const adapter = createAppAnalysisQueryAdapter(app);
  await assert.rejects(
    adapter.search(null, { text:'needle' }, {}, { signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(cancelCalls, 1, 'an abort during synchronous request creation must cancel the created request exactly once');
  assert.equal(addCalls, 0, 'a request created during abort must not register a stale listener');
  assert.equal(removeCalls, 0, 'no listener should require cleanup when abort precedes registration');
}

{
  let cancelCalls = 0;
  const frozenReason = Object.freeze(new Error('frozen cancellation'));
  const signal = { aborted:true, reason:frozenReason };
  await assert.rejects(
    requestWithSignal(pendingRequest(() => { cancelCalls++; }), signal),
    (error) => {
      assert.notEqual(error, frozenReason, 'abort normalization must not reuse a caller-owned Error');
      assert.equal(error?.name, 'AbortError');
      assert.equal(error?.code, 'ABORT_ERR');
      return true;
    },
  );
  assert.equal(frozenReason.name, 'Error');
  assert.equal(frozenReason.code, undefined);
  assert.equal(cancelCalls, 1, 'an already-created request must be cancelled even when the signal is already aborted');
}

{
  let cancelCalls = 0;
  const reason = new Error('already normalized caller reason');
  reason.name = 'AbortError';
  reason.code = 'ABORT_ERR';
  const signal = { aborted:true, reason };
  await assert.rejects(
    requestWithSignal(pendingRequest(() => { cancelCalls++; }), signal),
    (error) => {
      assert.notEqual(error, reason, 'already-normalized caller reasons must still be copied into a fresh error');
      assert.equal(error?.name, 'AbortError');
      assert.equal(error?.code, 'ABORT_ERR');
      return true;
    },
  );
  assert.equal(reason.name, 'AbortError');
  assert.equal(reason.code, 'ABORT_ERR');
  assert.equal(cancelCalls, 1, 'an already-created request must be cancelled exactly once');
}

{
  let backendCalls = 0;
  const controller = new AbortController();
  controller.abort('pre-aborted search');
  const app = {
    backend: {
      search() {
        backendCalls++;
        return pendingRequest(() => {});
      },
    },
  };
  const adapter = createAppAnalysisQueryAdapter(app);
  await assert.rejects(
    adapter.search(null, { text:'needle' }, {}, { signal:controller.signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(backendCalls, 0, 'the adapter precheck must prevent backend work for a pre-aborted search');
}

{
  let cancelCalls = 0;
  const reason = new Error('custom cancellation');
  reason.name = 'CustomCancellation';
  const controller = new AbortController();
  const wait = requestWithSignal(pendingRequest(() => { cancelCalls++; }), controller.signal);
  controller.abort(reason);
  await assert.rejects(wait, (error) => {
    assert.notEqual(error, reason, 'raced cancellation must not mutate/reuse a custom reason');
    assert.equal(error?.name, 'AbortError');
    assert.equal(error?.code, 'ABORT_ERR');
    return true;
  });
  assert.equal(reason.name, 'CustomCancellation');
  assert.equal(reason.code, undefined);
  assert.equal(cancelCalls, 1);
}


function programApp(scanProgram) {
  return {
    backend: { gen: 0, scanProgram },
    store: { get: () => null },
    programRegions: () => [
      { id: 't1', exec: true, size: 16n, section: '__text', vmAddr: 0x2000n },
      { id: 't2', exec: true, size: 16n, section: '__text', vmAddr: 0x3000n },
    ],
    symbols: { gen: 1, functionStartsComplete: true },
  };
}

function pendingTimeout(label, ms = 250) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(label)), ms);
  });
}

function cancellableProgramHarness() {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let cancelCalls = 0;
  const app = programApp((regionId) => {
    if (regionId === 't1') {
      firstStarted();
      const request = firstGate.then(() => ({ regionId }));
      request.cancel = () => { cancelCalls += 1; };
      return request;
    }
    return Promise.resolve({ regionId });
  });
  installSharedAppArtifacts(app);
  return {
    app,
    adapter:createAppAnalysisQueryAdapter(app),
    started,
    releaseFirst,
    get cancelCalls() { return cancelCalls; },
  };
}

{
  const harness = cancellableProgramHarness();
  const firstController = new AbortController();
  const first = harness.adapter.callers(null, 0x2000n, {}, { signal:firstController.signal });
  await harness.started;
  const secondController = new AbortController();
  const second = harness.adapter.callers(null, 0x2000n, {}, { signal:secondController.signal });

  firstController.abort(new Error('first consumer cancelled'));
  await assert.rejects(
    Promise.race([first, pendingTimeout('first consumer did not detach')]),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(harness.cancelCalls, 0,
    'aborting one shared-program consumer must not cancel the producer for the other');
  harness.releaseFirst();
  const secondResult = await second;
  assert.equal(secondResult.status.completeness, 'complete',
    'the remaining shared-program consumer must receive the completed artifact');
}

{
  const harness = cancellableProgramHarness();
  const controller = new AbortController();
  const pending = harness.adapter.callers(null, 0x2000n, {}, { signal:controller.signal });
  await harness.started;
  controller.abort(new Error('last consumer cancelled'));
  await assert.rejects(
    Promise.race([pending, pendingTimeout('last consumer did not detach')]),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(harness.cancelCalls, 1,
    'the last shared-program consumer abort must cancel the producer request');
}

console.log('analysis query producer cancellation regression passed');

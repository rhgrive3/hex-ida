import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginHost } from '../../js/plugins.js';

// #8940: installFromUrl must bound the whole remote exchange with a deadline and
// honor a caller AbortSignal. The prior byte cap only advanced when the server
// produced bytes, so a host that never returned headers, or returned headers and
// then stalled the body stream, left the returned Promise pending forever.

const install = (url, options) => PluginHost.prototype.installFromUrl.call({}, url, options);

function stalledFetch() {
  return () => new Promise(() => {}); // headers never arrive
}

function stallingBodyFetch() {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}), // one chunk, then the stream stalls
        releaseLock() {},
        cancel() {},
      }),
    },
  });
}

async function withGlobalFetch(fn, body) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await body(); } finally { globalThis.fetch = original; }
}

test('#8940 a fetch that never resolves times out instead of pinning install forever', async () => {
  const started = Date.now();
  const result = await withGlobalFetch(stalledFetch(), () => install('https://x/p.js', { timeoutMs: 15 }));
  assert.ok(result.timeout === true, 'stalled headers must yield a bounded timeout result');
  assert.equal(result.ok, undefined);
  assert.ok(Date.now() - started < 2000, 'must resolve near the deadline, not hang');
});

test('#8940 a body that stalls after headers times out too', async () => {
  const result = await withGlobalFetch(stallingBodyFetch(), () => install('https://x/p.js', { timeoutMs: 15 }));
  assert.ok(result.timeout === true, 'a stalled reader.read() must not defeat the bound');
});

test('#8940 caller AbortSignal pre-aborted returns without fetching', async () => {
  let called = false;
  const controller = new AbortController();
  controller.abort();
  const result = await withGlobalFetch(() => { called = true; return Promise.resolve({ ok: true }); },
    () => install('https://x/p.js', { signal: controller.signal }));
  assert.equal(called, false, 'an already-aborted signal must short-circuit before fetch');
  assert.equal(result.aborted, true);
});

test('#8940 caller AbortSignal mid-flight returns aborted, not a hang', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const result = await withGlobalFetch(stalledFetch(), () => {
    const p = install('https://x/p.js', { signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 5);
    return p;
  });
  assert.equal(result.aborted, true);
  assert.ok(Date.now() - started < 1000, 'caller abort must cancel promptly, not wait out the deadline');
});

test('#8940 healthy fetch within the deadline still returns the source (bound does not regress)', async () => {
  const source = 'export default {}';
  const result = await withGlobalFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String(new TextEncoder().encode(source).byteLength) },
    text: async () => source,
  }), () => install('https://x/p.js', { timeoutMs: 5000 }));
  assert.equal(result.ok, true);
  assert.equal(result.source, source);
  assert.equal(result.needsConfirmation, true);
});

test('#8940 the outgoing request is given an AbortSignal so a well-behaved fetch can be cancelled', async () => {
  let seenSignal = null;
  const result = await withGlobalFetch((url, init) => {
    seenSignal = init?.signal ?? null;
    return new Promise(() => {});
  }, () => install('https://x/p.js', { timeoutMs: 15 }));
  assert.ok(seenSignal instanceof AbortSignal, 'fetch must receive a cancellable signal');
  assert.equal(result.timeout, true);
  assert.equal(seenSignal.aborted, true, 'the signal must be aborted once the deadline fires');
});

// Issue #8927 regression: the tiny secure loader must bound remote network
// admission — per-attempt deadlines with composed AbortSignal, a small hard
// bootstrap-JSON byte budget, manifest-exact runtime length authority enforced
// before body materialization (declared Content-Length) and during streaming
// (reader stop/cancel at the bound), exact final byte-count equality before
// hashing, and a gzip plaintext output ceiling — so an unverified remote body
// can never be fully materialized or hold startup pending forever.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createAttemptDeadline, parseContentLength, readBoundedBytes, readBoundedText } from '../js/userscript/loader-transport.js';
import { decompressGzipExact } from '../js/userscript/decompress.js';

const root = new URL('../', import.meta.url);
const loaderSource = readFileSync(new URL('js/userscript/loader.js', root), 'utf8');

// 1. The loader wires both remote helpers to the bounded transport.
assert.match(loaderSource, /createAttemptDeadline\(NETWORK_ATTEMPT_DEADLINE_MS\)/, 'each fetch attempt must own a finite deadline');
assert.match(loaderSource, /signal:\s*attempt\.signal/, 'both fetches must pass the attempt AbortSignal');
assert.match(loaderSource, /readBoundedBytes\(response, \{[\s\S]*?exactBytes/, 'the runtime asset must be read through the bounded reader with manifest authority');
assert.match(loaderSource, /Number\.isSafeInteger\(manifest\.byteLength\)/, 'manifest.byteLength must be validated before the runtime GET starts');
assert.match(loaderSource, /fetchBytes\([\s\S]*?manifest\.byteLength\)/, 'the manifest length must reach the runtime reader');
assert.match(loaderSource, /decompressGzipExact\(compressed, RUNTIME_MAX_PLAINTEXT_BYTES\)/, 'gzip output must carry a plaintext ceiling');

// 2. Content-Length parsing is strict and total.
assert.equal(parseContentLength('1024'), 1024);
assert.equal(parseContentLength('0'), 0);
assert.equal(parseContentLength(null), null);
assert.equal(parseContentLength('-5'), null);
assert.equal(parseContentLength('1e9'), null);
assert.equal(parseContentLength('09'), null);
assert.equal(parseContentLength(`${2n ** 64n}`), null);

function streamResponse({ chunks, headers = {}, failAfter = null }) {
  let index = 0;
  let cancelReason = null;
  const body = new ReadableStream({
    async pull(controller) {
      if (failAfter !== null && index >= failAfter) { controller.error(new Error('simulated body stall/abort')); return; }
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[index++]);
    },
    cancel(reason) { cancelReason = reason ?? null; },
  });
  return {
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body,
    get cancelReason() { return cancelReason; },
    async arrayBuffer() { throw new Error('arrayBuffer() must not be used by the bounded reader'); },
  };
}

// 3. Never-settling fetch is terminated by the attempt deadline + signal.
{
  const originalFetch = globalThis.fetch;
  const observed = [];
  globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    observed.push({ hasSignal: !!init.signal });
    init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  try {
    const attempt = createAttemptDeadline(20);
    let rejection = null;
    try { await globalThis.fetch('https://example.invalid/runtime/bootstrap', { signal: attempt.signal }); }
    catch (error) { rejection = error; }
    assert.ok(rejection, 'a never-settling fetch must reject once the attempt deadline fires');
    assert.equal(observed[0].hasSignal, true, 'the fetch must receive the composed AbortSignal');
    attempt.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// 4. dispose() clears only the timer: a completed attempt must never abort (a
//    late abort races Chromium's body-stream finalization), while an expired
//    undisposed deadline still fires.
{
  const attempt = createAttemptDeadline(10_000);
  assert.equal(attempt.signal.aborted, false);
  attempt.dispose();
  attempt.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(attempt.signal.aborted, false, 'a disposed (completed) attempt must not be aborted');
  const fired = createAttemptDeadline(15);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired.signal.aborted, true, 'an undisposed attempt must still hit its deadline');
}

// 5. Declared Content-Length above budget is rejected before body materialization.
{
  const response = streamResponse({ chunks: [new Uint8Array([1, 2, 3])], headers: { 'content-length': `${32 * 1024 * 1024 + 1}` } });
  await assert.rejects(
    () => readBoundedBytes(response, { maxBytes: 1024, overBudgetMessage: 'OVER', mismatchMessage: 'MISMATCH' }),
    /OVER/,
  );
}

// 6. Declared Content-Length mismatching the manifest exact authority is rejected pre-body.
{
  const response = streamResponse({ chunks: [new Uint8Array([1, 2, 3])], headers: { 'content-length': '2' } });
  await assert.rejects(
    () => readBoundedBytes(response, { maxBytes: 1024, exactBytes: 3, overBudgetMessage: 'OVER', mismatchMessage: 'MISMATCH' }),
    /MISMATCH/,
  );
}

// 7. A chunked oversized body is stopped and cancelled exactly at the bound.
{
  const chunks = [0, 1, 2, 3].map(() => new Uint8Array(512).fill(7));
  const response = streamResponse({ chunks });
  let thrown = null;
  try {
    await readBoundedBytes(response, { maxBytes: 1024, overBudgetMessage: 'OVER', mismatchMessage: 'MISMATCH' });
  } catch (error) { thrown = error; }
  assert.match(String(thrown?.message), /OVER/, 'streaming must stop once retained bytes exceed the budget');
  assert.ok(chunks.slice(0, 3).every((chunk) => chunk.every((value) => value === 0)), 'retained/offending partial buffers must be zeroed on rejection');
  assert.ok(chunks[3].every((value) => value === 7), 'the reader must cancel exactly at the bound instead of consuming the rest');
}

// 8. Exact bound equality is admitted; shorter/longer final counts fail closed.
{
  const ok = await readBoundedBytes(
    streamResponse({ chunks: [new Uint8Array([1, 2]), new Uint8Array([3])] }),
    { maxBytes: 8, exactBytes: 3, overBudgetMessage: 'OVER', mismatchMessage: 'MISMATCH' },
  );
  assert.deepEqual([...ok], [1, 2, 3]);
  await assert.rejects(
    () => readBoundedBytes(streamResponse({ chunks: [new Uint8Array([1, 2])] }), { maxBytes: 8, exactBytes: 3, overBudgetMessage: 'OVER', mismatchMessage: 'MISMATCH' }),
    /MISMATCH/, 'a body shorter than the manifest must fail closed before crypto');
  await assert.rejects(
    () => readBoundedBytes(streamResponse({ chunks: [new Uint8Array([1, 2, 3, 4])] }), { maxBytes: 8, exactBytes: 3, overBudgetMessage: 'OVER', mismatchMessage: 'MISMATCH' }),
    /MISMATCH/, 'a body longer than the manifest must fail closed before crypto');
}

// 9. A missing body stream fails closed instead of falling back to arrayBuffer().
{
  await assert.rejects(
    () => readBoundedBytes({ status: 200, headers: { get: () => null }, body: null }, { maxBytes: 8, overBudgetMessage: 'OVER', mismatchMessage: 'MISMATCH' }),
    /bounded response body stream is required/,
  );
}

// 10. A stalled/failed stream rejects the attempt without retaining partial bytes.
{
  const response = streamResponse({ chunks: [new Uint8Array(64).fill(9), new Uint8Array(64).fill(9), new Uint8Array(64).fill(9), new Uint8Array(64).fill(9)], failAfter: 2 });
  await assert.rejects(
    () => readBoundedBytes(response, { maxBytes: 4096, exactBytes: 4096, overBudgetMessage: 'OVER', mismatchMessage: 'MISMATCH' }),
    /simulated body stall\/abort/,
  );
}

// 11. Bounded JSON text reads share the same authority (bootstrap preflight).
{
  const json = JSON.stringify({ buildId: 'b', expiry: 'future', manifest: { byteLength: 3 } });
  const bytes = new TextEncoder().encode(json);
  const mid = Math.floor(bytes.byteLength / 2);
  const response = streamResponse({ chunks: [bytes.slice(0, mid), bytes.slice(mid)], headers: { 'content-length': String(bytes.byteLength) } });
  assert.deepEqual(JSON.parse(await readBoundedText(response, { maxBytes: 4096, overBudgetMessage: 'OVER', mismatchMessage: 'MISMATCH' })), JSON.parse(json));
  await assert.rejects(
    () => readBoundedText(streamResponse({ chunks: [new Uint8Array(64).fill(0x20)] }), { maxBytes: 8, overBudgetMessage: 'OVER', mismatchMessage: 'MISMATCH' }),
    /OVER/, 'an oversized chunked bootstrap body must be rejected early',
  );
}

// 12. gzip decompression enforces its plaintext ceiling and zeroizes retained output.
{
  const source = Buffer.alloc(4 * 1024 * 1024, 0x41);
  const gzipped = new Uint8Array(gzipSync(source));
  const exact = await decompressGzipExact(gzipped, 8 * 1024 * 1024);
  assert.equal(exact.byteLength, source.length, 'valid plaintext below the ceiling still decompresses exactly');
  let bomb = null;
  try { await decompressGzipExact(gzipped, 1024); } catch (error) { bomb = error; }
  assert.ok(bomb instanceof RangeError, 'plaintext beyond the ceiling must fail closed');
  assert.match(String(bomb.message), /decompression byte budget/);
  await assert.rejects(
    () => decompressGzipExact(gzipped, 0),
    /positive safe integer/,
    'an invalid ceiling must fail closed instead of degenerating to unbounded reads',
  );
}

// 13. Retries stay bounded: repeated admission rejections never accumulate memory.
{
  let totalEnqueued = 0;
  const chunk = new Uint8Array(1024 * 1024);
  for (let attempt = 0; attempt < 3; attempt++) {
    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        totalEnqueued += 1;
        controller.enqueue(totalEnqueued > 40 ? new Uint8Array(0) : chunk);
        if (totalEnqueued > 40) controller.close();
      },
    });
    let error = null;
    try { await readBoundedBytes({ status: 200, headers: { get: () => null }, body }, { maxBytes: 2 * 1024 * 1024, overBudgetMessage: 'OVER', mismatchMessage: 'MISMATCH' }); }
    catch (thrown) { error = thrown; }
    assert.match(String(error?.message), /OVER/, `attempt ${attempt} must reject at the bound`);
  }
  assert.ok(totalEnqueued <= 40 * 3, `stream cancellation must bound consumed chunks, saw ${totalEnqueued}`);
}

console.log('issue-8927 secure loader network admission: ok');

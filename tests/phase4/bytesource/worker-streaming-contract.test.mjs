import assert from 'node:assert/strict';
import test from 'node:test';
import { machoBytes, workerClient } from '../../helpers/performance-worker.mjs';

const BLOCK = 256 * 1024;
let instance = 0;
async function withWorker(run) {
  // Fresh module state for each case; all imports below it are the real owners.
  const client = await workerClient(new URL(`../../../js/platform/worker.js?stream-contract=${++instance}`, import.meta.url));
  try { return await run(client, globalThis.self); }
  finally { client.close(); }
}
function assertHits(result, offsets) {
  assert.deepEqual(result.results.map(hit => hit.byteOff), offsets);
  for (const hit of result.results) {
    assert.equal(hit.row, Math.floor(hit.byteOff / 4));
    assert.equal(hit.addr, 0x700000n + BigInt(hit.byteOff));
  }
}
async function openSource(client, bytes, source) {
  await client.request({ t: 'open', file: source });
  await client.request({ t: 'setRegions', regions: [
    { id: 'raw', fileOffset: 104, vmAddr: 0x700000n, size: bytes.length - 104 },
  ] });
}
const searchText = (client, query, from = 0) => client.request({ t: 'search', regionId: 'raw', kind: 'text', query, from });

test('worker consumes lazy dense overlaps at the unchanged 1000-hit cap', { timeout: 10000 }, async () => {
  await withWorker(async client => {
    await client.open(machoBytes(new Uint8Array(8192).fill(0x61)));
    for (const length of [1, 2, 3, 128, 4096, 4097]) {
      const result = await searchText(client, 'A'.repeat(length), 11);
      assertHits(result, Array.from({ length: 1000 }, (_, i) => 11 + i));
      assert.equal(result.cancelled, false);
      assert.equal(result.capped, true);
    }
    const last = await searchText(client, 'AAA', 8190);
    assertHits(last, []);
    assert.equal(last.capped, false);
    assert.equal(last.scanned, 2);
  });
});

test('worker preserves overlapping matches spanning a scan-block boundary exactly once', { timeout: 10000 }, async () => {
  await withWorker(async client => {
    const payload = new Uint8Array(2 * BLOCK + 16);
    const runStart = BLOCK - 129, runLength = 258;
    payload.fill(0x61, runStart, runStart + runLength);
    await client.open(machoBytes(payload));
    const expected = Array.from({ length: runLength - 128 + 1 }, (_, i) => runStart + i);
    assertHits(await searchText(client, 'A'.repeat(128)), expected);
    assertHits(await searchText(client, 'A'.repeat(128), runStart + 1), expected.slice(1));
    const masks = Array.from({ length: 128 }, (_, i) => [255, 0x0f, 0xf0][i % 3]);
    const result = await client.request({ t: 'search', regionId: 'raw', kind: 'hex',
      hex: { bytes: masks.map(mask => 0x61 & mask), mask: masks }, from: 0 });
    assertHits(result, expected);
    assert.equal(result.capped, false);
    assert.equal(result.scanned, payload.length);
  });
});

test('worker recaptures mutable query bytes after each awaited chunk rather than caching a stale pattern', { timeout: 10000 }, async () => {
  await withWorker(async client => {
    const payload = new Uint8Array(2 * BLOCK + 16);
    payload.set([65, 65, 65], 100);
    payload.set([66, 66, 66], BLOCK + 20);
    const bytes = machoBytes(payload), pattern = [65, 65, 65];
    let armed = false, mutated = 0;
    await openSource(client, bytes, { size: bytes.length, async read(offset, length) {
      if (armed && offset >= 2n * BigInt(BLOCK)) { pattern.fill(66); mutated++; }
      return bytes.subarray(Number(offset), Number(offset) + length);
    } });
    armed = true;
    const result = await client.request({ t: 'search', regionId: 'raw', kind: 'hex',
      hex: { bytes: pattern, mask: [255, 255, 255] }, from: 0 });
    assert.equal(mutated, 1);
    assertHits(result, [100, BLOCK + 20]);
  });
});

for (const ceiling of [17, 65536]) {
  test(`worker respects a ${ceiling}-byte backend ceiling while assembling logical reads`, { timeout: 15000 }, async () => {
    await withWorker(async client => {
      const payload = new Uint8Array(ceiling === 17 ? 2048 : BLOCK + 32).fill(0x78);
      payload.set([65, 66, 67, 68], payload.length - 8);
      const bytes = machoBytes(payload), reads = [];
      const source = { size: bytes.length, maxReadLength: ceiling, async read(offset, length) {
        assert.ok(length <= ceiling, `physical read ${length} exceeded ${ceiling}`);
        reads.push({ offset, length });
        return bytes.subarray(Number(offset), Number(offset) + length);
      } };
      const detected = await client.request({ t: 'detect', file: source });
      assert.equal(detected.formatId, 'macho');
      await openSource(client, bytes, source);
      assertHits(await searchText(client, 'abcd'), [payload.length - 8]);
      const stats = await client.request({ t: 'memoryStats' });
      assert.ok(stats.bytesCached <= Math.min(8 * 1024 * 1024, 32 * ceiling), 'small backend pages must not explode the cache entry budget');
      assert.ok(reads.length > 1);
      assert.ok(reads.every(({ length }) => length <= ceiling));
    });
  });
}

for (const capped of [false, true]) {
  test(`cancellation received at the terminal search progress cannot publish success (capped=${capped})`, { timeout: 10000 }, async () => {
    await withWorker(async (client, scope) => {
      await client.open(machoBytes(new Uint8Array(4096).fill(65)));
      const post = scope.postMessage.bind(scope);
      let cancellations = 0;
      scope.postMessage = message => {
        post(message);
        if (message.t === 'searchProgress') {
          cancellations++;
          void scope.onmessage({ data: { t: 'cancel', epoch: message.epoch, requestId: message.requestId } });
        }
      };
      const result = await searchText(client, capped ? 'AAA' : 'missing');
      assert.equal(cancellations, 1);
      assert.equal(result.cancelled, true);
      assert.equal(result.capped, false);
      assert.equal(result.results.length, capped ? 1000 : 0);
    });
  });
}

test('an immediately fulfilled source yields between chunks so a queued cancellation can run', { timeout: 10000 }, async () => {
  await withWorker(async (client, scope) => {
    await client.open(machoBytes(new Uint8Array(3 * BLOCK + 10).fill(65)));
    const post = scope.postMessage.bind(scope);
    let timer = null, progressCount = 0, cancelDelivered = false;
    scope.postMessage = message => {
      post(message);
      if (message.t === 'searchProgress' && ++progressCount === 1) {
        timer = setTimeout(() => {
          cancelDelivered = true;
          void scope.onmessage({ data: { t: 'cancel', epoch: message.epoch, requestId: message.requestId } });
        }, 0);
      }
    };
    try {
      const result = await searchText(client, 'absent');
      assert.equal(cancelDelivered, true, 'promise-only paging must not starve cancellation tasks until scan completion');
      assert.equal(result.cancelled, true);
      assert.equal(result.capped, false);
      assert.ok(result.scanned <= BLOCK);
      assert.equal(progressCount, 1);
    } finally { if (timer !== null) clearTimeout(timer); }
  });
});

test('worker string scanning preserves UTF-8 boundaries, whole-run offsets and input-budget completeness', { timeout: 10000 }, async () => {
  await withWorker(async client => {
    const payload = new Uint8Array(BLOCK + 64), text = 'A😀日本語Z';
    const encoded = new TextEncoder().encode(text), at = BLOCK - 3;
    payload.set(encoded, at);
    await client.open(machoBytes(payload));
    const result = await client.request({ t: 'strings', regionId: 'raw', min: 2, limit: 20 });
    assert.deepEqual(result.results, [{ addr: 0x700000n + BigInt(at), offset: at, text, byteLength: encoded.length }]);
    assert.equal(result.complete, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.capped, false);
    const budgeted = await client.request({ t: 'strings', regionId: 'raw', min: 2, limit: 20, maxBytes: 128 });
    assert.equal(budgeted.complete, false);
    assert.equal(budgeted.truncationReason, 'input-budget');
    assert.equal(budgeted.scannedBytes, 128);
    assert.deepEqual(budgeted.results, []);
  });
});

for (const capped of [false, true]) {
  test(`terminal string-scan cancellation wins before flushing the pending run (capped=${capped})`, { timeout: 10000 }, async () => {
    await withWorker(async (client, scope) => {
      const payload = capped ? new TextEncoder().encode('ABC\0DEF\0') : new Uint8Array(4096).fill(65);
      await client.open(machoBytes(payload));
      const post = scope.postMessage.bind(scope);
      scope.postMessage = message => {
        post(message);
        if (message.t === 'scanProgress') {
          void scope.onmessage({ data: { t: 'cancel', epoch: message.epoch, requestId: message.requestId } });
        }
      };
      const result = await client.request({ t: 'strings', regionId: 'raw', min: 2, limit: capped ? 1 : 20 });
      assert.equal(result.cancelled, true);
      assert.equal(result.complete, false);
      assert.equal(result.capped, false);
      assert.deepEqual(result.results.map(entry => entry.text), capped ? ['ABC'] : []);
    });
  });
}

test('string scanning permits queued cancellation between immediately fulfilled chunk reads', { timeout: 10000 }, async () => {
  await withWorker(async (client, scope) => {
    await client.open(machoBytes(new Uint8Array(3 * BLOCK + 10).fill(65)));
    const post = scope.postMessage.bind(scope);
    let timer = null, progressCount = 0;
    scope.postMessage = message => {
      post(message);
      if (message.t === 'scanProgress' && ++progressCount === 1) {
        timer = setTimeout(() => {
          void scope.onmessage({ data: { t: 'cancel', epoch: message.epoch, requestId: message.requestId } });
        }, 0);
      }
    };
    try {
      const result = await client.request({ t: 'strings', regionId: 'raw', min: 2, limit: 20 });
      assert.equal(result.cancelled, true);
      assert.equal(result.complete, false);
      assert.equal(result.capped, false);
      assert.equal(result.scannedBytes, BLOCK);
      assert.deepEqual(result.results, []);
    } finally { if (timer !== null) clearTimeout(timer); }
  });
});


test('worker hash dispatches a queued cancellation before starting another logical chunk', { timeout: 10000 }, async () => {
  await withWorker(async (client, scope) => {
    await client.open(machoBytes(new Uint8Array(3 * 1024 * 1024 + 8).fill(65)));
    const post = scope.postMessage.bind(scope);
    let timer = null, progressCount = 0, cancelDelivered = false;
    scope.postMessage = message => {
      post(message);
      if (message.t === 'analysisProgress' && message.phase === 'hash' && ++progressCount === 1) {
        timer = setTimeout(() => {
          cancelDelivered = true;
          void scope.onmessage({ data: { t: 'cancel', epoch: message.epoch, requestId: message.requestId } });
        }, 0);
      }
    };
    try {
      await assert.rejects(client.request({ t: 'hash' }), /cancel/i);
      assert.equal(cancelDelivered, true);
      assert.equal(progressCount, 1, 'no hash identity or additional progress may escape cancellation');
      const stats = await client.request({ t: 'memoryStats' });
      assert.equal(stats.pendingReads, 0);
    } finally { if (timer !== null) clearTimeout(timer); }
  });
});

test('cancelling one cooperative worker hash preserves the other request and the original identity', { timeout: 10000 }, async () => {
  await withWorker(async (client, scope) => {
    await client.open(machoBytes(new Uint8Array(3 * 1024 * 1024 + 8).fill(65)));
    const post = scope.postMessage.bind(scope);
    let timer = null, target = null, delivered = false;
    scope.postMessage = message => {
      post(message);
      if (message.t === 'analysisProgress' && message.phase === 'hash' && target === null) {
        target = message.requestId;
        timer = setTimeout(() => {
          delivered = true;
          void scope.onmessage({ data: { t: 'cancel', epoch: message.epoch, requestId: target } });
        }, 0);
      }
    };
    try {
      const cancelled = assert.rejects(client.request({ t: 'hash' }), /cancel/i);
      const survivor = client.request({ t: 'hash' });
      const [, result] = await Promise.all([cancelled, survivor]);
      assert.equal(delivered, true);
      // Fixed vector captured before changing the worker scheduling adapter;
      // the independent FNV/leaf oracle covers the underlying hash algorithm.
      assert.deepEqual(result, { hash: 'fnv1a64:300070:97c7b0c34b92b258' });
      const stats = await client.request({ t: 'memoryStats' });
      assert.equal(stats.pendingReads, 0);
    } finally { if (timer !== null) clearTimeout(timer); }
  });
});

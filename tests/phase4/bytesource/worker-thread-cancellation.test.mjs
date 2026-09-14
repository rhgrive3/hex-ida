import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { machoBytes } from '../../helpers/performance-worker.mjs';

// Separate event loop and structured-clone transport, not a synchronous self
// substitute. This exercises Node worker threads; browser/device acceptance
// remains a distinct gate. Only the transport bootstrap is test-specific.
async function realClient() {
  const thread = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    globalThis.self = { postMessage(message, transfer) { parentPort.postMessage(message, transfer); } };
    import(workerData.entry).then(() => {
      parentPort.on('message', data => { void self.onmessage({ data }); });
      parentPort.postMessage({ t: 'ready' });
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { entry: new URL('../../../js/platform/worker.js', import.meta.url).href } });
  let next = 0, readyResolve, readyReject;
  const waiting = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const rejectAll = error => {
    readyReject(error);
    for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(error); }
    waiting.clear();
  };
  thread.on('error', rejectAll);
  thread.on('exit', code => rejectAll(new Error(`worker exited (${code})`)));
  thread.on('message', message => {
    if (message.t === 'ready') { readyResolve(); return; }
    if (message.t === 'ok' || message.t === 'err') {
      const entry = waiting.get(message.id);
      if (!entry) return;
      waiting.delete(message.id);
      clearTimeout(entry.timer);
      if (message.t === 'ok') entry.resolve(message.result);
      else entry.reject(new Error(message.error));
      return;
    }
    waiting.get(message.requestId)?.progress?.(message);
  });
  const startupDeadline = setTimeout(() => readyReject(new Error('worker startup deadline exceeded')), 5000);
  try { await ready; } catch (error) { await thread.terminate(); throw error; }
  finally { clearTimeout(startupDeadline); }
  return {
    request(t, payload = {}, progress = null) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error('worker request deadline exceeded')); }, 5000);
        waiting.set(id, { resolve, reject, progress, timer });
        try { thread.postMessage({ ...payload, t, id, epoch: 1 }); }
        catch (error) { clearTimeout(timer); waiting.delete(id); reject(error); }
      });
    },
    cancel(id) { thread.postMessage({ t: 'cancel', requestId: id, epoch: 1 }); },
    close() { return thread.terminate(); },
  };
}

for (const operation of ['hash', 'search', 'strings']) {
  test(`real worker dispatches ${operation} cancellation on a warm multi-chunk source`, { timeout: 15000 }, async () => {
    const client = await realClient();
    try {
      const payload = new Uint8Array(7 * 1024 * 1024 + 16).fill(65);
      const bytes = machoBytes(payload);
      await client.request('open', { file: new Blob([bytes]) });
      await client.request('setRegions', { regions: [{ id: 'raw', fileOffset: 104, vmAddr: 0x700000n, size: payload.length }] });
      // All bytes fit in the cache, so subsequent reads need no Blob I/O that
      // could accidentally hide a missing cooperative task boundary.
      const identity = await client.request('hash');
      assert.match(identity.hash, /^fnv1a64:/);
      let requested = false;
      const progress = message => {
        const relevant = operation === 'hash' ? message.t === 'analysisProgress' && message.phase === 'hash'
          : message.t === (operation === 'search' ? 'searchProgress' : 'scanProgress');
        if (relevant && !requested) { requested = true; client.cancel(message.requestId); }
      };
      const result = client.request(operation, operation === 'search'
        ? { regionId: 'raw', kind: 'text', query: 'absent', from: 0 }
        : operation === 'strings' ? { regionId: 'raw', min: 2, limit: 20 } : {}, progress);
      if (operation === 'hash') await assert.rejects(result, /cancel/i);
      else {
        const cancelled = await result;
        assert.equal(cancelled.cancelled, true);
        assert.equal(cancelled.capped, false);
        assert.ok((cancelled.scanned ?? cancelled.scannedBytes) < payload.length);
        if (operation === 'strings') assert.equal(cancelled.complete, false);
      }
      assert.equal(requested, true);
      assert.deepEqual(await client.request('hash'), identity, 'cancelled requests must not corrupt the reusable source');
      assert.equal((await client.request('memoryStats')).pendingReads, 0);
    } finally { await client.close(); }
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { analyzeFunctionCached, clearAnalysisCache } from '../js/analyze.js';

function mockBackend(chunkDelayMs = 20) {
  return {
    async fetchChunk(_regionId, chunkIndex) {
      if (chunkDelayMs > 0) await delay(chunkDelayMs);
      return {
        mn: ['mov', 'ret'],
        ops: ['x0, #1', ''],
        bytes: new Uint8Array([0x20, 0x00, 0x80, 0xd2, 0xc0, 0x03, 0x5f, 0xd6]),
      };
    },
    async readAt() {
      return null;
    },
  };
}

const region = { id: 'r_test', exec: true, vmAddr: 0x1000n, size: 0x2000n };

test('#5354: concurrent callers to analyzeFunctionCached both receive progress updates', async () => {
  clearAnalysisCache();
  const backend = mockBackend(25);
  // startRow 0 to 600 crosses multiple 256-row chunks (chunk 0, 1, 2)
  const startRow = 0;
  const endRow = 600;
  const symbols = [];

  const progress1 = [];
  const progress2 = [];

  const p1 = analyzeFunctionCached(backend, region, startRow, endRow, symbols, (p) => progress1.push(p), { texts: false });
  // Ensure p1 creates the inflight entry before p2 joins
  await Promise.resolve();
  const p2 = analyzeFunctionCached(backend, region, startRow, endRow, symbols, (p) => progress2.push(p), { texts: false });

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.ok(res1);
  assert.ok(res2);
  assert.ok(progress1.length > 0, 'first caller received progress updates');
  assert.ok(progress2.length > 0, 'second concurrent caller MUST receive progress updates (#5354)');
  assert.equal(progress2[progress2.length - 1], 1, 'second caller finishes at 100% progress');
});

test('#5354: late-joining concurrent caller receives last-known progress and subsequent progress', async () => {
  clearAnalysisCache();
  const backend = mockBackend(40);
  const startRow = 0;
  const endRow = 600;
  const symbols = [];

  const progress1 = [];
  const progress2 = [];

  const p1 = analyzeFunctionCached(backend, region, startRow, endRow, symbols, (p) => progress1.push(p), { texts: false });
  // Wait until at least the first chunk completes
  await delay(50);
  assert.ok(progress1.length >= 1, 'first caller has already seen progress');

  const p2 = analyzeFunctionCached(backend, region, startRow, endRow, symbols, (p) => progress2.push(p), { texts: false });

  await Promise.all([p1, p2]);

  assert.ok(progress2.length > 0, 'late-joining caller received progress');
  assert.equal(progress2[progress2.length - 1], 1);
});

test('#5354: aborting one caller does not cancel producer for other caller nor stop their progress', async () => {
  clearAnalysisCache();
  const backend = mockBackend(30);
  const startRow = 0;
  const endRow = 600;
  const symbols = [];

  const progress1 = [];
  const progress2 = [];
  const ac2 = new AbortController();

  const p1 = analyzeFunctionCached(backend, region, startRow, endRow, symbols, (p) => progress1.push(p), { texts: false });
  await Promise.resolve();
  const p2 = analyzeFunctionCached(backend, region, startRow, endRow, symbols, (p) => progress2.push(p), { texts: false, signal: ac2.signal });

  // Abort caller 2 after starting
  await delay(15);
  ac2.abort('cancelled-by-user');

  await assert.rejects(p2, /cancelled-by-user/);
  const res1 = await p1;
  assert.ok(res1);
  assert.ok(progress1.length > 0);
  assert.equal(progress1[progress1.length - 1], 1);
});

test('#5354: throwing onProgress listener does not fail the producer or other listeners', async () => {
  clearAnalysisCache();
  const backend = mockBackend(25);
  const startRow = 0;
  const endRow = 600;
  const symbols = [];

  const progress1 = [];

  const p1 = analyzeFunctionCached(backend, region, startRow, endRow, symbols, () => {
    throw new Error('faulty-listener');
  }, { texts: false });
  await Promise.resolve();
  const p2 = analyzeFunctionCached(backend, region, startRow, endRow, symbols, (p) => progress1.push(p), { texts: false });

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.ok(res1);
  assert.ok(res2);
  assert.ok(progress1.length > 0);
  assert.equal(progress1[progress1.length - 1], 1);
});

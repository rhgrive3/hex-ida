// Regression for #5204: two overlapping provision() calls for the same slot
// index each enumerated the missing slot and created their own iframe — the
// later provisionSlot() overwrote the earlier one's map entry, and the
// earlier live iframe/runtime stayed ready but unreachable from the pool.
// Contract now: per-slot single-flight — a concurrent provision of the same
// index joins the in-flight work instead of duplicating it (one frame
// created), and a slot that lost its map entry is retired instead of being
// advertised as ready.
import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { IframeWorkerPool } from '../../js/userscript/dev/frame-mesh/iframe-worker-pool.js';

class FakeDocument {}

class FakeFrameFactory {
  constructor() { this.created = []; }
  create({ slot }) {
    const factory = this;
    const contentDocument = { readyState: 'complete', composer: true };
    const frame = {
      slot, src: null, removed: false, style: { cssText: '' },
      get contentDocument() { return this.src ? contentDocument : null; },
    };
    this.created.push(frame);
    return {
      frame,
      async navigate(href) { frame.src = href; },
      close() { frame.removed = true; },
    };
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function newPool(frames, { maxWorkers = 1 } = {}) {
  return new IframeWorkerPool({
    maxWorkers,
    createFrame: (args) => frames.create(args),
    createWorkerRuntime: () => ({
      coordinator: { async discover() { return []; } },
      ready: () => true,
      close() {},
    }),
    documentRef: new FakeDocument(),
    cryptoRef: webcrypto,
    location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
    sleep: async () => tick(),
  });
}

test('#5204 concurrent provision of the same slot creates one frame, no orphans', async () => {
  const frames = new FakeFrameFactory();
  const pool = newPool(frames, { maxWorkers: 1 });

  const [r1, r2] = await Promise.all([
    pool.provision({ size: 1, timeoutMs: 2000 }),
    pool.provision({ size: 1, timeoutMs: 2000 }),
  ]);

  assert.equal(frames.created.length, 1, 'the same slot must be provisioned exactly once');
  assert.equal(frames.created.filter((frame) => !frame.removed).length, 1, 'no unreachable live iframe may remain');
  assert.equal(pool.readyCount(), 1);
  assert.equal(r1.created.length, 1);
  assert.equal(r2.created.length, 1, 'both provisions report the ready slot');
  pool.close();
  assert.equal(frames.created.every((frame) => frame.removed), true, 'close() removes the single frame');
});

test('#5204 sequential re-provision still replaces a not-ready slot', async () => {
  const frames = new FakeFrameFactory();
  const pool = newPool(frames, { maxWorkers: 1 });

  const first = await pool.provision({ size: 1, timeoutMs: 2000 });
  assert.equal(first.created.length, 1);
  // After the first provision completed, a second provision sees a ready
  // slot and creates nothing.
  const second = await pool.provision({ size: 1, timeoutMs: 2000 });
  assert.equal(second.created.length, 0);
  assert.equal(frames.created.length, 1);
  pool.close();
});

test('#5204 close() during an in-flight provision never poisons the fresh generation (review R1)', async () => {
  let releaseFirstCreate;
  const firstCreatePromise = new Promise((resolve) => { releaseFirstCreate = resolve; });
  let createCalls = 0;
  const frames = new FakeFrameFactory();
  const pool = newPool({
    created: [],
    create({ slot }) {
      createCalls += 1;
      if (createCalls === 1) {
        // Block the old generation's frame creation until the test closes the pool.
        return firstCreatePromise.then(() => frames.create({ slot }));
      }
      return frames.create({ slot });
    },
  }, { maxWorkers: 1 });

  const stale = pool.provision({ size: 1, timeoutMs: 2000 });
  await tick();
  assert.equal(createCalls, 1, 'the first provisioning must be in flight');

  pool.close();
  // Immediate fresh provision after close: it must NOT join the stale
  // in-flight entry — it creates a fresh frame for the new generation.
  const fresh = pool.provision({ size: 1, timeoutMs: 2000 });
  await tick();
  await tick();
  assert.equal(createCalls, 2, 'the fresh generation must create its own frame');

  releaseFirstCreate();
  const [staleResult, freshResult] = await Promise.all([stale, fresh]);
  assert.equal(staleResult.created.length, 0, 'the stale-generation provision stays retired');
  assert.equal(freshResult.created.length, 1, 'the fresh provision must be ready');
  assert.equal(pool.readyCount(), 1, 'the close→fresh-provision boundary still yields a ready slot');
  assert.equal(frames.created.filter((frame) => !frame.removed).length, 1);
  pool.close();
});

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach, after } from 'node:test';

const unhandledRejections = [];
const onUnhandledRejection = (reason) => {
  unhandledRejections.push(reason);
};
process.on('unhandledRejection', onUnhandledRejection);

// Save original globals so tests can mutate navigator/document/Worker safely.
const origDocumentDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
const origNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const origWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

function restoreGlobal(name, desc) {
  if (desc) {
    Object.defineProperty(globalThis, name, desc);
  } else {
    delete globalThis[name];
  }
}

function makeFakeDocument(hidden = false) {
  const listeners = new Map();
  return {
    hidden,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn();
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
  };
}

class MockWorker {
  constructor(onPost = null) {
    this.sent = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this._onPost = onPost;
  }

  postMessage(msg, transfer) {
    if (this.terminated) throw new Error('Worker already terminated');
    this.sent.push({ msg, transfer });
    if (typeof this._onPost === 'function') {
      this._onPost(this, msg, transfer);
    }
  }

  emitMessage(data) {
    if (this.terminated || !this.onmessage) return;
    this.onmessage({ data });
  }

  emitError(message = 'worker crashed') {
    if (this.terminated || !this.onerror) return;
    this.onerror({ message });
  }

  emitMessageError(message = 'worker messageerror') {
    if (this.terminated || !this.onmessageerror) return;
    this.onmessageerror({ message });
  }

  terminate() {
    this.terminated = true;
  }
}

function makeFakeFile(sizeBytes, fillWord = 0xd65f03c0 /* ARM64 RET */) {
  const buf = new ArrayBuffer(sizeBytes);
  const dv = new DataView(buf);
  for (let off = 0; off + 4 <= sizeBytes; off += 4) {
    dv.setUint32(off, fillWord, true);
  }
  return {
    name: 'synthetic.bin',
    size: sizeBytes,
    slice(start = 0, end = sizeBytes) {
      const s = Math.max(0, Math.min(sizeBytes, Number(start)));
      const e = Math.max(s, Math.min(sizeBytes, Number(end)));
      return {
        async arrayBuffer() {
          return buf.slice(s, e);
        },
      };
    },
  };
}

function flushMicrotasks(turns = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i++) p = p.then(() => {});
  return p;
}

const { ScanWorkerPool } = await import('../js/scan-pool.js');
const {
  isMobileDevice,
  computeMaxScanWorkers,
  computeWaveConcurrency,
} = await import('../js/scan-planner.js');
const { Backend, StaleRequestError } = await import('../js/backend.js');

const MiB = 1024 * 1024;

describe('ScanWorkerPool & scan-planner concurrency and device caps', () => {
  afterEach(() => {
    restoreGlobal('document', origDocumentDesc);
    restoreGlobal('navigator', origNavigatorDesc);
    restoreGlobal('Worker', origWorkerDesc);
  });

  it('detects mobile/iPad/Android/MacIntel+touch devices and caps workers at <= 2; desktop <= 4; hidden === 1', () => {
    // iPad UA
    assert.equal(isMobileDevice({ navigator: { userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' } }), true);
    assert.equal(computeMaxScanWorkers({
      navigator: { userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', hardwareConcurrency: 8 },
      document: { hidden: false },
    }), 2);

    // iPhone UA
    assert.equal(isMobileDevice({ navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } }), true);
    assert.equal(computeMaxScanWorkers({
      navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', hardwareConcurrency: 6 },
      document: { hidden: false },
    }), 2);

    // iPadOS desktop-class UA: MacIntel + maxTouchPoints > 1
    assert.equal(isMobileDevice({
      navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 },
    }), true);
    assert.equal(computeMaxScanWorkers({
      navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5, hardwareConcurrency: 8 },
      document: { hidden: false },
    }), 2);

    // Real macOS desktop: MacIntel + maxTouchPoints === 0
    assert.equal(isMobileDevice({
      navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 },
    }), false);

    // Android UA
    assert.equal(isMobileDevice({ navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' } }), true);
    assert.equal(computeMaxScanWorkers({
      navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', hardwareConcurrency: 8 },
      document: { hidden: false },
    }), 2);

    // userAgentData.mobile === true
    assert.equal(isMobileDevice({ navigator: { userAgentData: { mobile: true }, userAgent: 'CustomBrowser' } }), true);

    // Desktop concurrency formula: min(4, max(1, hardwareConcurrency || 2))
    const desktopNav = (hc) => ({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      platform: 'Linux x86_64',
      maxTouchPoints: 0,
      hardwareConcurrency: hc,
    });
    assert.equal(computeMaxScanWorkers({ navigator: desktopNav(16), document: { hidden: false } }), 4);
    assert.equal(computeMaxScanWorkers({ navigator: desktopNav(4), document: { hidden: false } }), 4);
    assert.equal(computeMaxScanWorkers({ navigator: desktopNav(3), document: { hidden: false } }), 3);
    assert.equal(computeMaxScanWorkers({ navigator: desktopNav(1), document: { hidden: false } }), 1);
    assert.equal(computeMaxScanWorkers({ navigator: desktopNav(0), document: { hidden: false } }), 2);
    assert.equal(computeMaxScanWorkers({ navigator: desktopNav(undefined), document: { hidden: false } }), 2);

    // document.hidden === true always caps at 1
    assert.equal(computeMaxScanWorkers({ navigator: desktopNav(16), document: { hidden: true } }), 1);
    assert.equal(computeMaxScanWorkers({
      navigator: { userAgent: 'iPad', hardwareConcurrency: 8 },
      document: { hidden: true },
    }), 1);
  });

  it('adaptively steps down wave concurrency (4 -> 2 -> 1 / 2 -> 1) when remainingBudget / activeWaveWorkers < 24 MiB', () => {
    // Desktop 4 -> 2 -> 1
    assert.equal(computeWaveConcurrency({ remainingBudget: 96 * MiB, maxWaveWorkers: 4, isMobile: false }), 4);
    assert.equal(computeWaveConcurrency({ remainingBudget: 96 * MiB - 1, maxWaveWorkers: 4, isMobile: false }), 2);
    assert.equal(computeWaveConcurrency({ remainingBudget: 48 * MiB, maxWaveWorkers: 4, isMobile: false }), 2);
    assert.equal(computeWaveConcurrency({ remainingBudget: 48 * MiB - 1, maxWaveWorkers: 4, isMobile: false }), 1);
    assert.equal(computeWaveConcurrency({ remainingBudget: 0, maxWaveWorkers: 4, isMobile: false }), 1);

    // Mobile 2 -> 1
    assert.equal(computeWaveConcurrency({ remainingBudget: 96 * MiB, maxWaveWorkers: 4, isMobile: true }), 2);
    assert.equal(computeWaveConcurrency({ remainingBudget: 48 * MiB, maxWaveWorkers: 2, isMobile: true }), 2);
    assert.equal(computeWaveConcurrency({ remainingBudget: 48 * MiB - 1, maxWaveWorkers: 2, isMobile: true }), 1);

    // Hidden tab always steps down to 1
    assert.equal(computeWaveConcurrency({ remainingBudget: 128 * MiB, maxWaveWorkers: 4, isMobile: false, hidden: true }), 1);
  });
});

describe('ScanWorkerPool lifecycle', () => {
  afterEach(() => {
    restoreGlobal('document', origDocumentDesc);
    restoreGlobal('navigator', origNavigatorDesc);
    restoreGlobal('Worker', origWorkerDesc);
  });

  it('enforces shared concurrency queue cap across simultaneous scanProgram + valueShapes tasks', async () => {
    setGlobal('document', makeFakeDocument(false));

    for (const cap of [2, 4]) {
      let peakBusy = 0;
      let spawned = 0;
      const pendingResponses = [];

      const pool = new ScanWorkerPool({
        maxWorkers: cap,
        idleTimeoutMs: 15_000,
        workerFactory: () => {
          spawned++;
          return new MockWorker((worker, msg) => {
            if (msg.t === 'cancel') return;
            peakBusy = Math.max(peakBusy, pool.busyWorkerCount);
            pendingResponses.push(() => {
              worker.emitMessage({ t: 'res', id: msg.id, epoch: msg.epoch, requestId: msg.requestId, ok: true, result: { task: msg.t, tag: msg.tag } });
            });
          });
        },
      });

      const tasks = [];
      for (let i = 0; i < cap * 3; i++) {
        const t = i % 2 === 0 ? 'scanProgramChunk' : 'scanShapesChunk';
        tasks.push(pool.runTask({ t, payload: { tag: i }, epoch: 1, requestId: i + 1 }));
      }

      assert.equal(pool.busyWorkerCount, cap);
      assert.equal(pool.queuedCount, cap * 2);
      assert.equal(spawned, cap);

      while (pendingResponses.length > 0) {
        const resolveNext = pendingResponses.shift();
        resolveNext();
        peakBusy = Math.max(peakBusy, pool.busyWorkerCount);
      }

      const results = await Promise.all(tasks);
      assert.equal(results.length, cap * 3);
      assert.ok(peakBusy <= cap, `peak busy workers ${peakBusy} must not exceed maxWorkers ${cap}`);
      assert.equal(peakBusy, cap);
      assert.equal(spawned, cap, 'workers should be reused without exceeding maxWorkers');
      pool.dispose();
    }
  });

  it('cancelRequest(epoch, requestId) cancels queued and in-flight tasks cleanly without UnhandledPromiseRejection', async () => {
    setGlobal('document', makeFakeDocument(false));
    const workers = [];
    const inflight = [];

    const pool = new ScanWorkerPool({
      maxWorkers: 1,
      idleTimeoutMs: 15_000,
      workerFactory: () => {
        const w = new MockWorker((worker, msg) => {
          if (msg.t !== 'cancel') inflight.push({ worker, msg });
        });
        workers.push(w);
        return w;
      },
    });

    const pInflight = pool.runTask({ t: 'scanProgramChunk', payload: { idx: 0 }, epoch: 2, requestId: 10 });
    const pQueuedSame = pool.runTask({ t: 'scanProgramChunk', payload: { idx: 1 }, epoch: 2, requestId: 10 });
    const pQueuedOther = pool.runTask({ t: 'scanProgramChunk', payload: { idx: 2 }, epoch: 2, requestId: 11 });

    assert.equal(pool.busyWorkerCount, 1);
    assert.equal(pool.queuedCount, 2);

    pool.cancelRequest(2, 10);

    await assert.rejects(pInflight, (e) => e?.name === 'AbortError' && e?.code === 'ABORT_ERR');
    await assert.rejects(pQueuedSame, (e) => e?.name === 'AbortError' && e?.code === 'ABORT_ERR');
    assert.equal(pool.queuedCount, 1, 'unrelated queued request must remain queued');

    // Verify worker received cancel notification
    assert.ok(
      workers[0].sent.some((s) => s.msg.t === 'cancel' && s.msg.epoch === 2 && s.msg.requestId === 10),
      'worker must receive cancel message for in-flight request',
    );

    // Submitting another task for the already-cancelled requestId must reject immediately
    const pLate = pool.runTask({ t: 'scanProgramChunk', payload: { idx: 3 }, epoch: 2, requestId: 10 });
    await assert.rejects(pLate, (e) => e?.name === 'AbortError' && e?.code === 'ABORT_ERR');

    // Worker finishes cancelled job and picks up unrelated queued job
    const first = inflight.shift();
    first.worker.emitMessage({ t: 'res', id: first.msg.id, epoch: 2, requestId: 10, ok: true, result: { cancelled: true } });

    assert.equal(inflight.length, 1, 'worker should immediately pump remaining queued task');
    const other = inflight.shift();
    other.worker.emitMessage({ t: 'res', id: other.msg.id, epoch: 2, requestId: 11, ok: true, result: { ok: 11 } });

    const otherRes = await pQueuedOther;
    assert.deepEqual(otherRes, { ok: 11 });
    pool.dispose();
  });

  it('cancelEpoch(epoch) rejects stale epoch tasks cleanly and allows newer epoch tasks', async () => {
    setGlobal('document', makeFakeDocument(false));
    const workers = [];
    const inflight = [];

    const pool = new ScanWorkerPool({
      maxWorkers: 1,
      idleTimeoutMs: 15_000,
      workerFactory: () => {
        const w = new MockWorker((worker, msg) => {
          if (msg.t !== 'cancel') inflight.push({ worker, msg });
        });
        workers.push(w);
        return w;
      },
    });

    const pOldInflight = pool.runTask({ t: 'scanStage1', epoch: 3, requestId: 1 });
    const pOldQueued = pool.runTask({ t: 'scanStage1', epoch: 3, requestId: 2 });

    pool.cancelEpoch(3);

    await assert.rejects(pOldInflight, (e) => e?.name === 'StaleRequestError' && e?.stale === true);
    await assert.rejects(pOldQueued, (e) => e?.name === 'StaleRequestError' && e?.stale === true);
    assert.ok(workers[0].sent.some((s) => s.msg.t === 'cancel' && s.msg.epoch === 3));

    // Submitting a stale epoch task rejects immediately
    const pStaleNew = pool.runTask({ t: 'scanStage1', epoch: 3, requestId: 3 });
    await assert.rejects(pStaleNew, (e) => e?.name === 'StaleRequestError' && e?.stale === true);

    // Submitting a fresh epoch task succeeds after worker finishes cancelled job
    const pFresh = pool.runTask({ t: 'scanStage1', epoch: 4, requestId: 4 });
    const cancelledJob = inflight.shift();
    cancelledJob.worker.emitMessage({ t: 'res', id: cancelledJob.msg.id, epoch: 3, requestId: 1, ok: true, result: { cancelled: true } });

    const freshJob = inflight.shift();
    assert.ok(freshJob && freshJob.msg.epoch === 4);
    freshJob.worker.emitMessage({ t: 'res', id: freshJob.msg.id, epoch: 4, requestId: 4, ok: true, result: { fresh: true } });

    assert.deepEqual(await pFresh, { fresh: true });
    pool.dispose();
  });

  it('onMemoryPressure() terminates idle workers immediately and retires busy workers immediately upon becoming idle', async () => {
    setGlobal('document', makeFakeDocument(false));
    const workers = [];
    const inflight = [];

    const pool = new ScanWorkerPool({
      maxWorkers: 2,
      idleTimeoutMs: 15_000,
      workerFactory: () => {
        const w = new MockWorker((worker, msg) => {
          if (msg.t !== 'cancel') inflight.push({ worker, msg });
        });
        workers.push(w);
        return w;
      },
    });

    // Spawn 2 workers
    const p1 = pool.runTask({ t: 'scanStage1', epoch: 1, requestId: 1 });
    const p2 = pool.runTask({ t: 'scanStage1', epoch: 1, requestId: 2 });
    assert.equal(pool.activeWorkerCount, 2);
    assert.equal(pool.busyWorkerCount, 2);

    // Finish worker 0 so it becomes idle while worker 1 stays busy
    const job0 = inflight[0];
    job0.worker.emitMessage({ t: 'res', id: job0.msg.id, epoch: 1, requestId: 1, ok: true, result: { done: 1 } });
    assert.deepEqual(await p1, { done: 1 });
    assert.equal(pool.activeWorkerCount, 2);
    assert.equal(pool.busyWorkerCount, 1);

    // Trigger memory pressure: idle worker 0 must terminate immediately; busy worker 1 stays alive with retireWhenIdle
    pool.onMemoryPressure();
    assert.equal(workers[0].terminated, true, 'idle worker must terminate immediately on memory pressure');
    assert.equal(workers[1].terminated, false, 'busy worker must NOT terminate mid-job on memory pressure');
    assert.equal(pool.activeWorkerCount, 1);

    // Complete worker 1's active job -> must terminate immediately on becoming idle (not wait 15s)
    const job1 = inflight[1];
    job1.worker.emitMessage({ t: 'res', id: job1.msg.id, epoch: 1, requestId: 2, ok: true, result: { done: 2 } });
    assert.deepEqual(await p2, { done: 2 });
    assert.equal(workers[1].terminated, true, 'busy worker marked retireWhenIdle must terminate immediately upon completion');
    assert.equal(pool.activeWorkerCount, 0);
    pool.dispose();
  });

  it('document.hidden === true terminates workers immediately upon becoming idle (not waiting 15s) and caps active workers at 1', async () => {
    const fakeDoc = makeFakeDocument(false);
    setGlobal('document', fakeDoc);
    const workers = [];
    const inflight = [];

    const pool = new ScanWorkerPool({
      maxWorkers: 4,
      idleTimeoutMs: 15_000,
      workerFactory: () => {
        const w = new MockWorker((worker, msg) => {
          if (msg.t !== 'cancel') inflight.push({ worker, msg });
        });
        workers.push(w);
        return w;
      },
    });

    const p1 = pool.runTask({ t: 'scanProgramChunk', epoch: 1, requestId: 1 });
    assert.equal(pool.activeWorkerCount, 1);

    // Tab becomes hidden while job is running
    fakeDoc.hidden = true;

    // Complete job -> worker must terminate immediately instead of parking on 15s timer
    const j1 = inflight.shift();
    j1.worker.emitMessage({ t: 'res', id: j1.msg.id, epoch: 1, requestId: 1, ok: true, result: { ok: true } });
    assert.deepEqual(await p1, { ok: true });
    assert.equal(workers[0].terminated, true, 'worker must terminate immediately on idle when document.hidden === true');
    assert.equal(pool.activeWorkerCount, 0);

    // Dispatching multiple tasks while hidden must cap active workers at 1
    const p2 = pool.runTask({ t: 'scanProgramChunk', epoch: 1, requestId: 2 });
    const p3 = pool.runTask({ t: 'scanProgramChunk', epoch: 1, requestId: 3 });
    assert.equal(pool.activeWorkerCount, 1, 'document.hidden === true must cap concurrent workers at 1');
    assert.equal(pool.queuedCount, 1);

    const j2 = inflight.shift();
    j2.worker.emitMessage({ t: 'res', id: j2.msg.id, epoch: 1, requestId: 2, ok: true, result: { ok: 2 } });
    assert.deepEqual(await p2, { ok: 2 });

    const j3 = inflight.shift();
    j3.worker.emitMessage({ t: 'res', id: j3.msg.id, epoch: 1, requestId: 3, ok: true, result: { ok: 3 } });
    assert.deepEqual(await p3, { ok: 3 });
    assert.equal(pool.activeWorkerCount, 0);
    pool.dispose();
  });

  it('dispose() rejects queued & in-flight tasks cleanly, terminates all workers immediately, and rejects post-dispose runTask() without spawning', async () => {
    setGlobal('document', makeFakeDocument(false));
    const workers = [];
    let spawnCount = 0;

    const pool = new ScanWorkerPool({
      maxWorkers: 2,
      idleTimeoutMs: 15_000,
      workerFactory: () => {
        spawnCount++;
        const w = new MockWorker();
        workers.push(w);
        return w;
      },
    });

    const p1 = pool.runTask({ t: 'scanStage1', epoch: 1, requestId: 1 });
    const p2 = pool.runTask({ t: 'scanStage1', epoch: 1, requestId: 2 });
    const pQueued = pool.runTask({ t: 'scanStage1', epoch: 1, requestId: 3 });
    assert.equal(spawnCount, 2);
    assert.equal(pool.queuedCount, 1);

    pool.dispose();
    assert.equal(pool.disposed, true);
    assert.equal(pool.activeWorkerCount, 0);
    assert.equal(pool.queuedCount, 0);
    assert.ok(workers.every((w) => w.terminated), 'all workers must be terminated immediately on dispose()');

    await assert.rejects(p1, (e) => e?.code === 'BACKEND_DISPOSED');
    await assert.rejects(p2, (e) => e?.code === 'BACKEND_DISPOSED');
    await assert.rejects(pQueued, (e) => e?.code === 'BACKEND_DISPOSED');

    // Calling runTask() after dispose() rejects cleanly without spawning
    const spawnsBefore = spawnCount;
    const pAfter = pool.runTask({ t: 'scanStage1', epoch: 2, requestId: 4 });
    await assert.rejects(pAfter, (e) => e?.code === 'BACKEND_DISPOSED');
    assert.equal(spawnCount, spawnsBefore, 'runTask() after dispose() must not spawn workers');

    // Idempotent dispose
    pool.dispose();
    assert.equal(pool.activeWorkerCount, 0);
  });

  it('handles worker crash and workerFactory throw cleanly by rejecting with WORKER_FAILED', async () => {
    setGlobal('document', makeFakeDocument(false));
    const workers = [];
    const inflight = [];

    const pool = new ScanWorkerPool({
      maxWorkers: 1,
      idleTimeoutMs: 15_000,
      workerFactory: () => {
        const w = new MockWorker((worker, msg) => {
          if (msg.t !== 'cancel') inflight.push({ worker, msg });
        });
        workers.push(w);
        return w;
      },
    });

    const pCrash = pool.runTask({ t: 'scanProgramChunk', epoch: 1, requestId: 1 });
    const pNext = pool.runTask({ t: 'scanProgramChunk', epoch: 1, requestId: 2 });

    workers[0].emitError('segfault in scan worker');
    await assert.rejects(pCrash, (e) => e?.code === 'WORKER_FAILED');
    assert.equal(workers[0].terminated, true);

    // Pool should spawn a fresh worker for the queued task
    assert.equal(workers.length, 2);
    const nextJob = inflight[1];
    nextJob.worker.emitMessage({ t: 'res', id: nextJob.msg.id, epoch: 1, requestId: 2, ok: true, result: { recovered: true } });
    assert.deepEqual(await pNext, { recovered: true });
    pool.dispose();

    // workerFactory throwing
    const throwingPool = new ScanWorkerPool({
      maxWorkers: 2,
      workerFactory: () => { throw new Error('spawn failed'); },
    });
    const pSpawnFail = throwingPool.runTask({ t: 'scanStage1', epoch: 1, requestId: 1 });
    await assert.rejects(pSpawnFail, (e) => e?.code === 'WORKER_FAILED' && /spawn failed/.test(e.message));
    throwingPool.dispose();
  });
});

describe('Backend integration & lifecycle', () => {
  let fakeDoc;
  let createdGlobalWorkers;

  beforeEach(() => {
    fakeDoc = makeFakeDocument(false);
    createdGlobalWorkers = [];
    setGlobal('document', fakeDoc);
    setGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      platform: 'Linux x86_64',
      maxTouchPoints: 0,
      hardwareConcurrency: 4,
    });
    setGlobal('Worker', class extends MockWorker {
      constructor() {
        super();
        createdGlobalWorkers.push(this);
      }
    });
  });

  afterEach(() => {
    restoreGlobal('document', origDocumentDesc);
    restoreGlobal('navigator', origNavigatorDesc);
    restoreGlobal('Worker', origWorkerDesc);
  });

  it('enforces early if (this.disposed) guard on scanProgram and valueShapes without mutating pending/seq', async () => {
    const b = new Backend();
    b.dispose();
    const seqBefore = b.seq;

    const pScan = b.scanProgram('text');
    assert.equal(pScan.requestId, null);
    assert.equal(typeof pScan.cancel, 'function');
    pScan.cancel();
    await assert.rejects(pScan, (e) => e?.code === 'BACKEND_DISPOSED');

    const pShapes = b.valueShapes('text');
    assert.equal(pShapes.requestId, null);
    assert.equal(typeof pShapes.cancel, 'function');
    pShapes.cancel();
    await assert.rejects(pShapes, (e) => e?.code === 'BACKEND_DISPOSED');

    assert.equal(b.pending.size, 0);
    assert.equal(b.seq, seqBefore);
  });

  it('cleanupMemory() handles missing/uninitialized scanPool cleanly (no throw, no lazy instantiation) and forwards to onMemoryPressure() when present', async () => {
    const b = new Backend();
    b.platformWorker = new MockWorker((worker, msg) => {
      if (msg.t === 'cleanupMemory') {
        worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { ok: true } });
      }
    });

    assert.equal(b._scanPool, null);
    const res = await b.cleanupMemory();
    assert.deepEqual(res, { ok: true });
    assert.equal(b._scanPool, null, 'cleanupMemory() must NOT lazily instantiate _scanPool');

    // When _scanPool is initialized, cleanupMemory() and visibilitychange(hidden) invoke onMemoryPressure()
    const poolWorkers = [];
    const inflight = [];
    b._scanPool = new ScanWorkerPool({
      maxWorkers: 2,
      idleTimeoutMs: 15_000,
      workerFactory: () => {
        const w = new MockWorker((worker, msg) => {
          if (msg.t !== 'cancel') inflight.push({ worker, msg });
        });
        poolWorkers.push(w);
        return w;
      },
    });
    const j1 = b._scanPool.runTask({ t: 'scanStage1', epoch: 0, requestId: 1 });
    const j2 = b._scanPool.runTask({ t: 'scanStage1', epoch: 0, requestId: 2 });
    // Finish j1 so worker 0 is idle, worker 1 is busy
    inflight[0].worker.emitMessage({ t: 'res', id: inflight[0].msg.id, epoch: 0, requestId: 1, ok: true, result: { ok: 1 } });
    await j1;

    await b.cleanupMemory();
    assert.equal(poolWorkers[0].terminated, true, 'cleanupMemory() must terminate idle scanPool workers');
    assert.equal(poolWorkers[1].terminated, false, 'cleanupMemory() must let busy scanPool workers finish');

    // Complete j2 -> worker 1 retires immediately
    inflight[1].worker.emitMessage({ t: 'res', id: inflight[1].msg.id, epoch: 0, requestId: 2, ok: true, result: { ok: 2 } });
    await j2;
    assert.equal(poolWorkers[1].terminated, true);

    // visibilitychange -> hidden also triggers cleanupMemory -> onMemoryPressure
    const j3 = b._scanPool.runTask({ t: 'scanStage1', epoch: 0, requestId: 3 });
    inflight[2].worker.emitMessage({ t: 'res', id: inflight[2].msg.id, epoch: 0, requestId: 3, ok: true, result: { ok: 3 } });
    await j3;
    assert.equal(b._scanPool.activeWorkerCount, 1);

    fakeDoc.hidden = true;
    fakeDoc.dispatch('visibilitychange');
    await flushMicrotasks();
    assert.equal(b._scanPool.activeWorkerCount, 0, 'visibilitychange(hidden) must terminate idle scanPool workers');

    b.dispose();
  });

  it('open() cancels active scanPool epoch even on failed open() and resets _activeMachArchitecture = null across file switches', async () => {
    const b = new Backend();
    const poolWorkers = [];
    b._scanPool = new ScanWorkerPool({
      maxWorkers: 2,
      workerFactory: () => {
        const w = new MockWorker();
        poolWorkers.push(w);
        return w;
      },
    });

    // Seed an active scanPool job at transportEpoch 0
    const activePoolJob = b._scanPool.runTask({ t: 'scanStage1', epoch: b.transportEpoch, requestId: 1 });
    b._activeMachArchitecture = 'arm64';

    // Failed open(): platform fails, legacy fails before advanceEpoch()
    b.platformWorker = new MockWorker((worker, msg) => {
      if (msg.t === 'open') worker.emitMessage({ t: 'err', id: msg.id, epoch: msg.epoch, error: 'platform parse failed' });
    });
    b.legacyWorker = new MockWorker((worker, msg) => {
      if (msg.t === 'open') worker.emitMessage({ t: 'err', id: msg.id, epoch: msg.epoch, error: 'legacy parse failed' });
    });

    await assert.rejects(() => b.open(makeFakeFile(16, 0)), /legacy parse failed/);
    await assert.rejects(activePoolJob, (e) => e?.name === 'StaleRequestError' && e?.stale === true);
    assert.ok(poolWorkers[0].sent.some((s) => s.msg.t === 'cancel' && s.msg.epoch === 0));
    assert.equal(b._activeMachArchitecture, 'arm64', 'failed open() must preserve existing _activeMachArchitecture');

    // Successful open() switches: ARM64 Mach-O -> x86_64 Mach-O -> ARM64 ELF
    let mode = 'macho-arm64';
    b.platformWorker = new MockWorker((worker, msg) => {
      if (msg.t === 'open') {
        if (mode === 'macho-arm64') {
          worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { formatId: 'macho', capability: { format: 'macho', architecture: 'arm64' } } });
        } else if (mode === 'macho-x86') {
          worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { formatId: 'macho', capability: { format: 'macho', architecture: 'x86_64' } } });
        } else if (mode === 'elf-arm64') {
          worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { formatId: 'elf', capability: { format: 'elf', architecture: 'arm64' }, slices: [{ regions: [] }] } });
        }
      }
    });
    b.legacyWorker = new MockWorker((worker, msg) => {
      if (msg.t === 'open') {
        if (mode === 'macho-arm64') {
          worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { slices: [{ info: { isArm64: true, is64: true } }] } });
        } else if (mode === 'macho-x86') {
          worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { slices: [{ info: { cpu: 'x86_64', is64: true } }] } });
        } else {
          worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { slices: [] } });
        }
      } else if (msg.t === 'setRegions') {
        worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { ok: true } });
      }
    });

    await b.open(makeFakeFile(64, 0));
    assert.equal(b.formatId, 'macho');
    assert.equal(b._activeMachArchitecture, null);

    // Simulate analyze() setting _activeMachArchitecture
    b._activeMachArchitecture = 'arm64';
    mode = 'macho-x86';
    await b.open(makeFakeFile(64, 0));
    assert.equal(b.formatId, 'macho');
    assert.equal(b._activeMachArchitecture, null, 'open() must reset _activeMachArchitecture to null on x86_64 Mach-O switch');

    b._activeMachArchitecture = 'x86_64';
    mode = 'elf-arm64';
    await b.open(makeFakeFile(64, 0));
    assert.equal(b.formatId, 'elf');
    assert.equal(b._activeMachArchitecture, null, 'open() must reset _activeMachArchitecture to null on ELF switch');

    b.dispose();
  });

  it('advanceEpoch() and dispose() snapshot-and-delete pending requests before invoking onCancel/reject', async () => {
    const b = new Backend();
    const events = [];

    // Register two pending entries whose onCancel checks that pending was already deleted
    const p1 = new Promise((resolve, reject) => {
      b.pending.set(100, {
        resolve,
        reject,
        uiEpoch: b.gen,
        transportEpoch: b.transportEpoch,
        workerName: 'scan-pool',
        onCancel: () => {
          events.push({ id: 100, stillInPending: b.pending.has(100) });
        },
      });
    });
    const p2 = new Promise((resolve, reject) => {
      b.pending.set(101, {
        resolve,
        reject,
        uiEpoch: b.gen,
        transportEpoch: b.transportEpoch,
        workerName: 'scan-pool',
        onCancel: () => {
          events.push({ id: 101, stillInPending: b.pending.has(101) });
        },
      });
    });

    b.advanceEpoch();
    assert.equal(b.pending.size, 0);
    assert.deepEqual(events, [
      { id: 100, stillInPending: false },
      { id: 101, stillInPending: false },
    ]);
    await assert.rejects(p1, (e) => e instanceof StaleRequestError && e.stale === true);
    await assert.rejects(p2, (e) => e instanceof StaleRequestError && e.stale === true);

    // Same snapshot-and-delete invariant for dispose()
    events.length = 0;
    const p3 = new Promise((resolve, reject) => {
      b.pending.set(200, {
        resolve,
        reject,
        uiEpoch: b.gen,
        transportEpoch: b.transportEpoch,
        workerName: 'scan-pool',
        onCancel: () => {
          events.push({ id: 200, stillInPending: b.pending.has(200) });
        },
      });
    });

    b.dispose();
    assert.equal(b.pending.size, 0);
    assert.deepEqual(events, [{ id: 200, stillInPending: false }]);
    await assert.rejects(p3, (e) => e?.code === 'BACKEND_DISPOSED');
  });

  it('cancel() invokes onCancel and trackLastRequest: false does NOT clobber a newer concurrent request lastRequestId', async () => {
    const b = new Backend();
    b.legacyWorker = new MockWorker();
    b.platformWorker = new MockWorker();

    // Direct _callTo with trackLastRequest: false
    const tracked = b._callTo('legacy', 'probe', {});
    assert.equal(b.lastRequestId, tracked.requestId);

    const untracked = b._callTo('legacy', 'getScanMeta', { regionId: 'text' }, null, null, { trackLastRequest: false });
    assert.equal(b.lastRequestId, tracked.requestId, 'trackLastRequest: false must NOT clobber lastRequestId');

    // Parameterless cancel() must cancel `tracked`, NOT `untracked`
    assert.equal(b.cancel(), true);
    await assert.rejects(tracked, (e) => e?.name === 'AbortError');
    assert.equal(b.pending.has(untracked.requestId), true);
    untracked.cancel();
    await assert.rejects(untracked, (e) => e?.name === 'AbortError');

    // Pending entry with onCancel must invoke onCancel instead of posting to worker
    let onCancelCalls = 0;
    const sentBefore = b.legacyWorker.sent.length;
    const custom = new Promise((resolve, reject) => {
      b.pending.set(999, {
        resolve,
        reject,
        uiEpoch: b.gen,
        transportEpoch: b.transportEpoch,
        workerName: 'scan-pool',
        onCancel: () => { onCancelCalls++; },
      });
    });
    assert.equal(b.cancel(999), true);
    assert.equal(onCancelCalls, 1);
    assert.equal(b.legacyWorker.sent.length, sentBefore);
    await assert.rejects(custom, (e) => e?.name === 'AbortError');

    // Integration: scanProgram triggers internal getScanMeta (trackLastRequest: false),
    // then a newer guessFunctions call updates lastRequestId; parameterless cancel() must cancel guessFunctions,
    // while scanProgram's req.cancel() cancels getScanMeta cleanly without UnhandledPromiseRejection.
    b.formatId = 'macho';
    b.file = makeFakeFile(4096);
    b._parallelScanThresholdBytes = 1024;
    const scanReq = b.scanProgram('text');
    const guessReq = b.guessFunctions('text', 100);
    assert.equal(b.lastRequestId, guessReq.requestId, 'internal getScanMeta must not clobber guessFunctions lastRequestId');

    assert.equal(b.cancel(), true);
    await assert.rejects(guessReq, (e) => e?.name === 'AbortError');

    assert.equal(scanReq.cancel(), true);
    await assert.rejects(scanReq, (e) => e?.name === 'AbortError');
    assert.equal(b.pending.size, 0);

    b.dispose();
  });

  it('keeps non-ARM64 Mach-O scanProgram (without limits.architecture) and valueShapes on single-worker path', async () => {
    const scanWorkerSpawns = [];
    const b = new Backend({
      parallelScanThresholdBytes: 64,
      scanWorkerFactory: () => {
        const w = new MockWorker();
        scanWorkerSpawns.push(w);
        return w;
      },
    });
    b.formatId = 'macho';
    b._activeMachArchitecture = 'x86_64';
    b.file = makeFakeFile(4096);
    b.legacyWorker = new MockWorker((worker, msg) => {
      if (msg.t === 'scanProgram') {
        worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { regionId: msg.regionId, singleWorker: true } });
      } else if (msg.t === 'valueShapes') {
        worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { regionId: msg.regionId, singleWorker: true } });
      }
    });

    const scanRes = await b.scanProgram('text');
    assert.equal(scanRes.singleWorker, true);
    const shapeRes = await b.valueShapes('text');
    assert.equal(shapeRes.singleWorker, true);
    assert.equal(scanWorkerSpawns.length, 0, 'non-ARM64 Mach-O must NOT spawn parallel scan workers');
    assert.equal(b._scanPool, null);
    b.dispose();
  });

  it('propagates legacyWorker WORKER_FAILED during getScanMeta immediately, and falls back on unsupported getScanMeta', async () => {
    const b = new Backend({
      parallelScanThresholdBytes: 64,
      scanWorkerFactory: () => new MockWorker(),
    });
    b.formatId = 'macho';
    b._activeMachArchitecture = 'arm64';
    b.file = makeFakeFile(4096);

    // Case 1: unsupported getScanMeta -> transparent fallback to legacy scanProgram
    let legacyScanCalls = 0;
    b.legacyWorker = new MockWorker((worker, msg) => {
      if (msg.t === 'getScanMeta') {
        worker.emitMessage({ t: 'err', id: msg.id, epoch: msg.epoch, error: 'Unknown request: getScanMeta' });
      } else if (msg.t === 'scanProgram') {
        legacyScanCalls++;
        worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { regionId: msg.regionId, viaLegacy: true } });
      }
    });

    const fallbackRes = await b.scanProgram('text');
    assert.equal(legacyScanCalls, 1);
    assert.equal(fallbackRes.viaLegacy, true);

    // Case 2: legacyWorker crashes (WORKER_FAILED) during getScanMeta -> must propagate WORKER_FAILED immediately
    b.legacyWorker = new MockWorker((worker, msg) => {
      if (msg.t === 'getScanMeta') {
        queueMicrotask(() => worker.emitError('legacy worker died'));
      }
    });

    await assert.rejects(() => b.scanProgram('text'), (e) => e?.code === 'WORKER_FAILED');
    assert.equal(b.pending.size, 0);
    b.dispose();
  });

  it('executes parallel scanProgram end-to-end with ScanWorkerPool, onScanProgress fallback, and falls back cleanly on scan-worker crash', async () => {
    const regionSize = 1024;
    const region = {
      id: 'text',
      fileOffset: 0n,
      vmAddr: 0x1000n,
      size: BigInt(regionSize),
      section: '__text',
      segment: '__TEXT',
    };
    const functionStarts = new BigUint64Array([0x1000n, 0x1200n]);
    const file = makeFakeFile(regionSize);

    // Part A: Happy path parallel scanProgram + onScanProgress fallback
    {
      const poolWorkers = [];
      const progressEvents = [];
      const b = new Backend({
        parallelScanThresholdBytes: 256,
        scanWorkerFactory: () => {
          const w = new MockWorker((worker, msg) => {
            if (msg.t === 'scanStage1') {
              worker.emitMessage({
                t: 'res',
                id: msg.id,
                epoch: msg.epoch,
                requestId: msg.requestId,
                ok: true,
                result: {
                  chunkIndex: msg.chunkIndex,
                  crossChunkForwardTargets: new BigUint64Array(0),
                  loopKillAddrs: new BigUint64Array(0),
                  loopKillMasks: new Uint32Array(0),
                },
              });
            } else if (msg.t === 'scanProgramChunk') {
              const chunkWords = Math.floor((msg.chunkEnd - msg.chunkStart) / 4);
              worker.emitMessage({
                t: 'res',
                id: msg.id,
                epoch: msg.epoch,
                requestId: msg.requestId,
                ok: true,
                result: {
                  chunkIndex: msg.chunkIndex,
                  chunkWordBase: Math.floor(msg.chunkStart / 4),
                  callFrom: new BigUint64Array(0),
                  callTo: new BigUint64Array(0),
                  callCount: 0,
                  refFrom: new BigUint64Array(0),
                  refTo: new BigUint64Array(0),
                  refKind: new Uint8Array(0),
                  refCount: 0,
                  kinds: new Uint8Array(chunkWords),
                  budgetCapped: false,
                  callsLimitCapped: false,
                  refsLimitCapped: false,
                },
              });
            }
          });
          poolWorkers.push(w);
          return w;
        },
      });
      b.formatId = 'macho';
      b._activeMachArchitecture = 'arm64';
      b.file = file;
      b.onScanProgress = (ev) => progressEvents.push(ev);

      let legacyFallbackCount = 0;
      b.legacyWorker = new MockWorker((worker, msg) => {
        if (msg.t === 'getScanMeta') {
          worker.emitMessage({
            t: 'ok',
            id: msg.id,
            epoch: msg.epoch,
            result: { region, functionStarts, stringRanges: [], hasDataInCode: false },
          });
        } else if (msg.t === 'scanProgram') {
          legacyFallbackCount++;
          worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { regionId: 'text', fallback: true } });
        }
      });

      const res = await b.scanProgram('text');
      assert.equal(legacyFallbackCount, 0, 'parallel scanProgram should complete via scanPool without legacy fallback');
      assert.equal(res.regionId, 'text');
      assert.equal(res.words, regionSize / 4);
      assert.ok(poolWorkers.length >= 1, 'should have spawned at least one scanPool worker');
      assert.ok(progressEvents.length >= 1, 'onScanProgress fallback should receive progress updates');
      b.dispose();
    }

    // Part B: Scan-worker crash during Stage 1 -> transparent fallback to legacy worker
    {
      let legacyFallbackCount = 0;
      const b = new Backend({
        parallelScanThresholdBytes: 256,
        scanWorkerFactory: () => new MockWorker((worker, msg) => {
          if (msg.t === 'scanStage1') {
            queueMicrotask(() => worker.emitError('scan worker crashed in stage 1'));
          }
        }),
      });
      b.formatId = 'macho';
      b._activeMachArchitecture = 'arm64';
      b.file = file;
      b.legacyWorker = new MockWorker((worker, msg) => {
        if (msg.t === 'getScanMeta') {
          worker.emitMessage({
            t: 'ok',
            id: msg.id,
            epoch: msg.epoch,
            result: { region, functionStarts, stringRanges: [], hasDataInCode: false },
          });
        } else if (msg.t === 'scanProgram') {
          legacyFallbackCount++;
          worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { regionId: 'text', fallbackAfterCrash: true } });
        }
      });

      const res = await b.scanProgram('text');
      assert.equal(legacyFallbackCount, 1, 'scan-worker crash must fall back to legacy scanProgram');
      assert.equal(res.fallbackAfterCrash, true);
      b.dispose();
    }
  });

  it('executes parallel valueShapes end-to-end with ScanWorkerPool and falls back cleanly on scan-worker crash', async () => {
    const regionSize = 1024;
    const region = {
      id: 'text',
      fileOffset: 0n,
      vmAddr: 0x1000n,
      size: BigInt(regionSize),
      section: '__text',
      segment: '__TEXT',
    };
    const file = makeFakeFile(regionSize, 0xd65f03c0); // RET at every word -> valid split points

    // Part A: Happy path parallel valueShapes
    {
      let legacyFallbackCount = 0;
      const b = new Backend({
        parallelScanThresholdBytes: 256,
        scanWorkerFactory: () => new MockWorker((worker, msg) => {
          if (msg.t === 'scanShapesChunk') {
            worker.emitMessage({
              t: 'res',
              id: msg.id,
              epoch: msg.epoch,
              requestId: msg.requestId,
              ok: true,
              result: {
                chunkIndex: msg.chunkIndex,
                count: 0,
                capped: false,
                addr: new BigUint64Array(0),
                disp: new Int32Array(0),
                size: new Uint8Array(0),
                flags: new Uint8Array(0),
                amtKind: new Uint8Array(0),
                amtDisp: new Int32Array(0),
                span: new Int32Array(0),
                amtSize: new Uint8Array(0),
                amtSpan: new Int32Array(0),
              },
            });
          }
        }),
      });
      b.formatId = 'macho';
      b._activeMachArchitecture = 'arm64';
      b.file = file;
      b.legacyWorker = new MockWorker((worker, msg) => {
        if (msg.t === 'getScanMeta') {
          worker.emitMessage({
            t: 'ok',
            id: msg.id,
            epoch: msg.epoch,
            result: { region, functionStarts: new BigUint64Array(0), stringRanges: [], hasDataInCode: false },
          });
        } else if (msg.t === 'valueShapes') {
          legacyFallbackCount++;
          worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { regionId: 'text', fallback: true } });
        }
      });

      const res = await b.valueShapes('text');
      assert.equal(legacyFallbackCount, 0, 'parallel valueShapes should complete via scanPool without legacy fallback');
      assert.equal(res.regionId, 'text');
      assert.equal(res.count, 0);
      b.dispose();
    }

    // Part B: Scan-worker crash during valueShapes -> transparent fallback to legacy worker
    {
      let legacyFallbackCount = 0;
      const b = new Backend({
        parallelScanThresholdBytes: 256,
        scanWorkerFactory: () => new MockWorker((worker, msg) => {
          if (msg.t === 'scanShapesChunk') {
            queueMicrotask(() => worker.emitError('scan worker crashed in valueShapes'));
          }
        }),
      });
      b.formatId = 'macho';
      b._activeMachArchitecture = 'arm64';
      b.file = file;
      b.legacyWorker = new MockWorker((worker, msg) => {
        if (msg.t === 'getScanMeta') {
          worker.emitMessage({
            t: 'ok',
            id: msg.id,
            epoch: msg.epoch,
            result: { region, functionStarts: new BigUint64Array(0), stringRanges: [], hasDataInCode: false },
          });
        } else if (msg.t === 'valueShapes') {
          legacyFallbackCount++;
          worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { regionId: 'text', fallbackAfterCrash: true } });
        }
      });

      const res = await b.valueShapes('text');
      assert.equal(legacyFallbackCount, 1, 'scan-worker crash in valueShapes must fall back to legacy worker');
      assert.equal(res.fallbackAfterCrash, true);
      b.dispose();
    }
  });

  it('initializing ScanWorkerPool while document.hidden === true does not permanently lock maxWorkers at 1', async () => {
    const fakeDoc = makeFakeDocument(true);
    const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const savedNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'document', { value: fakeDoc, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', platform: 'MacIntel', maxTouchPoints: 0, hardwareConcurrency: 8 }, configurable: true, writable: true });

    let unrefCalls = 0;
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, ms) => {
      const handle = origSetTimeout(fn, ms);
      return {
        _h: handle,
        unref() { unrefCalls++; handle?.unref?.(); return this; },
      };
    };
    globalThis.clearTimeout = (h) => origClearTimeout(h && h._h !== undefined ? h._h : h);

    try {
      const workers = [];
      const b = new Backend({
        scanWorkerFactory: () => {
          const w = new MockWorker();
          workers.push(w);
          return w;
        },
      });
      const pool = b._ensureScanPool();
      assert.equal(pool.maxWorkers, 4, 'pool.maxWorkers must reflect device cap (4), not transient hidden state');

      const h1 = pool.runTask({ t: 'scanStage1', epoch: 0, requestId: 1 });
      const h2 = pool.runTask({ t: 'scanStage1', epoch: 0, requestId: 1 });
      assert.equal(workers.length, 1, 'only 1 worker active while hidden');
      workers[0].emitMessage({ t: 'res', ok: true, id: workers[0].sent[0].msg.id, result: { ok: 1 } });
      await h1;
      assert.equal(workers.length, 1, 'hidden worker must be reused for queued work without thrashing');
      assert.equal(workers[0].terminated, false, 'hidden worker must stay alive while draining queued work');
      workers[0].emitMessage({ t: 'res', ok: true, id: workers[0].sent[1].msg.id, result: { ok: 2 } });
      await h2;
      assert.equal(workers[0].terminated, true, 'hidden worker must terminate once queue drains');

      fakeDoc.hidden = false;
      const f1 = pool.runTask({ t: 'scanStage1', epoch: 0, requestId: 2 });
      const f2 = pool.runTask({ t: 'scanStage1', epoch: 0, requestId: 2 });
      const f3 = pool.runTask({ t: 'scanStage1', epoch: 0, requestId: 2 });
      assert.equal(pool.activeWorkerCount, 3, 'returning to foreground must scale back up past 1 worker');
      for (let i = 1; i < workers.length; i++) {
        workers[i].emitMessage({ t: 'res', ok: true, id: workers[i].sent[0].msg.id, result: { ok: i } });
      }
      await Promise.all([f1, f2, f3]);
      assert.ok(unrefCalls >= 3, 'idle timer must invoke .unref() when scheduling idle retirement');
      b.dispose();
    } finally {
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
      if (savedDoc) Object.defineProperty(globalThis, 'document', savedDoc);
      else delete globalThis.document;
      if (savedNav) Object.defineProperty(globalThis, 'navigator', savedNav);
      else delete globalThis.navigator;
    }
  });

  it('cancels Backend.scanProgram mid-Stage-1, mid-Stage-2, mid-fallback, and Backend.valueShapes mid-wave cleanly', async () => {
    const region = { id: 'text', vmAddr: 0x100000n, fileOffset: 0n, size: 1024n, name: '__text' };
    const fnStarts = new BigUint64Array([0x100000n, 0x100200n]);
    const file = makeFakeFile(1024);

    {
      const workers = [];
      const b = new Backend({
        parallelScanThresholdBytes: 256,
        scanWorkerFactory: () => {
          const w = new MockWorker();
          workers.push(w);
          return w;
        },
      });
      b.formatId = 'macho';
      b._activeMachArchitecture = 'arm64';
      b.file = file;
      b.legacyWorker = new MockWorker((w, msg) => {
        if (msg.t === 'getScanMeta') {
          w.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { region, functionStarts: fnStarts, stringRanges: [], hasDataInCode: false } });
        }
      });
      const req = b.scanProgram('text');
      await flushMicrotasks();
      assert.ok(workers.length >= 1, 'Stage 1 workers spawned');
      req.cancel();
      await assert.rejects(req, (e) => e?.name === 'AbortError');
      assert.equal(b.pending.size, 0);
      assert.ok(workers.some((w) => w.sent.some((s) => s.msg.t === 'cancel')));
      b.dispose();
    }

    for (const mode of ['cancel', 'advanceEpoch']) {
      const workers = [];
      const b = new Backend({
        parallelScanThresholdBytes: 256,
        scanWorkerFactory: () => {
          const w = new MockWorker((worker, msg) => {
            if (msg.t === 'scanStage1') {
              queueMicrotask(() => worker.emitMessage({
                t: 'res', ok: true, id: msg.id, result: {
                  chunkIndex: msg.chunkIndex,
                  crossChunkForwardTargets: new BigUint64Array(0),
                  loopKillAddrs: new BigUint64Array(0),
                  loopKillMasks: new Uint32Array(0),
                },
              }));
            }
          });
          workers.push(w);
          return w;
        },
      });
      b.formatId = 'macho';
      b._activeMachArchitecture = 'arm64';
      b.file = file;
      b.legacyWorker = new MockWorker((w, msg) => {
        if (msg.t === 'getScanMeta') {
          w.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { region, functionStarts: fnStarts, stringRanges: [], hasDataInCode: false } });
        }
      });
      const req = b.scanProgram('text');
      await flushMicrotasks();
      if (mode === 'cancel') {
        b.cancel(req.requestId);
        await assert.rejects(req, (e) => e?.name === 'AbortError');
      } else {
        b.advanceEpoch();
        await assert.rejects(req, (e) => e?.name === 'StaleRequestError' && e?.stale === true);
      }
      assert.equal(b.pending.size, 0);
      b.dispose();
    }

    {
      const b = new Backend({ parallelScanThresholdBytes: 1024 * 1024 });
      b.formatId = 'macho';
      b._activeMachArchitecture = 'arm64';
      b.file = file;
      let legacyScanStarted = false;
      b.legacyWorker = new MockWorker((w, msg) => {
        if (msg.t === 'getScanMeta') {
          w.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { region, functionStarts: fnStarts, stringRanges: [], hasDataInCode: false } });
        } else if (msg.t === 'scanProgram') {
          legacyScanStarted = true;
        }
      });
      const req = b.scanProgram('text');
      await flushMicrotasks();
      assert.equal(legacyScanStarted, true);
      req.cancel();
      await assert.rejects(req, (e) => e?.name === 'AbortError');
      assert.equal(b.pending.size, 0);
      b.dispose();
    }

    {
      const shapeBuf = new ArrayBuffer(1024);
      const u32 = new Uint32Array(shapeBuf);
      u32[127] = 0xd65f03c0;
      const shapeFile = {
        size: 1024,
        slice(start, end) {
          return { arrayBuffer: async () => shapeBuf.slice(Number(start), Number(end)) };
        },
      };
      const workers = [];
      const b = new Backend({
        parallelScanThresholdBytes: 256,
        scanWorkerFactory: () => {
          const w = new MockWorker();
          workers.push(w);
          return w;
        },
      });
      b.formatId = 'macho';
      b._activeMachArchitecture = 'arm64';
      b.file = shapeFile;
      b.legacyWorker = new MockWorker((w, msg) => {
        if (msg.t === 'getScanMeta') {
          w.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { region, functionStarts: new BigUint64Array(0), stringRanges: [], hasDataInCode: false } });
        }
      });
      const req = b.valueShapes('text');
      await flushMicrotasks();
      assert.ok(workers.length >= 1, 'valueShapes wave workers spawned');
      req.cancel();
      await assert.rejects(req, (e) => e?.name === 'AbortError');
      assert.equal(b.pending.size, 0);
      b.dispose();
    }
  });

  it('visibilitychange(hidden) mid-Stage-1 transitions Stage 2 to concurrency 1 and terminates Stage 2 workers immediately on idle', async () => {
    const fakeDoc = makeFakeDocument(false);
    const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { value: fakeDoc, configurable: true, writable: true });
    try {
      const region = { id: 'text', vmAddr: 0x100000n, fileOffset: 0n, size: 1024n, name: '__text' };
      const fnStarts = new BigUint64Array([0x100000n, 0x100200n]);
      const file = makeFakeFile(1024);
      let stage1Responded = 0;
      let maxConcurrentStage2 = 0;
      let activeStage2 = 0;

      const b = new Backend({
        parallelScanThresholdBytes: 256,
        scanWorkerFactory: () => new MockWorker((worker, msg) => {
          if (msg.t === 'scanStage1') {
            stage1Responded++;
            if (stage1Responded === 1) {
              fakeDoc.hidden = true;
              fakeDoc.dispatch('visibilitychange');
            }
            queueMicrotask(() => worker.emitMessage({
              t: 'res', ok: true, id: msg.id, result: {
                chunkIndex: msg.chunkIndex,
                crossChunkForwardTargets: new BigUint64Array(0),
                loopKillAddrs: new BigUint64Array(0),
                loopKillMasks: new Uint32Array(0),
              },
            }));
          } else if (msg.t === 'scanProgramChunk') {
            activeStage2++;
            if (activeStage2 > maxConcurrentStage2) maxConcurrentStage2 = activeStage2;
            queueMicrotask(() => {
              activeStage2--;
              const chunkWords = Math.floor((msg.chunkEnd - msg.chunkStart) / 4);
              worker.emitMessage({
                t: 'res', ok: true, id: msg.id, result: {
                  chunkIndex: msg.chunkIndex,
                  callFrom: new BigUint64Array(0),
                  callTo: new BigUint64Array(0),
                  refFrom: new BigUint64Array(0),
                  refTo: new BigUint64Array(0),
                  refKind: new Uint8Array(0),
                  kinds: new Uint8Array(chunkWords),
                  callCount: 0,
                  refCount: 0,
                  budgetCapped: false,
                  callsLimitCapped: false,
                  refsLimitCapped: false,
                },
              });
            });
          }
        }),
      });
      b.formatId = 'macho';
      b._activeMachArchitecture = 'arm64';
      b.file = file;
      b.legacyWorker = new MockWorker((w, msg) => {
        if (msg.t === 'getScanMeta') {
          w.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { region, functionStarts: fnStarts, stringRanges: [], hasDataInCode: false } });
        }
      });

      const res = await b.scanProgram('text');
      assert.equal(res.kinds.length, 256);
      assert.equal(maxConcurrentStage2, 1, 'Stage 2 must run at concurrency 1 while hidden');
      assert.equal(b._scanPool.activeWorkerCount, 0, 'Stage 2 workers must terminate immediately on idle while hidden');
      b.dispose();
    } finally {
      if (savedDoc) Object.defineProperty(globalThis, 'document', savedDoc);
      else delete globalThis.document;
    }
  });
});

after(() => {
  process.off('unhandledRejection', onUnhandledRejection);
  assert.equal(
    unhandledRejections.length,
    0,
    `Expected zero UnhandledPromiseRejections, got ${unhandledRejections.length}: ${unhandledRejections.map((r) => String(r)).join('; ')}`,
  );
});

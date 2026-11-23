import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ScanWorkerPool } from '../js/scan-pool.js';
import { mergeChunkProgramScans } from '../js/scan-planner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadClassicScript(ctx, relPath) {
  const full = path.join(ROOT, relPath);
  const code = fs.readFileSync(full, 'utf8');
  vm.runInContext(code, ctx, { filename: full });
}

function makeFakeFileFromUint32(words) {
  const buf = new ArrayBuffer(words.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i] >>> 0, true);
  return {
    name: 'track1.bin',
    size: buf.byteLength,
    slice(start = 0, end = buf.byteLength) {
      const s = Math.max(0, Math.min(buf.byteLength, Number(start)));
      const e = Math.max(s, Math.min(buf.byteLength, Number(end)));
      return {
        async arrayBuffer() {
          return buf.slice(s, e);
        },
      };
    },
  };
}

class MockWorker {
  constructor() {
    this.sent = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
  }
  postMessage(msg, transfer) {
    if (this.terminated) throw new Error('Worker terminated');
    this.sent.push({ msg, transfer });
  }
  emitMessage(data) {
    if (!this.terminated && this.onmessage) this.onmessage({ data });
  }
  terminate() {
    this.terminated = true;
  }
}

function createScanWorkerVM({ stubCore = null } = {}) {
  const posted = [];
  const ctx = vm.createContext({
    postMessage(msg, transfer) {
      posted.push({ msg, transfer });
    },
    onmessage: null,
    console,
    setTimeout,
    clearTimeout,
    performance,
    Date,
    Math,
    BigInt,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    WeakSet,
    Promise,
    Error,
    TypeError,
    Uint8Array,
    Uint32Array,
    Int32Array,
    Int8Array,
    BigUint64Array,
    ArrayBuffer,
    DataView,
    importScripts(...scripts) {
      if (stubCore) {
        ctx.HexScanCore = stubCore;
        return;
      }
      for (const s of scripts) {
        const resolved = path.join('js', s.replace(/^\.\//, ''));
        loadClassicScript(ctx, resolved);
      }
    },
  });
  ctx.self = ctx;
  ctx.globalThis = ctx;
  loadClassicScript(ctx, 'js/scan-worker.js');
  return {
    ctx,
    posted,
    send(msg) {
      ctx.onmessage({ data: msg });
    },
  };
}

function flushMicrotasks(turns = 8) {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i++) p = p.then(() => {});
  return p;
}

describe('Track 1: T1-P1-1 single-job cancel isolation & no epoch pollution / ID leak', () => {
  it('ScanWorkerPool._cancelJob sends job.id alongside epoch and requestId', async () => {
    const workers = [];
    const pool = new ScanWorkerPool({
      maxWorkers: 2,
      workerFactory: () => {
        const w = new MockWorker();
        workers.push(w);
        return w;
      },
    });
    const p1 = pool.runTask({ t: 'scanStage1', epoch: 3, requestId: 99 });
    assert.equal(workers.length, 1);
    const dispatchedId = workers[0].sent[0].msg.id;

    p1.cancel();
    await assert.rejects(p1, (err) => err && err.name === 'AbortError');
    const cancelMsg = workers[0].sent.find((s) => s.msg.t === 'cancel');
    assert.ok(cancelMsg, 'cancel message must be posted to worker');
    assert.deepEqual(cancelMsg.msg, { t: 'cancel', id: dispatchedId, epoch: 3, requestId: 99 });
    pool.dispose();
  });

  it('cancelling a single job with requestId:null does not bump currentEpoch or kill sibling jobs', async () => {
    const waiters = new Map();
    const stubCore = {
      async scanStage1Chunk(ctx) {
        const key = ctx.chunkIndex;
        let resolveGate;
        const gate = new Promise((r) => { resolveGate = r; });
        waiters.set(key, resolveGate);
        await gate;
        if (ctx.isCancelled()) return { cancelled: true, __transfer: [] };
        return { chunkIndex: key, cancelled: false, ok: true, __transfer: [] };
      },
    };
    const worker = createScanWorkerVM({ stubCore });

    // Start job 1 (requestId: null, epoch: 5) and job 2 (requestId: null, epoch: 5)
    worker.send({ t: 'scanStage1', id: 1, epoch: 5, requestId: null, chunkIndex: 1 });
    worker.send({ t: 'scanStage1', id: 2, epoch: 5, requestId: null, chunkIndex: 2 });
    await flushMicrotasks();

    // Cancel ONLY job 1
    worker.send({ t: 'cancel', id: 1, epoch: 5, requestId: null });
    waiters.get(1)();
    waiters.get(2)();
    await flushMicrotasks();

    const res1 = worker.posted.find((p) => p.msg.t === 'res' && p.msg.id === 1);
    const res2 = worker.posted.find((p) => p.msg.t === 'res' && p.msg.id === 2);
    assert.equal(res1.msg.result.cancelled, true, 'cancelled job 1 must return cancelled:true');
    assert.equal(res2.msg.result.cancelled, false, 'sibling job 2 in same epoch must NOT be cancelled');

    // A later job in epoch 5 must also run cleanly (currentEpoch was not polluted to 6)
    worker.send({ t: 'scanStage1', id: 3, epoch: 5, requestId: null, chunkIndex: 3 });
    await flushMicrotasks();
    waiters.get(3)();
    await flushMicrotasks();
    const res3 = worker.posted.find((p) => p.msg.t === 'res' && p.msg.id === 3);
    assert.equal(res3.msg.result.cancelled, false, 'subsequent job in epoch 5 must succeed');
  });

  it('cancelling a single job with shared requestId does not cancel sibling jobs and does not leak inactive IDs', async () => {
    const waiters = new Map();
    const stubCore = {
      async scanStage1Chunk(ctx) {
        let resolveGate;
        const gate = new Promise((r) => { resolveGate = r; });
        waiters.set(ctx.chunkIndex, resolveGate);
        await gate;
        if (ctx.isCancelled()) return { cancelled: true, __transfer: [] };
        return { chunkIndex: ctx.chunkIndex, cancelled: false, __transfer: [] };
      },
    };
    const worker = createScanWorkerVM({ stubCore });

    // Sending cancel for an inactive ID must NOT leak into cancelledJobIds
    worker.send({ t: 'cancel', id: 777, epoch: 1, requestId: 42 });

    // Start two sibling jobs sharing requestId: 42 (one reusing id 777)
    worker.send({ t: 'scanStage1', id: 777, epoch: 1, requestId: 42, chunkIndex: 10 });
    worker.send({ t: 'scanStage1', id: 778, epoch: 1, requestId: 42, chunkIndex: 11 });
    await flushMicrotasks();

    // Cancel ONLY job 778
    worker.send({ t: 'cancel', id: 778, epoch: 1, requestId: 42 });
    waiters.get(10)();
    waiters.get(11)();
    await flushMicrotasks();

    const r777 = worker.posted.find((p) => p.msg.t === 'res' && p.msg.id === 777);
    const r778 = worker.posted.find((p) => p.msg.t === 'res' && p.msg.id === 778);
    assert.equal(r777.msg.result.cancelled, false, 'pre-cancel inactive id 777 and sibling must NOT be cancelled');
    assert.equal(r778.msg.result.cancelled, true, 'active cancelled job 778 must be cancelled');

    // Epoch cancel with monotonic guard: stale epoch 0 does not regress epoch 2
    worker.send({ t: 'cancel', epoch: 2 });
    worker.send({ t: 'cancel', epoch: 0 });
    worker.send({ t: 'scanStage1', id: 779, epoch: 2, requestId: null, chunkIndex: 12 });
    await flushMicrotasks();
    const r779 = worker.posted.find((p) => p.msg.t === 'res' && p.msg.id === 779);
    assert.equal(r779.msg.result.cancelled, true, 'epoch 2 must remain cancelled after stale cancel(epoch:0)');
  });
});

describe('Track 1: T1-P1-2 guessFunctionsDataInCode BigUint64Array support', () => {
  function setupDataInCodeVM(guessResult, dataWords = []) {
    const region = {
      id: 'text',
      vmAddr: 0x1000n,
      fileOffset: 0n,
      size: 0x200n,
      dataInCode: [{ address: 0x1020n, length: 0x10 }], // [0x1020n, 0x1030n)
    };
    const dataBuf = new Uint8Array(0x10);
    const dv = new DataView(dataBuf.buffer);
    for (let i = 0; i < dataWords.length && i * 4 + 4 <= dataBuf.length; i++) {
      dv.setUint32(i * 4, dataWords[i] >>> 0, true);
    }
    const ctx = vm.createContext({
      console,
      BigInt,
      Number,
      String,
      Array,
      Object,
      Map,
      Set,
      Uint8Array,
      BigUint64Array,
      ArrayBuffer,
      DataView,
      INSN_SIZE: 4,
      CHUNK_BYTES: 4096,
      MAX_EDGES: 1000,
      MAX_REFS: 1000,
      MAX_KIND_WORDS: 1000,
      regions: new Map([['text', region]]),
      functionStartsForRegion: () => [0x1020n], // authoritative start inside dataInCode must be kept
      readRange: async () => dataBuf,
      getChunk: async () => ({}),
      scanProgram: async () => ({}),
      findXrefs: async () => ({ results: [] }),
      guessFunctions: async () => guessResult,
      runSearch: async () => ({ results: [] }),
    });
    ctx.globalThis = ctx;
    loadClassicScript(ctx, 'js/words.js');
    loadClassicScript(ctx, 'js/worker-data-in-code-fix.js');
    return ctx;
  }

  it('filters BigUint64Array starts and replaces only starts.buffer in __transfer', async () => {
    // At 0x1020n: BL +0x40 -> target 0x1060n (0x94000010)
    const starts = new BigUint64Array([
      0x1000n, // valid code -> keep
      0x1020n, // authoritative -> keep
      0x1024n, // inside dataInCode -> drop
      0x1030n, // dataInCode end -> drop
      0x1060n, // target of branch inside dataInCode -> drop
      0x1080n, // valid code -> keep
    ]);
    const extraBuf = new ArrayBuffer(8);
    const origStartsBuf = starts.buffer;
    const ctx = setupDataInCodeVM(
      { starts, __transfer: [extraBuf, origStartsBuf] },
      [0x94000010],
    );

    const out = await ctx.guessFunctions({ regionId: 'text' });
    assert.ok(out.starts instanceof ctx.BigUint64Array || out.starts instanceof BigUint64Array);
    assert.deepEqual(Array.from(out.starts), [0x1000n, 0x1020n, 0x1080n]);
    assert.equal(out.__transfer.length, 2);
    assert.equal(out.__transfer[0], extraBuf, 'unrelated buffer in __transfer must be preserved');
    assert.equal(out.__transfer[1], out.starts.buffer, 'starts.buffer must be swapped to filtered.buffer');
    assert.notEqual(out.__transfer[1], origStartsBuf);
  });

  it('sets __transfer to [filtered.buffer] when original __transfer is absent', async () => {
    const starts = new BigUint64Array([0x1000n, 0x1024n, 0x1080n]);
    const ctx = setupDataInCodeVM({ starts });
    const out = await ctx.guessFunctions({ regionId: 'text' });
    assert.deepEqual(Array.from(out.starts), [0x1000n, 0x1080n]);
    assert.equal(out.__transfer.length, 1);
    assert.equal(out.__transfer[0], out.starts.buffer);
  });

  it('preserves plain Array behavior and passes through unsupported starts types untouched', async () => {
    const ctxArr = setupDataInCodeVM({ starts: [0x1000n, 0x1024n, 0x1080n] });
    const outArr = await ctxArr.guessFunctions({ regionId: 'text' });
    assert.ok(Array.isArray(outArr.starts));
    assert.deepEqual(outArr.starts, [0x1000n, 0x1080n]);

    const other = new Uint32Array([1, 2, 3]);
    const ctxOther = setupDataInCodeVM({ starts: other });
    const outOther = await ctxOther.guessFunctions({ regionId: 'text' });
    assert.equal(outOther.starts, other);
  });
});

describe('Track 1: T1-P1-3 legacy worker epoch propagation across all scan paths', () => {
  function createLegacyWorkerVM() {
    const posted = [];
    const ctx = vm.createContext({
      postMessage(msg, transfer) {
        posted.push({ msg, transfer });
      },
      onmessage: null,
      console,
      setTimeout,
      clearTimeout,
      performance,
      Date,
      Math,
      BigInt,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Map,
      Set,
      WeakSet,
      Promise,
      Error,
      TypeError,
      Uint8Array,
      Uint16Array,
      Uint32Array,
      Int32Array,
      Int8Array,
      BigUint64Array,
      ArrayBuffer,
      DataView,
      TextDecoder,
      TextEncoder,
      importScripts(...scripts) {
        for (const s of scripts) {
          if (s.includes('capstone')) {
            ctx.createCapstone = async () => ({
              _malloc: () => 1,
              _free: () => {},
              _cs_open: () => 0,
              _cs_option: () => 0,
              _cs_disasm: () => 0,
              _cs_free: () => {},
              HEAPU8: new Uint8Array(1024),
              HEAPU32: new Uint32Array(256),
            });
            continue;
          }
          const resolved = path.join('js', s.replace(/^\.\//, ''));
          loadClassicScript(ctx, resolved);
        }
      },
    });
    ctx.self = ctx;
    ctx.globalThis = ctx;
    loadClassicScript(ctx, 'js/worker-legacy.js');
    return { ctx, posted, selfObj: ctx };
  }

  it('cancelled(requestId, epoch) returns true on epoch mismatch and propagates across analyzeSlice, findFieldAccess, scanStrings, findXrefs, and runSearch (hex/text/asm)', async () => {
    const { ctx } = createLegacyWorkerVM();
    // Prepare a synthetic file and region inside the legacy worker VM
    const bytes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bytes[i] = 0x41; // 'AAAA...'
    const fakeFile = {
      size: bytes.length,
      slice(s, e) {
        return { async arrayBuffer() { return bytes.slice(s, e).buffer; } };
      },
    };
    ctx.__fakeFile = fakeFile;
    vm.runInContext(`
      currentEpoch = 5;
      file = __fakeFile;
      fileSize = 64n;
      regions.set('r0', { id: 'r0', vmAddr: 0x1000n, fileOffset: 0n, size: 64n, name: '__text', exec: true });
      cs = { M: {}, handle: 1, hp: 1 };
    `, ctx);

    // 1. Direct cancelled() check
    assert.equal(vm.runInContext('cancelled(1, 5)', ctx), false);
    assert.equal(vm.runInContext('cancelled(1, 4)', ctx), true, 'stale epoch must be immediately cancelled');
    assert.equal(vm.runInContext('cancelled(null, 4)', ctx), true, 'stale epoch must cancel even when requestId is null');

    // 2. findFieldAccess with stale epoch 4
    const fieldRes = await vm.runInContext(
      `findFieldAccess({ regionId: 'r0', offsets: [{ offset: 0x10, size: 4 }], limit: 10, requestId: 10, epoch: 4 })`,
      ctx,
    );
    assert.equal(fieldRes.cancelled, true, 'findFieldAccess must cancel on stale epoch');

    // 3. scanStrings with stale epoch 4
    const strRes = await vm.runInContext(
      `scanStrings({ regionId: 'r0', min: 4, limit: 10, requestId: 11, epoch: 4 })`,
      ctx,
    );
    assert.equal(strRes.cancelled, true, 'scanStrings must cancel on stale epoch');

    // 4. findXrefs with stale epoch 4
    const xrefRes = await vm.runInContext(
      `findXrefs({ regionId: 'r0', target: 0x1000n, limit: 10, requestId: 12, epoch: 4 })`,
      ctx,
    );
    assert.equal(xrefRes.cancelled, true, 'findXrefs must cancel on stale epoch');

    // 5. runSearch hex / text / asm with stale epoch 4
    const hexRes = await vm.runInContext(
      `runSearch({ regionId: 'r0', kind: 'hex', hex: { bytes: [0x41], mask: [0xff] }, requestId: 13, epoch: 4 })`,
      ctx,
    );
    assert.equal(hexRes.cancelled, true, 'runSearch(hex) must cancel on stale epoch');

    const textRes = await vm.runInContext(
      `runSearch({ regionId: 'r0', kind: 'text', query: 'AA', requestId: 14, epoch: 4 })`,
      ctx,
    );
    assert.equal(textRes.cancelled, true, 'runSearch(text) must cancel on stale epoch');

    const asmRes = await vm.runInContext(
      `runSearch({ regionId: 'r0', kind: 'asm', query: 'ret', requestId: 15, epoch: 4 })`,
      ctx,
    );
    assert.equal(asmRes.cancelled, true, 'runSearch(asm) must cancel on stale epoch');

    // 6. analyzeSlice passes epoch into MachO.parseFunctionStarts shouldCancel
    let observedShouldCancel = null;
    const origParseFnStarts = ctx.MachO.parseFunctionStarts;
    ctx.MachO.parseFunctionStarts = (buf, textVM, opts) => {
      observedShouldCancel = opts.shouldCancel();
      return Object.assign([], { complete: false, truncated: true, partialReason: 'cancelled' });
    };
    try {
      vm.runInContext(`
        slices = [{
          offset: 0n,
          size: 64n,
          regions: [],
          info: {
            is64: true,
            textVM: 0x1000n,
            architecture: 'arm64',
            functionStarts: { dataoff: 0, datasize: 8 },
          },
        }];
      `, ctx);
      await vm.runInContext(`analyzeSlice({ sliceIndex: 0, id: 16, epoch: 4 })`, ctx);
      assert.equal(observedShouldCancel, true, 'analyzeSlice must propagate epoch to shouldCancel');
    } finally {
      ctx.MachO.parseFunctionStarts = origParseFnStarts;
    }
  });
});

describe('Track 1: T1-P2-1 hidden-tab worker reuse & idle termination without thrashing', () => {
  it('reuses a single worker across queued tasks while document.hidden and terminates on idle or when queued work is stale', async () => {
    const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      value: { hidden: true },
      configurable: true,
      writable: true,
    });
    try {
      const workers = [];
      const pool = new ScanWorkerPool({
        maxWorkers: 4,
        workerFactory: () => {
          const w = new MockWorker();
          workers.push(w);
          return w;
        },
      });

      const t1 = pool.runTask({ t: 'scanStage1', epoch: 1, requestId: 1 });
      const t2 = pool.runTask({ t: 'scanStage1', epoch: 1, requestId: 1 });
      const t3 = pool.runTask({ t: 'scanStage1', epoch: 1, requestId: 1 });
      assert.equal(workers.length, 1);

      // Complete t1 -> t2 dispatched on SAME worker (no spawn, no terminate)
      workers[0].emitMessage({ t: 'res', ok: true, id: workers[0].sent[0].msg.id, result: { n: 1 } });
      await t1;
      assert.equal(workers.length, 1);
      assert.equal(workers[0].terminated, false);
      assert.equal(workers[0].sent.length, 2);

      // Complete t2 -> t3 dispatched on SAME worker
      workers[0].emitMessage({ t: 'res', ok: true, id: workers[0].sent[1].msg.id, result: { n: 2 } });
      await t2;
      assert.equal(workers.length, 1);
      assert.equal(workers[0].terminated, false);
      assert.equal(workers[0].sent.length, 3);

      // Complete t3 -> queue empty -> worker terminated immediately
      workers[0].emitMessage({ t: 'res', ok: true, id: workers[0].sent[2].msg.id, result: { n: 3 } });
      await t3;
      assert.equal(workers[0].terminated, true);
      assert.equal(pool.activeWorkerCount, 0);

      // Idle leak guard: if queued item is stale/cancelled when worker finishes, worker must still terminate
      const a1 = pool.runTask({ t: 'scanStage1', epoch: 1, requestId: 10 });
      const a2 = pool.runTask({ t: 'scanStage1', epoch: 1, requestId: 11 });
      assert.equal(workers.length, 2);
      pool.cancelRequest(1, 11);
      await assert.rejects(a2, (e) => e && e.name === 'AbortError');
      workers[1].emitMessage({ t: 'res', ok: true, id: workers[1].sent[0].msg.id, result: { ok: true } });
      await a1;
      assert.equal(workers[1].terminated, true, 'hidden worker must terminate when queue drains to nothing');
      assert.equal(pool.activeWorkerCount, 0);

      pool.dispose();
    } finally {
      if (savedDoc) Object.defineProperty(globalThis, 'document', savedDoc);
      else delete globalThis.document;
    }
  });
});

describe('Track 1: T1-P2-2 scanStage1 two-pass monotonic progress callback wiring', () => {
  it('emits monotonic progress in Pass 1 (<=80%) and Pass 2 (80%..100%) when local loop exists, and reaches 100% without Pass 2', async () => {
    const ctx = vm.createContext({
      console, setTimeout, clearTimeout, performance, Date, Math, BigInt, Number, String, Boolean,
      Array, Object, Map, Set, Promise, Error, Uint8Array, Uint32Array, Int32Array, Int8Array,
      BigUint64Array, ArrayBuffer, DataView,
    });
    ctx.globalThis = ctx;
    loadClassicScript(ctx, 'js/words.js');
    loadClassicScript(ctx, 'js/worker-budget.js');
    loadClassicScript(ctx, 'js/address-provenance.js');
    loadClassicScript(ctx, 'js/scan-core.js');

    // Case A: backward branch loop (NOP, NOP, B -8 -> 0x17fffffe, RET)
    const loopWords = [0xd503201f, 0xd503201f, 0x17fffffe, 0xd65f03c0];
    const loopFile = makeFakeFileFromUint32(loopWords);
    const region = { id: 'text', vmAddr: 0x1000n, fileOffset: 0n, size: BigInt(loopWords.length * 4) };
    const progLoop = [];
    const resLoop = await ctx.HexScanCore.scanStage1Chunk({
      file: loopFile,
      region,
      chunkStart: 0,
      chunkEnd: loopWords.length * 4,
      chunkIndex: 0,
      functionStarts: [0x1000n],
      onProgress: (done, all, hits) => progLoop.push({ done, all, hits }),
    });
    assert.equal(resLoop.cancelled, false);
    assert.ok(progLoop.length >= 2, 'Pass 1 + Pass 2 must emit at least 2 progress points');
    const chunkLen = loopWords.length * 4;
    const p1Cap = Math.floor(chunkLen * 0.8);
    assert.equal(progLoop[0].done, p1Cap, 'Pass 1 must cap at Math.floor(chunkLen * 0.8)');
    assert.equal(progLoop[progLoop.length - 1].done, chunkLen, 'Pass 2 must reach chunkLen');
    for (let i = 0; i < progLoop.length; i++) {
      assert.equal(progLoop[i].all, chunkLen);
      if (i > 0) assert.ok(progLoop[i].done >= progLoop[i - 1].done, 'progress must be monotonic');
    }

    // Case B: no backward branch (NOP, NOP, NOP, RET) -> Pass 2 skipped, final progress reaches chunkLen
    const linearWords = [0xd503201f, 0xd503201f, 0xd503201f, 0xd65f03c0];
    const linearFile = makeFakeFileFromUint32(linearWords);
    const progLinear = [];
    const resLinear = await ctx.HexScanCore.scanStage1Chunk({
      file: linearFile,
      region,
      chunkStart: 0,
      chunkEnd: chunkLen,
      chunkIndex: 0,
      functionStarts: [0x1000n],
      onProgress: (done, all, hits) => progLinear.push({ done, all, hits }),
    });
    assert.equal(resLinear.cancelled, false);
    assert.equal(progLinear[0].done, p1Cap);
    assert.equal(progLinear[progLinear.length - 1].done, chunkLen);

    // Case C: wired end-to-end through js/scan-worker.js
    const worker = createScanWorkerVM();
    worker.send({
      t: 'scanStage1',
      id: 55,
      epoch: 1,
      requestId: 9,
      file: loopFile,
      region,
      chunkStart: 0,
      chunkEnd: chunkLen,
      chunkIndex: 0,
      functionStarts: [0x1000n],
    });
    await flushMicrotasks(20);
    const progressMsgs = worker.posted.filter((p) => p.msg.t === 'progress' && p.msg.id === 55);
    const resMsg = worker.posted.find((p) => p.msg.t === 'res' && p.msg.id === 55);
    assert.ok(resMsg && resMsg.msg.ok === true, 'scanStage1 worker task must succeed');
    assert.ok(progressMsgs.length >= 2, 'scan-worker.js must forward scanStage1 progress messages');
    assert.equal(progressMsgs[progressMsgs.length - 1].msg.done, chunkLen);
  });
});

describe('Track 1: T1-P2-3 mergeChunkProgramScans budgetCapped propagation', () => {
  it('propagates budgetCapped into returned object, truncationReasons, truncated, and complete', () => {
    const region = { id: 'text', vmAddr: 0x1000n, size: 16n };
    const chunks = [
      { chunkIndex: 0, wordBase: 0 },
      { chunkIndex: 1, wordBase: 2 },
    ];
    const makeChunkResult = (chunkIndex, wordBase, budgetCapped) => ({
      chunkIndex,
      chunkWordBase: wordBase,
      callFrom: new BigUint64Array(0),
      callTo: new BigUint64Array(0),
      callCount: 0,
      refFrom: new BigUint64Array(0),
      refTo: new BigUint64Array(0),
      refKind: new Uint8Array(0),
      refCount: 0,
      kinds: new Uint8Array(2),
      callsLimitCapped: false,
      refsLimitCapped: false,
      budgetCapped,
    });

    const capped = mergeChunkProgramScans({
      region,
      chunks,
      chunkResults: [makeChunkResult(0, 0, false), makeChunkResult(1, 2, true)],
    });
    assert.equal(capped.budgetCapped, true);
    assert.equal(capped.truncated, true);
    assert.equal(capped.complete, false);
    assert.equal(capped.truncationReason, 'program-index-memory-budget');
    assert.equal(capped.completeness.complete, false);
    assert.ok(capped.completeness.reasons.includes('program-index-memory-budget'));

    const clean = mergeChunkProgramScans({
      region,
      chunks,
      chunkResults: [makeChunkResult(0, 0, false), makeChunkResult(1, 2, false)],
    });
    assert.equal(clean.budgetCapped, false);
    assert.equal(clean.truncated, false);
    assert.equal(clean.complete, true);
    assert.equal(clean.truncationReason, null);
    assert.deepEqual(clean.completeness.reasons, []);
  });
});

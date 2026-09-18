import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../../js/platform/worker.js', import.meta.url));
const workerSource = fs.readFileSync(workerPath, 'utf8').replace(/^import .*;\n/gm, '');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixtureImage() {
  return {
    arch:'x86_64',
    format:'elf',
    fileSize:1n,
    metadata:{},
    libraries:[],
    imports:[],
    symbols:[],
    functions:[],
    addressToOffset() { return null; },
  };
}

function fixtureDescriptor() {
  return {
    platform:{},
    slices:[],
    raw:{ id:'raw' },
    capability:{ source:'fixture' },
  };
}

function createWorkerHarness({ deferOpen = false } = {}) {
  const posts = [];
  const openReady = deferred();
  let openCalls = 0;
  let detectCalls = 0;
  let memoryStatsCalls = 0;

  class FakeCachedByteSource {
    constructor(base) {
      this.size = base.size;
      this.maxReadLength = base.maxReadLength ?? 8 * 1024 * 1024;
    }
    async read() { return new Uint8Array([0]); }
    async readExactly() { return new Uint8Array([0]); }
    clear() {}
    memoryStats() { memoryStatsCalls++; return { bytesCached:0 }; }
  }

  const self = { postMessage(message) { posts.push(message); } };
  const context = vm.createContext({
    self,
    TextDecoder,
    TextEncoder,
    AbortController,
    Uint8Array,
    BigUint64Array,
    BigInt,
    Promise,
    Map,
    Set,
    URL,
    setTimeout,
    clearTimeout,
    console,
    asByteSource(input) {
      return {
        size:input.size,
        maxReadLength:8 * 1024 * 1024,
        async read() { return new Uint8Array([0]); },
      };
    },
    CachedByteSource:FakeCachedByteSource,
    detectBinary() { detectCalls++; return { format:'elf', fat:false }; },
    async openBinarySource() {
      openCalls++;
      if (deferOpen) await openReady.promise;
      return fixtureImage();
    },
    async parseMachOSource() { return fixtureImage(); },
    describeBinaryImage() { return fixtureDescriptor(); },
    fingerprintVendors() { return []; },
    async hashByteSource() { return 'hash'; },
    boundedOffset(value) { return BigInt(value); },
    checkedChunkIndex(value) { return Number(value); },
    chunkLength(value, cap) { return Number(value < BigInt(cap) ? value : BigInt(cap)); },
    exactExternalInteger(value) { return typeof value === 'bigint' ? Number(value) : value; },
    regionSize(value) { return BigInt(value); },
    utf8Len() { return 1; },
    isExactFunctionSeed() { return false; },
    analysisFromBinaryImage() { return {}; },
    emptyAnalysis() { return {}; },
    async analyzeDecodedSemanticFunction() { return {}; },
    resolveMachOPointer() { return null; },
  });

  vm.runInContext(workerSource, context, { filename:workerPath });
  return {
    posts,
    send(data) { return self.onmessage({ data }); },
    resolveOpen() { openReady.resolve(); },
    rejectOpen(error = new Error('synthetic open failure')) { openReady.reject(error); },
    openCalls() { return openCalls; },
    detectCalls() { return detectCalls; },
    memoryStatsCalls() { return memoryStatsCalls; },
  };
}

function replyFor(posts, id) {
  return [...posts].reverse().find((message) => (message.t === 'ok' || message.t === 'err') && message.id === id);
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

// A failed serialized open must fail only that request. The ordering barrier
// must settle so an unrelated request can execute its own handler afterward.
{
  const worker = createWorkerHarness();
  await worker.send({ t:'open', id:1, epoch:1, file:{ name:'bad', size:0 } });
  assert.equal(replyFor(worker.posts, 1)?.t, 'err');
  assert.match(replyFor(worker.posts, 1)?.error || '', /empty|invalid size/i);

  await worker.send({ t:'memoryStats', id:2, epoch:1 });
  assert.equal(replyFor(worker.posts, 2)?.t, 'ok', 'failed open must not poison later non-serialized requests');
  assert.equal(replyFor(worker.posts, 2)?.result.functionsIndexed, 0);
}

// Detect failures use the same serialized barrier and must not leak their
// request-local error into later request results.
{
  const worker = createWorkerHarness();
  await worker.send({ t:'detect', id:3, epoch:7, file:{ name:'bad', size:0 } });
  assert.equal(replyFor(worker.posts, 3)?.t, 'err');

  await worker.send({ t:'probe', id:4, epoch:7 });
  assert.equal(replyFor(worker.posts, 4)?.t, 'ok', 'failed detect must not poison later probe');
  assert.equal(replyFor(worker.posts, 4)?.result.ok, true);
}

// The fix must retain the barrier property: normal work queued during a live
// open starts only after that open settles.
{
  const worker = createWorkerHarness({ deferOpen:true });
  const opening = worker.send({ t:'open', id:5, epoch:11, file:{ name:'fixture', size:1 } });
  await waitFor(() => worker.openCalls() === 1, 'open must enter the serialized barrier');

  const stats = worker.send({ t:'memoryStats', id:6, epoch:11 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replyFor(worker.posts, 6), undefined, 'normal request must remain queued while open is unresolved');

  worker.resolveOpen();
  await Promise.all([opening, stats]);
  assert.equal(replyFor(worker.posts, 5)?.t, 'ok');
  assert.equal(replyFor(worker.posts, 6)?.t, 'ok');
  assert.equal(worker.memoryStatsCalls(), 1, 'queued request must execute exactly once after the barrier');
}

// A failure must not weaken serialized recovery either: the next valid open
// still runs and publishes the new descriptor.
{
  const worker = createWorkerHarness();
  await worker.send({ t:'open', id:7, epoch:20, file:{ name:'bad', size:0 } });
  await worker.send({ t:'open', id:8, epoch:21, file:{ name:'fixture', size:1 } });
  assert.equal(replyFor(worker.posts, 8)?.t, 'ok');
  assert.equal(worker.openCalls(), 1);
  await worker.send({ t:'probe', id:9, epoch:21 });
  assert.deepEqual(replyFor(worker.posts, 9)?.result.capability, { source:'fixture' });
}


// A request queued before the serialized failure settles must also run after
// the barrier settles; failure isolation cannot depend on arrival timing.
{
  const worker = createWorkerHarness({ deferOpen:true });
  const opening = worker.send({ t:'open', id:10, epoch:30, file:{ name:'fixture', size:1 } });
  await waitFor(() => worker.openCalls() === 1, 'failing open must enter the serialized barrier');

  const probe = worker.send({ t:'probe', id:11, epoch:30 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replyFor(worker.posts, 11), undefined, 'probe must wait for the unresolved serialized request');

  worker.rejectOpen();
  await Promise.all([opening, probe]);
  assert.equal(replyFor(worker.posts, 10)?.t, 'err');
  assert.match(replyFor(worker.posts, 10)?.error || '', /synthetic open failure/);
  assert.equal(replyFor(worker.posts, 11)?.t, 'ok', 'queued request must execute after a failed barrier');
}

console.log('issue-4959 platform worker open-chain recovery: PASS');

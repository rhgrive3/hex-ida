import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../../js/platform/worker.js', import.meta.url));
const workerSource = fs.readFileSync(workerPath, 'utf8').replace(/^import .*;\n/gm, '');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
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
    capability:null,
  };
}

function createWorkerHarness() {
  const posts = [];
  const openReady = deferred();
  let hashReady = null;
  let openCalls = 0;
  let hashCalls = 0;
  let clearCalls = 0;

  class FakeCachedByteSource {
    constructor(base) {
      this.size = base.size;
      this.maxReadLength = base.maxReadLength ?? 8 * 1024 * 1024;
    }
    async read() { return new Uint8Array(); }
    async readExactly() { return new Uint8Array(); }
    clear() { clearCalls++; }
    memoryStats() { return { bytesCached:0 }; }
  }

  const self = {
    postMessage(message) { posts.push(message); },
  };

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
        async read() { return new Uint8Array(); },
      };
    },
    CachedByteSource:FakeCachedByteSource,
    detectBinary() { return { format:'elf', fat:false }; },
    async openBinarySource() {
      openCalls++;
      await openReady.promise;
      return fixtureImage();
    },
    async parseMachOSource() { return fixtureImage(); },
    describeBinaryImage() { return fixtureDescriptor(); },
    fingerprintVendors() { return []; },
    async hashByteSource() {
      hashCalls++;
      if (!hashReady) return 'hash';
      return hashReady.promise;
    },
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
    deferHash() { hashReady = deferred(); return hashReady; },
    openCalls() { return openCalls; },
    hashCalls() { return hashCalls; },
    clearCalls() { return clearCalls; },
  };
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function replyFor(posts, id) {
  return [...posts].reverse().find((message) => (message.t === 'ok' || message.t === 'err') && message.id === id);
}

{
  const worker = createWorkerHarness();
  const opening = worker.send({ t:'open', id:1, epoch:1, file:{ name:'fixture', size:1 } });
  await waitFor(() => worker.openCalls() === 1, 'open must enter the serialized worker barrier');

  const queued = worker.send({ t:'cleanupMemory', id:2, epoch:1 });
  await Promise.resolve();
  await worker.send({ t:'cancel', requestId:2, epoch:1 });

  worker.resolveOpen();
  await Promise.all([opening, queued]);

  assert.equal(worker.clearCalls(), 0, 'cancelled request waiting on openChain must never reach handle()');
  assert.match(replyFor(worker.posts, 2)?.error || '', /cancel/i);

  await worker.send({ t:'probe', id:2, epoch:1 });
  assert.equal(replyFor(worker.posts, 2)?.t, 'ok', 'completed queued cancellation must not poison request-id reuse');

  await worker.send({ t:'cancel', requestId:99, epoch:1 });
  await worker.send({ t:'probe', id:99, epoch:1 });
  assert.equal(replyFor(worker.posts, 99)?.t, 'ok', 'unknown cancellation must not poison a future request id');
}

{
  const worker = createWorkerHarness();
  const opening = worker.send({ t:'open', id:1, epoch:7, file:{ name:'fixture', size:1 } });
  await waitFor(() => worker.openCalls() === 1, 'fixture open must start');
  worker.resolveOpen();
  await opening;

  const hashReady = worker.deferHash();
  const foreground = worker.send({ t:'hash', id:10, epoch:7 });
  await waitFor(() => worker.hashCalls() === 1, 'foreground request must become active');

  const background = worker.send({ t:'cleanupMemory', id:11, epoch:7, priority:'background' });
  await new Promise((resolve) => setImmediate(resolve));
  await worker.send({ t:'cancel', requestId:null, epoch:7 });

  hashReady.resolve('hash');
  await Promise.all([foreground, background]);

  assert.equal(worker.clearCalls(), 0, 'epoch-wide cancellation must cover requests waiting for foreground drain');
  assert.match(replyFor(worker.posts, 11)?.error || '', /cancel/i);
}

console.log('issue-4507 platform worker queued cancellation: PASS');

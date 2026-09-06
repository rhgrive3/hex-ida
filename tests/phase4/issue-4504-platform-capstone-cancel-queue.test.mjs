import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(
  new URL('../../js/platform/capstone-disasm-worker.js', import.meta.url),
);
const workerSource = fs.readFileSync(workerPath, 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeCapstoneModule() {
  let nextPointer = 16;
  return {
    ARCH_ARM64: 1,
    MODE_ARM: 1,
    MODE_LITTLE_ENDIAN: 0,
    OPT_SKIPDATA: 0,
    OPT_ON: 1,
    _malloc(size) {
      const pointer = nextPointer;
      nextPointer += Math.max(4, Number(size) || 0);
      return pointer;
    },
    _free() {},
    getValue() { return 1; },
    writeArrayToMemory() {},
    UTF8ToString() { return ''; },
    ccall(name) {
      if (name === 'cs_open' || name === 'cs_option') return 0;
      if (name === 'cs_disasm') return 0;
      return 0;
    },
  };
}

function createWorkerHarness() {
  const posts = [];
  const moduleReady = deferred();
  const self = {
    location: { href:'https://example.test/js/platform/capstone-disasm-worker.js' },
    postMessage(message) { posts.push(message); },
  };
  const context = vm.createContext({
    self,
    importScripts() {},
    MCapstone() { return moduleReady.promise; },
    URL,
    Uint8Array,
    BigInt,
    console,
  });
  vm.runInContext(workerSource, context, { filename:workerPath });
  return {
    posts,
    resolveModule() { moduleReady.resolve(fakeCapstoneModule()); },
    send(data) { self.onmessage({ data }); },
  };
}

function request(id) {
  return {
    id,
    architecture:'arm64',
    address:0,
    bytes:new Uint8Array(),
    priority:'visible',
  };
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

{
  const worker = createWorkerHarness();

  worker.send(request(1)); // active while Capstone initialization is deferred
  worker.send(request(2)); // queued behind request 1
  worker.send({ t:'cancel', id:2 });
  worker.send(request(2)); // same id is valid again after queued cancellation

  worker.send({ t:'cancel', id:99 }); // unknown/already-settled ids must not poison reuse
  worker.send(request(99));

  worker.resolveModule();
  await waitFor(
    () => worker.posts.length === 3,
    'queued/unknown cancellation markers must not suppress later requests with the same id',
  );

  assert.deepEqual(
    worker.posts.map((message) => message.id),
    [1, 2, 99],
  );
  assert.ok(worker.posts.every((message) => message.ok === true));
}

{
  const worker = createWorkerHarness();

  worker.send(request(7));
  worker.send({ t:'cancel', id:7 }); // active cancellation remains cooperative
  worker.resolveModule();

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(worker.posts, []);

  worker.send(request(7)); // active marker must be released after cancellation settles
  await waitFor(
    () => worker.posts.length === 1,
    'completed active cancellation must not poison a later request id reuse',
  );
  assert.equal(worker.posts[0].id, 7);
  assert.equal(worker.posts[0].ok, true);
}

{
  // Generation safety: A(id=7) active while Capstone init is deferred, then
  // B(id=7) arrives. The bare id cannot address a generation, so B must be
  // rejected at entry instead of queueing behind A where a cancel for one
  // generation would hit the other.
  const worker = createWorkerHarness();

  worker.send(request(7)); // A becomes active while module init is deferred
  worker.send(request(7)); // B reuses the live id and must be rejected
  await new Promise((resolve) => setImmediate(resolve));
  await waitFor(
    () => worker.posts.length === 1,
    'live id reuse must be rejected fail-closed at entry',
  );
  assert.equal(worker.posts[0].id, 7);
  assert.equal(worker.posts[0].ok, false);
  assert.match(worker.posts[0].error || '', /duplicate live request id/);

  // Cancelling id=7 now addresses only the single live generation (A):
  // A is cooperatively cancelled and B never executes afterwards.
  worker.send({ t:'cancel', id:7 });
  worker.resolveModule();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    worker.posts.filter((message) => message.ok === true),
    [],
    'wrong-generation execution must not occur after entry rejection',
  );

  // Sequential reuse after everything settled stays valid.
  worker.send(request(7));
  await waitFor(
    () => worker.posts.some((message) => message.ok === true && message.id === 7),
    'id reuse after settle must remain valid',
  );
}

console.log('issue-4504 platform capstone cancellation queue: PASS');

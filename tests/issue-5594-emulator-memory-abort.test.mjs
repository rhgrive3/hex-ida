import assert from 'node:assert/strict';
import test from 'node:test';

import { Emulator } from '../js/emu.js';

function deferredCancelable() {
  let resolve;
  let reject;
  let cancelCount = 0;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.cancel = () => { cancelCount++; };
  return { promise, resolve, reject, get cancelCount() { return cancelCount; } };
}

function gate() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

async function within(promise, ms = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test-timeout')), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function memoryInstructionEmulator(mn = 'ldr', operation = deferredCancelable()) {
  const started = gate();
  const emu = new Emulator({
    fetch: async () => ({ mn, ops: mn === 'str' ? 'x0, [x1]' : 'x0, [x1]' }),
    read: () => { started.resolve(); return operation.promise; },
  });
  emu.set('x1', 0x2000n);
  emu.set('x0', 0x55n);
  return { emu, operation, started };
}

test('#5594 abort during pending memory I/O rejects step and cancels a cancel-capable read', async () => {
  const { emu, operation, started } = memoryInstructionEmulator('ldr');
  const controller = new AbortController();
  const stepPromise = emu.step({ signal: controller.signal });
  await within(started.promise);
  controller.abort();
  await assert.rejects(within(stepPromise), (error) => error?.name === 'AbortError');
  assert.equal(operation.cancelCount, 1);
});

test('#5594 run propagates the same memory cancellation contract', async () => {
  const { emu, operation, started } = memoryInstructionEmulator('ldr');
  const controller = new AbortController();
  const runPromise = emu.run(10, null, { signal: controller.signal });
  await within(started.promise);
  controller.abort();
  await assert.rejects(within(runPromise), (error) => error?.name === 'AbortError');
  assert.equal(operation.cancelCount, 1);
});

test('#5594 STR mapping read is abortable before any backing page is published', async () => {
  const { emu, operation, started } = memoryInstructionEmulator('str');
  const controller = new AbortController();
  const stepPromise = emu.step({ signal: controller.signal });
  await within(started.promise);
  controller.abort();
  await assert.rejects(within(stepPromise), (error) => error?.name === 'AbortError');
  assert.equal(operation.cancelCount, 1);
  assert.equal(emu.loaded.has('8192'), false);
  assert.equal(emu.mem.has('8192'), false);
});

test('#5594 a pre-aborted step starts neither fetch nor memory I/O', async () => {
  let fetches = 0;
  let reads = 0;
  const emu = new Emulator({
    fetch: async () => { fetches++; return { mn: 'ldr', ops: 'x0, [x1]' }; },
    read: async () => { reads++; return new Uint8Array(4096); },
  });
  emu.set('x1', 0x2000n);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(emu.step({ signal: controller.signal }), (error) => error?.name === 'AbortError');
  assert.equal(fetches, 0);
  assert.equal(reads, 0);
});

test('#5594 fetch and memory operations both receive cancel() when aborted in flight', async () => {
  const fetchOp = deferredCancelable();
  const fetchStarted = gate();
  const fetchEmu = new Emulator({
    fetch: () => { fetchStarted.resolve(); return fetchOp.promise; },
    read: async () => new Uint8Array(4096),
  });
  const fetchController = new AbortController();
  const fetchStep = fetchEmu.step({ signal: fetchController.signal });
  await within(fetchStarted.promise);
  fetchController.abort();
  await assert.rejects(within(fetchStep), (error) => error?.name === 'AbortError');
  assert.equal(fetchOp.cancelCount, 1);

  const { emu, operation, started } = memoryInstructionEmulator('ldr');
  const memoryController = new AbortController();
  const memoryStep = emu.step({ signal: memoryController.signal });
  await within(started.promise);
  memoryController.abort();
  await assert.rejects(within(memoryStep), (error) => error?.name === 'AbortError');
  assert.equal(operation.cancelCount, 1);
});

test('#5594 a late read result after abort cannot populate the page cache', async () => {
  const { emu, operation, started } = memoryInstructionEmulator('ldr');
  const controller = new AbortController();
  const stepPromise = emu.step({ signal: controller.signal });
  await within(started.promise);
  controller.abort();
  await assert.rejects(within(stepPromise), (error) => error?.name === 'AbortError');
  operation.resolve(new Uint8Array(4096).fill(0x7f));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(emu.loaded.has('8192'), false);
  assert.equal(emu.loadedValid.has('8192'), false);
});

test('#5594 settling memory I/O still completes and loads the value', async () => {
  const page = new Uint8Array(4096);
  page[0] = 0x2a;
  const emu = new Emulator({
    fetch: async () => ({ mn: 'ldr', ops: 'x0, [x1]' }),
    read: async () => page,
  });
  emu.set('x1', 0x2000n);
  const result = await emu.step();
  assert.equal(result.ok, true);
  assert.equal(emu.get('x0'), 0x2an);
});

test('#5594 synchronous io.read throw retains memory-read-failed taxonomy', async () => {
  const emu = new Emulator({
    fetch: async () => ({ mn: 'ldr', ops: 'x0, [x1]' }),
    read: () => { throw new Error('sync-backend-boom'); },
  });
  emu.set('x1', 0x2000n);
  const result = await emu.step();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'memory-read-failed');
  assert.match(result.reason, /backing read failed/);
});

test('#5594 rejected io.read Promise retains memory-read-failed taxonomy', async () => {
  const emu = new Emulator({
    fetch: async () => ({ mn: 'ldr', ops: 'x0, [x1]' }),
    read: async () => { throw new Error('async-backend-boom'); },
  });
  emu.set('x1', 0x2000n);
  const result = await emu.step();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'memory-read-failed');
});

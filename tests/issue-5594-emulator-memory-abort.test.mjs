import assert from 'node:assert/strict';
import test from 'node:test';

import { Emulator } from '../js/emu.js';

// #5594: Emulator run(..., { signal }) / step() must propagate the AbortSignal
// into instruction execution's memory I/O. A backing io.read that never settles
// previously pinned run()/step() forever after the caller aborted, because
// ensure() awaited the read without racing the signal.

const neverSettlingEmulator = () => new Emulator({
  fetch: async () => ({ mn: 'ldr', ops: 'x0, [x1]' }),
  read: async () => new Promise(() => {}),
});

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('#5594: abort during pending memory I/O rejects run() instead of hanging', async () => {
  const emu = neverSettlingEmulator();
  emu.set('x1', 0x2000n);
  const controller = new AbortController();

  let outcome = 'pending';
  const runPromise = emu.run(10, null, { signal: controller.signal })
    .then(() => { outcome = 'resolved'; })
    .catch((error) => { outcome = `rejected:${error.name || error.constructor.name}`; });

  await settle(25);
  assert.equal(outcome, 'pending', 'never-settling io.read keeps the run pending before abort');
  controller.abort();
  await settle(25);
  assert.match(outcome, /^rejected:AbortError$/, 'abort during memory I/O must reject the consumer promise');
  await runPromise;
});

test('#5594: abort during pending memory I/O rejects a direct step() call', async () => {
  const emu = neverSettlingEmulator();
  emu.set('x1', 0x2000n);
  const controller = new AbortController();

  let outcome = 'pending';
  const stepPromise = emu.step({ signal: controller.signal })
    .then(() => { outcome = 'resolved'; })
    .catch((error) => { outcome = `rejected:${error.name || error.constructor.name}`; });

  await settle(25);
  assert.equal(outcome, 'pending');
  controller.abort();
  await settle(25);
  assert.match(outcome, /^rejected:AbortError$/, 'abort during memory I/O must reject step()');
  await stepPromise;
});

test('#5594: settling memory I/O still completes and loads the value', async () => {
  const page = new Uint8Array(4096);
  page[0] = 0x2a;
  const emu = new Emulator({
    fetch: async (addr) => (addr >= 0x1000n && addr <= 0x1010n ? { mn: 'ldr', ops: 'x0, [x1]' } : null),
    read: async () => page,
  });
  emu.set('x1', 0x2000n);
  emu.set('pc', 0x1000n);
  const result = await emu.run(5);
  assert.equal(emu.get('x0'), 0x2an);
  assert.ok(result.steps >= 1);
  assert.equal(emu.stopped, '5 命令ぶん進んだので、いったん止めました。');
});

test('#5594: direct execute() without a run signal keeps legacy error-to-result behavior', async () => {
  const emu = new Emulator({
    fetch: async () => ({ mn: 'ldr', ops: 'x0, [x1]' }),
    read: async () => new Uint8Array(0), // empty backing -> unmapped-memory fault
  });
  emu.set('x1', 0x2000n);
  const result = await emu.step();
  assert.equal(result.ok, false);
  assert.match(result.reason, /backing memory|読めません|unavailable|outside backed memory/u);
});

test('#5594: cancel-capable read has cancel() invoked on abort', async () => {
  let cancelCalled = false;
  const emu = new Emulator({
    fetch: async () => ({ mn: 'ldr', ops: 'x0, [x1]' }),
    read: () => new Promise(() => {}),
  });
  emu.io.read = () => {
    const promise = new Promise(() => {});
    promise.cancel = () => { cancelCalled = true; };
    return promise;
  };
  emu.set('x1', 0x2000n);
  const controller = new AbortController();
  const outcome = emu.run(10, null, { signal: controller.signal })
    .then(() => 'resolved')
    .catch((error) => `rejected:${error.name || error.constructor.name}`);
  await settle(25);
  controller.abort();
  assert.equal(await outcome, 'rejected:AbortError');
  assert.equal(cancelCalled, true, 'abort must cancel the in-flight backing read');
});

test('#5594: pre-aborted signal rejects before memory I/O starts', async () => {
  let readStarted = false;
  const emu = new Emulator({
    fetch: async () => ({ mn: 'ldr', ops: 'x0, [x1]' }),
    read: async () => { readStarted = true; return new Uint8Array(4096); },
  });
  emu.set('x1', 0x2000n);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(emu.run(10, null, { signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.equal(readStarted, false, 'a pre-aborted run must not start memory I/O');
});

test('#5594: synchronous throw from io.read keeps memory-read-failed taxonomy', async () => {
  const emu = new Emulator({
    fetch: async () => ({ mn: 'ldr', ops: 'x0, [x1]' }),
    read() { throw new Error('sync backing explosion'); },
  });
  emu.set('x1', 0x2000n);
  const result = await emu.step();
  assert.equal(result.ok, false);
  assert.match(result.reason, /backing read failed/);
  assert.equal(result.code, 'memory-read-failed');
  assert.equal(emu.faultCode, 'memory-read-failed');
});

test('#5594: synchronous throw during an aborted run surfaces as AbortError', async () => {
  const emu = new Emulator({
    fetch: async () => ({ mn: 'ldr', ops: 'x0, [x1]' }),
    read() { throw new Error('sync backing explosion'); },
  });
  emu.set('x1', 0x2000n);
  const controller = new AbortController();
  let outcome = 'pending';
  const stepPromise = emu.step({ signal: controller.signal })
    .then(() => { outcome = 'resolved'; })
    .catch((error) => { outcome = `rejected:${error.name || error.constructor.name}`; });
  controller.abort();
  await stepPromise;
  assert.match(outcome, /^rejected:AbortError$/, 'abort must win over the synchronous fault');
});

test('#5594: store path also observes the run signal', async () => {
  const emu = new Emulator({
    fetch: async () => ({ mn: 'str', ops: 'x0, [x1]' }),
    read: async () => new Promise(() => {}),
  });
  emu.set('x0', 1n);
  emu.set('x1', 0x2000n);
  const controller = new AbortController();
  let outcome = 'pending';
  const runPromise = emu.run(10, null, { signal: controller.signal })
    .then(() => { outcome = 'resolved'; })
    .catch((error) => { outcome = `rejected:${error.name || error.constructor.name}`; });
  await settle(25);
  assert.equal(outcome, 'pending');
  controller.abort();
  await settle(25);
  assert.match(outcome, /^rejected:AbortError$/, 'store-side mapping reads must also abort');
  await runPromise;
});

test('#5594: a late read result after abort does not pollute the page cache', async () => {
  let releaseRead;
  const emu = new Emulator({
    fetch: async () => ({ mn: 'ldr', ops: 'x0, [x1]' }),
    read: () => new Promise((resolve) => { releaseRead = resolve; }),
  });
  emu.set('x1', 0x2000n);
  const controller = new AbortController();
  const runPromise = emu.run(10, null, { signal: controller.signal })
    .catch(() => 'rejected');
  await settle(25);
  controller.abort();
  assert.equal(await runPromise, 'rejected');
  // The abandoned read settles late with a page the emulator never approved.
  releaseRead(new Uint8Array(4096).fill(0xab));
  await settle(25);
  assert.equal(emu.loaded.has('0x2000'), false, 'late result must not enter the page cache');
  await assert.rejects(emu.load(0x2000n, 4), (error) => error.code === 'unmapped-memory' || /backing/.test(error.message || ''));
});

// Regression for #4594: RuntimeAnalysisPlatform.traceFunction passes
// { signal } to adapter.launch(), but LocalFunctionSandboxAdapter's launch
// only sampled the signal at setup checkpoints. An abort while a cancelable
// backing operation (io.read during sandbox setup) was still pending left the
// launch promise stuck, so local launch had weaker cancellation semantics
// than the remote adapter. Contract now: the launch signal is propagated into
// the cancelable backing-read paths, launch settles as cancelled at abort
// time, and an aborted launch never publishes sandbox/memoryMap/epoch state.
import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';
import { RuntimeAnalysisPlatform } from '../../../js/runtime/index.js';

const CODE = new Map([
  ['0x1000', { mn: 'mov', ops: 'x0, #1' }],
  ['0x2000', { mn: 'mov', ops: 'x0, #2' }],
]);

function launchSpec(address = 0x1000n) {
  return {
    address,
    objectAsArg0: false,
    watch: [{ address: 0x500000n, size: 8 }],
    memoryMappings: [{ start: 0x500000n, size: 0x1000, kind: 'mapped', permissions: 'rw' }],
  };
}

function blockedReadIo() {
  const state = { reads: 0, fetches: 0, release: null };
  state.started = new Promise((resolve) => { state.readStarted = resolve; });
  state.blocked = new Promise((resolve) => { state.release = resolve; });
  const io = {
    async fetch(addr) {
      state.fetches++;
      return CODE.get(String(addr)) || null;
    },
    async read() {
      state.reads++;
      if (state.reads === 1) {
        state.readStarted();
        await state.blocked;
      }
      return new Uint8Array(4096);
    },
  };
  return { state, io };
}

function settleOutcome(promise, ms = 250) {
  return Promise.race([
    promise.then((value) => ({ resolved: value }), (error) => ({ rejected: error })),
    new Promise((resolve) => setTimeout(() => resolve('PENDING'), ms)),
  ]);
}

test('#4594 pre-aborted signal rejects local launch before any setup work', async () => {
  const { state, io } = blockedReadIo();
  const adapter = new LocalFunctionSandboxAdapter(io);
  const controller = new AbortController();
  controller.abort('cancelled');
  await assert.rejects(() => adapter.launch(launchSpec(), { signal: controller.signal }),
    (error) => error?.code === 'cancelled', 'pre-aborted launch must fail closed');
  assert.equal(state.reads, 0, 'no backing read may start for a pre-aborted launch');
  assert.equal(state.fetches, 0, 'no fetch may start for a pre-aborted launch');
  assert.equal(adapter.sandbox, null);
  assert.equal(adapter.epoch, 0);
});

test('#4594 abort during a pending io.read settles launch as cancelled without waiting for the read', async () => {
  const { state, io } = blockedReadIo();
  const adapter = new LocalFunctionSandboxAdapter(io);
  const controller = new AbortController();
  const launching = adapter.launch(launchSpec(), { signal: controller.signal });
  await state.started;
  controller.abort('cancelled');
  const outcome = await settleOutcome(launching);
  assert.equal(state.reads, 1, 'test precondition: the backing read is still blocked');
  assert.notEqual(outcome, 'PENDING', 'launch must settle when the signal aborts during a pending backing read');
  assert.ok(outcome?.rejected, `launch must reject after abort, got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.rejected.code, 'cancelled');
  state.release();
  await launching.catch(() => {});
  assert.equal(adapter.sandbox, null, 'aborted candidate sandbox must never be published');
  assert.equal(adapter.memoryMap, null, 'aborted candidate memory map must never be published');
  assert.equal(adapter.epoch, 0, 'aborted launch must not advance epoch');
  assert.throws(() => adapter.ensureSandbox());
});

test('#4594 abort listener cleanup is exactly-once', async () => {
  const { state, io } = blockedReadIo();
  const adapter = new LocalFunctionSandboxAdapter(io);
  const listeners = new Set();
  let aborted = false;
  const signal = {
    get aborted() { return aborted; },
    get reason() { return aborted ? 'cancelled' : undefined; },
    addEventListener(_type, fn) { listeners.add(fn); },
    removeEventListener(_type, fn) { listeners.delete(fn); },
  };
  const launching = adapter.launch(launchSpec(), { signal });
  await state.started;
  aborted = true;
  for (const fn of [...listeners]) fn();
  const outcome = await settleOutcome(launching);
  assert.ok(outcome?.rejected, 'launch must reject after the fake signal aborts');
  assert.equal(outcome.rejected.code, 'cancelled');
  assert.equal(listeners.size, 0, `all abort listeners must be removed exactly once (left=${listeners.size})`);
  state.release();
  await launching.catch(() => {});
  assert.equal(listeners.size, 0);
});

test('#4594 normal local launch keeps existing behavior with the signal propagated', async () => {
  const { state, io } = blockedReadIo();
  const adapter = new LocalFunctionSandboxAdapter(io);
  const controller = new AbortController();
  const launching = adapter.launch(launchSpec(), { signal: controller.signal });
  await state.started;
  state.release();
  const result = await launching;
  assert.equal(result.launched, true);
  assert.equal(result.epoch, 1);
  assert.equal(result.address, 0x1000n);
  assert.ok(result.memory, 'memory map snapshot must be returned');
  assert.notEqual(adapter.sandbox, null, 'non-aborted launch must publish the sandbox');
  assert.equal(adapter.epoch, 1);
  assert.equal(state.reads, 1, 'watch snapshot must have consumed exactly one backing read');
  const before = adapter.sandbox.before[0];
  assert.equal(before.address, 0x500000n);
  assert.equal(before.value, 0n);
});

test('#4594 newer-launch / disconnect generation guard (#1673 family) is not regressed', async () => {
  const { state, io } = blockedReadIo();
  const adapter = new LocalFunctionSandboxAdapter(io);
  const staleLaunching = adapter.launch(launchSpec(0x1000n));
  await state.started;
  const winner = await adapter.launch(launchSpec(0x2000n));
  assert.equal(winner.launched, true);
  assert.equal(adapter.epoch, 1);
  state.release();
  const outcome = await staleLaunching.then(() => 'RESOLVED', (error) => error);
  assert.notEqual(outcome, 'RESOLVED', 'a stale launch must not publish after a newer launch');
  assert.equal(outcome?.code, 'stale-launch');
  assert.equal(adapter.epoch, 1, 'the stale launch must not advance epoch over the winner');
  assert.equal(winner.address, 0x2000n);
});

test('#4594 RuntimeAnalysisPlatform local/remote provider cancellation parity', async () => {
  const localIo = blockedReadIo();
  const localAdapter = new LocalFunctionSandboxAdapter(localIo.io);
  const remoteAdapter = {
    id: 'remote-parity',
    kind: 'remote-parity',
    capabilities: { launch: true, resume: true, traceFunction: true },
    async launch(_spec, options = {}) {
      await new Promise((resolve, reject) => {
        const signal = options.signal;
        const onAbort = () => reject(Object.assign(new Error('remote cancelled'), { code: 'cancelled' }));
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
  const platform = new RuntimeAnalysisPlatform({ symbolic: false });
  platform.registerAdapter('local-parity', localAdapter);
  platform.registerAdapter('remote-parity', remoteAdapter);

  await platform.startSession({ adapter: 'local-parity', binaryHash: 'bin-4594-local', connect: false });
  const localController = new AbortController();
  const localTracing = platform.traceFunction(0x1000n, {
    signal: localController.signal,
    objectAsArg0: false,
    watch: [{ address: 0x500000n, size: 8 }],
    memoryMappings: [{ start: 0x500000n, size: 0x1000, kind: 'mapped', permissions: 'rw' }],
  });
  await localIo.state.started;
  localController.abort('cancelled');
  const localOutcome = await settleOutcome(localTracing);
  assert.ok(localOutcome?.rejected, 'platform local trace must settle cancelled while the read is blocked');
  assert.equal(localOutcome.rejected.code, 'cancelled');
  assert.equal(localAdapter.sandbox, null, 'cancelled platform launch must not publish the local sandbox');
  localIo.state.release();
  await localTracing.catch(() => {});

  await platform.startSession({ adapter: 'remote-parity', binaryHash: 'bin-4594-remote', connect: false });
  const remoteController = new AbortController();
  const remoteTracing = platform.traceFunction(0x1000n, { signal: remoteController.signal });
  const remoteOutcome = await settleOutcome(remoteTracing, 10);
  assert.equal(remoteOutcome, 'PENDING', 'the remote launch request is still in flight before abort');
  remoteController.abort('cancelled');
  const remoteSettled = await settleOutcome(remoteTracing);
  assert.ok(remoteSettled?.rejected, 'platform remote trace must settle cancelled at abort');
  assert.equal(remoteSettled.rejected.code, 'cancelled');
});

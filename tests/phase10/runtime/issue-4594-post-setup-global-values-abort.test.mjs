import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';

function blockedReadIo() {
  const state = { reads: 0, release: null, readStarted: null };
  state.started = new Promise((resolve) => { state.readStarted = resolve; });
  state.blocked = new Promise((resolve) => { state.release = resolve; });
  return {
    state,
    io: {
      async read() {
        state.reads++;
        if (state.reads === 1) {
          state.readStarted();
          await state.blocked;
        }
        return new Uint8Array(4096);
      },
    },
  };
}

function settleOutcome(promise, ms = 250) {
  return Promise.race([
    promise.then((value) => ({ resolved: value }), (error) => ({ rejected: error })),
    new Promise((resolve) => setTimeout(() => resolve('PENDING'), ms)),
  ]);
}

test('#4594 abort cancels a post-setup globalValues backing read before it is released', async () => {
  const { state, io } = blockedReadIo();
  const adapter = new LocalFunctionSandboxAdapter(io);
  const controller = new AbortController();
  const launching = adapter.launch({
    address: 0x1000n,
    objectAsArg0: false,
    memoryMappings: [{ start: 0x500000n, size: 0x1000, kind: 'mapped', permissions: 'rw' }],
    globalValues: [{ address: 0x500000n, size: 8, value: 0x1234n }],
  }, { signal: controller.signal });

  // With no setup watch/object/stack initializers, this first read can only be
  // the adapter's post-setup globalValues store pre-read.
  await state.started;
  assert.equal(state.reads, 1);
  controller.abort('cancelled');

  const outcome = await settleOutcome(launching);
  assert.notEqual(outcome, 'PENDING', 'launch must settle at abort, not at backing-read completion');
  assert.ok(outcome?.rejected, `expected cancellation rejection, got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.rejected.code, 'cancelled');
  assert.equal(adapter.sandbox, null, 'aborted launch must not publish the candidate sandbox');
  assert.equal(adapter.memoryMap, null, 'aborted launch must not publish the candidate memory map');
  assert.equal(adapter.epoch, 0, 'aborted launch must not advance epoch');

  state.release();
  await launching.catch(() => {});
  assert.equal(adapter.sandbox, null);
  assert.equal(adapter.memoryMap, null);
  assert.equal(adapter.epoch, 0);
});

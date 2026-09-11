import assert from 'node:assert/strict';

import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';

function makeAdapter({ run } = {}) {
  const adapter = new LocalFunctionSandboxAdapter({});
  const emulator = {
    stopped: null,
    pc: 0n,
    sp: 0n,
    get: () => 0n,
  };
  adapter.sandbox = {
    emulator,
    run: run || (async () => ({ ok:true })),
    step: async () => ({ text:'nop', ok:true, reason:null }),
    state: () => ({ stopped:emulator.stopped }),
  };
  adapter._normalizeResult = (result) => result;
  return adapter;
}

function expectCode(code) {
  return (error) => {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    return true;
  };
}

// #4489: validation must not publish execution ownership or alter a paused
// engine before it has accepted the caller's run options.
for (const options of [
  { maxSteps:0 },
  { maxSteps:1000001 },
  { timeoutMs:9 },
  { timeoutMs:30001 },
]) {
  const adapter = makeAdapter();
  adapter.sandbox.emulator.stopped = 'paused';
  await assert.rejects(adapter.resume(options), expectCode('out-of-range'));
  assert.equal(adapter.activeRun, null, `invalid options must not publish activeRun: ${JSON.stringify(options)}`);
  assert.equal(adapter.running, false);
  assert.equal(adapter.sandbox.emulator.stopped, 'paused', 'validation failure must preserve the terminal engine state');
  await adapter.resume({ maxSteps:1 });
  assert.equal(adapter.activeRun, null, 'a valid resume must remain releasable after validation failure');
}

// The same failed request must not block a step execution.
{
  const adapter = makeAdapter();
  await assert.rejects(adapter.resume({ timeoutMs:9 }), expectCode('out-of-range'));
  const result = await adapter.stepInto();
  assert.equal(result.text, 'nop');
  assert.equal(adapter.activeRun, null);
  assert.equal(adapter.running, false);
}

// Throwing while registering a valid signal is also after ownership publish;
// the cleanup boundary must cover that path, not only sandbox.run().
{
  const adapter = makeAdapter();
  const signal = {
    aborted:false,
    addEventListener() { throw new Error('signal registration failed'); },
    removeEventListener() {},
  };
  await assert.rejects(adapter.resume({ signal, maxSteps:1 }), /signal registration failed/);
  assert.equal(adapter.activeRun, null, 'pre-execution signal failures must release activeRun');
  assert.equal(adapter.running, false);
}

// A genuinely active run still owns the adapter and rejects competing resume
// and step requests with the existing already-running protection.
{
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const adapter = makeAdapter({ run: async () => pending });
  const running = adapter.resume({ maxSteps:1 });
  assert.ok(adapter.activeRun, 'a real execution must publish activeRun');
  await assert.rejects(adapter.resume({ maxSteps:0 }), expectCode('already-running'));
  await assert.rejects(adapter.stepInto(), expectCode('already-running'));
  release({ ok:true });
  await running;
  assert.equal(adapter.activeRun, null, 'completed execution must release activeRun');
  assert.equal(adapter.running, false);
}

console.log('issue-4489: PASS');

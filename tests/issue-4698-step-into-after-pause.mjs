// Issue #4698 regression: LocalFunctionSandboxAdapter.stepInto() must clear
// only the resumable 'paused' stop that pause() sets — the same transition
// resume() performs — so Pause -> Step Into executes exactly one instruction
// instead of returning 0 instructions from Emulator.step()'s stopped guard.
// Terminal stops (return), fault/unsupported stops, and the #4606 maxSteps
// budget stop must NOT be cleared by stepInto().
import assert from 'node:assert/strict';

import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';

function gatedAdapter() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = new LocalFunctionSandboxAdapter({ async fetch() { await gate; return { mn: 'nop', ops: '' }; } });
  return { adapter, release };
}

async function pausedAt(adapter, release) {
  await adapter.launch({ address: 0x1000n });
  const running = adapter.resume({ maxSteps: 10 });
  await adapter.pause();
  release();
  const result = await running;
  assert.equal(result.stop.kind, 'paused', 'pause() during a run must settle as a paused stop');
  assert.equal(adapter.sandbox.emulator.stopped, 'paused');
  return result;
}

// 1. launch -> pause the in-flight run -> stepInto advances PC by one instruction.
{
  const { adapter, release } = gatedAdapter();
  await pausedAt(adapter, release);
  const before = (await adapter.readRegisters()).pc;
  const stepped = await adapter.stepInto();
  const after = (await adapter.readRegisters()).pc;
  assert.equal(stepped.ok, true, 'stepInto after pause must execute the instruction, not return the paused stop');
  assert.equal(after, before + 4n, 'stepInto after pause must advance PC by exactly one instruction');
  assert.equal(after, 0x1008n, 'in-flight step completed at 0x1004, so the step must land on 0x1008');
  assert.equal(adapter.sandbox.emulator.stopped, null, 'the cleared paused marker must not linger after a successful step');
}

// 2. From the paused state consecutive stepInto calls keep working.
{
  const { adapter, release } = gatedAdapter();
  await pausedAt(adapter, release);
  const start = (await adapter.readRegisters()).pc;
  const first = await adapter.stepInto();
  const mid = (await adapter.readRegisters()).pc;
  const second = await adapter.stepInto();
  const end = (await adapter.readRegisters()).pc;
  assert.equal(first.ok, true, 'the first stepInto out of pause must execute');
  assert.equal(second.ok, true, 'the second consecutive stepInto must execute');
  assert.equal(mid, start + 4n, 'each stepInto moves exactly one instruction');
  assert.equal(end, mid + 4n, 'each stepInto moves exactly one instruction');
}

// 3. Non-regression: resume() still clears the paused marker it did before.
{
  const { adapter, release } = gatedAdapter();
  await pausedAt(adapter, release);
  const before = (await adapter.readRegisters()).pc;
  const resumed = await adapter.resume({ maxSteps: 1 });
  const after = (await adapter.readRegisters()).pc;
  assert.equal(after, before + 4n, 'resume() after pause must still execute (existing cleared-on-entry behavior)');
  assert.notEqual(resumed.stop.kind, 'paused', 'the resumed run must not instantly stop as paused again');
}

// 4. A terminal return stop must not be restarted by stepInto().
{
  const adapter = new LocalFunctionSandboxAdapter({ async fetch() { return { mn: 'ret', ops: '' }; } });
  await adapter.launch({ address: 0x1000n });
  const done = await adapter.resume({ maxSteps: 10 });
  assert.equal(done.stop.kind, 'return', 'ret to a null link register must settle as a terminal return');
  const terminal = adapter.sandbox.emulator.stopped;
  const before = (await adapter.readRegisters()).pc;
  const stepped = await adapter.stepInto();
  const after = (await adapter.readRegisters()).pc;
  assert.equal(stepped.ok, false, 'stepInto must not clear a terminal return stop');
  assert.equal(after, before, 'stepInto after a terminal return must not execute instructions');
  assert.equal(adapter.sandbox.emulator.stopped, terminal, 'the terminal return marker must survive stepInto()');
}

// 5. A fault stop must not be cleared by stepInto().
{
  const adapter = new LocalFunctionSandboxAdapter({
    async fetch(address) { return address === 0x1000n ? { mn: 'ldr', ops: 'x0, [x1]' } : { mn: 'nop', ops: '' }; },
    async read() { throw new Error('backend offline'); },
  });
  await adapter.launch({
    address: 0x1000n,
    registers: { x1: 0x5000n },
    memoryMappings: [{ start: 0x5000n, size: 0x1000, kind: 'mapped', permissions: 'r' }],
  });
  const done = await adapter.resume({ maxSteps: 10 });
  assert.equal(done.stop.kind, 'fault', 'a backing-read failure must settle as a fault stop');
  const faultState = adapter.sandbox.emulator.stopped;
  const before = (await adapter.readRegisters()).pc;
  const stepped = await adapter.stepInto();
  const after = (await adapter.readRegisters()).pc;
  assert.equal(stepped.ok, false, 'stepInto must not clear a fault stop');
  assert.equal(stepped.stop.kind, 'fault', 'stepInto must re-report the fault stop, not step past it');
  assert.equal(after, before, 'stepInto after a fault must not execute instructions');
  assert.equal(adapter.sandbox.emulator.stopped, faultState, 'the fault marker must survive stepInto()');
}

// 5b. An unsupported-instruction stop must not be cleared by stepInto().
{
  const adapter = new LocalFunctionSandboxAdapter({ async fetch() { return { mn: 'weirdop', ops: 'x0, x1' }; } });
  await adapter.launch({ address: 0x1000n });
  const done = await adapter.resume({ maxSteps: 10 });
  assert.equal(done.stop.kind, 'unsupported', 'an unknown mnemonic must settle as an unsupported stop');
  const unsupportedState = adapter.sandbox.emulator.stopped;
  const before = (await adapter.readRegisters()).pc;
  const stepped = await adapter.stepInto();
  const after = (await adapter.readRegisters()).pc;
  assert.equal(stepped.ok, false, 'stepInto must not clear an unsupported stop');
  assert.equal(after, before, 'stepInto after an unsupported stop must not execute instructions');
  assert.equal(adapter.sandbox.emulator.stopped, unsupportedState, 'the unsupported marker must survive stepInto()');
}

// 6. The #4606 maxSteps budget stop keeps its own policy: stepInto must not
// adopt the budget-stop clearing either (only the 'paused' marker is resumable).
{
  const adapter = new LocalFunctionSandboxAdapter({ async fetch() { return { mn: 'nop', ops: '' }; } });
  await adapter.launch({ address: 0x1000n });
  const budget = await adapter.resume({ maxSteps: 2 });
  assert.equal(budget.stop.kind, 'timeout', 'a maxSteps budget stop stays classified as timeout (#4606 policy)');
  const budgetState = adapter.sandbox.emulator.stopped;
  const before = (await adapter.readRegisters()).pc;
  const stepped = await adapter.stepInto();
  const after = (await adapter.readRegisters()).pc;
  assert.equal(stepped.ok, false, 'stepInto must not clear the maxSteps budget stop');
  assert.equal(after, before, 'stepInto after a budget stop must not execute instructions');
  assert.equal(adapter.sandbox.emulator.stopped, budgetState, 'the budget-stop marker must survive stepInto()');
}

console.log('issue #4698 stepInto-after-pause regressions: PASS');
